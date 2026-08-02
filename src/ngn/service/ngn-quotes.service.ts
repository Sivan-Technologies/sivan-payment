import { z } from 'zod';
import { db } from '../../database/json-database.js';
import { getCustomerByUserId } from '../../customers/customers.service.js';
import { badRequest, forbidden, notFound } from '../../shared/errors.js';
import { id, nowIso } from '../../shared/id.js';
import { createAuditLog } from '../../audit/audit.service.js';
import { env } from '../../config/env.js';
import { getNgnProvider } from '../provider/ngn-provider-registry.js';
import { getNgnControls } from './ngn-controls.service.js';
import { decide, requiresBridgeCustomer } from '../../kyc/service/verification-policy.js';
import { getVerificationState, getCumulativeNgnVolume } from '../../kyc/service/verification-state.js';
import { VOLUME_WINDOW_DAYS } from '../../kyc/types/verification.types.js';
import { applySivanMargin } from './ngn-margin.js';
import type { NgnProviderName, NgnQuoteInput, NgnQuoteRecord } from '../types/ngn.types.js';

export const createNgnQuoteSchema = z.object({
  userId: z.string().min(1),
  direction: z.enum(['onramp', 'offramp']),
  sourceCurrency: z.enum(['ngn', 'usdc', 'usdt']),
  destinationCurrency: z.enum(['ngn', 'usdc', 'usdt']),
  sourceAmount: z.string().min(1),
  /**
   * Which chain the crypto leg moves on.
   *
   * The quote had no network field at all, which made the gas estimate
   * unknowable - breet.provider.ts reads metadata.estimatedGasUsd and was
   * always finding nothing, so the minimum-withdrawal guard ran with gas = 0.
   * That is the exact input the buffer exists to account for.
   *
   * Optional with a default so existing callers keep working; the default
   * matches BREET_DEFAULT_NETWORK.
   */
  network: z.string().optional()
});

/**
 * Typical gas per network, in USD.
 *
 * Estimates for QUOTING only - the real figure is settled by the wallet
 * provider at signing time. They exist so the minimum-withdrawal floor
 * accounts for gas rather than assuming zero, and so a user sees why Base
 * costs less than Ethereum before choosing.
 *
 * Ethereum is deliberately included despite being poor value: $2-10 against a
 * $15 minimum is 13-66% of a small withdrawal, and showing the number is how a
 * user understands the default.
 */
const TYPICAL_GAS_USD: Record<string, number> = {
  solana: 0.001,
  base: 0.02,
  ethereum: 5,
  arbitrum: 0.05,
  polygon: 0.01,
};

export function typicalGasUsd(network: string): number {
  return TYPICAL_GAS_USD[String(network).toLowerCase()] ?? 0.5;
}


/**
 * Sivan's verification decides. Providers inherit.
 *
 * This replaced a gate that required a Bridge customer with kycStatus
 * 'kyc_approved' before ANY naira transfer - including NGN 1,000 between two
 * Nigerian bank accounts that Bridge plays no part in. Bridge charges $2 per
 * KYC, so that gate spent $2 of real money to authorise transactions Bridge
 * never saw, and blocked every user who had not paid it.
 *
 * Naira never reaches Bridge, so Bridge must not gate naira. What gates it is
 * Sivan's own verification level against a cumulative volume ceiling.
 */
async function requireSivanVerified(userId: string, input: NgnQuoteInput, providerName: NgnProviderName) {
  const state = await getVerificationState(userId);
  const priorVolumeNgn = await getCumulativeNgnVolume(userId, VOLUME_WINDOW_DAYS);

  // The naira leg is what an NGN threshold measures, and which leg that is
  // depends on direction: on-ramp sends NGN, off-ramp receives it.
  //
  // Getting this wrong is not cosmetic. An off-ramp quotes USDC as its source,
  // so reading sourceAmount here would put a stablecoin figure - or worse, a
  // placeholder - against a naira ceiling, and the off-ramp limit would never
  // bind. Caught by test: a NGN 80,000 off-ramp passed a NGN 50,000 ceiling.
  //
  // The naira side of an off-ramp is not known until the provider quotes, so
  // it is estimated from the live rate first and re-checked afterwards.
  let amountNgn = 0;
  if (input.sourceCurrency === 'ngn') {
    amountNgn = Number(input.sourceAmount);
  } else {
    const preview = await getNgnProvider(providerName).createQuote({ ...input, customerId: undefined });
    amountNgn = Number(preview.destinationAmount);
  }

  if (!Number.isFinite(amountNgn) || amountNgn <= 0) {
    throw forbidden('We could not price that amount. Please try again.');
  }

  const decision = decide(state, {
    flow: input.direction === 'onramp' ? 'onramp' : 'offramp',
    rail: 'ngn',
    amountNgn,
    priorVolumeNgn,
  });

  if (!decision.allowed) throw forbidden(decision.reason);
  return decision;
}

function validateCurrencyPair(input: NgnQuoteInput) {
  if (input.direction === 'onramp' && (input.sourceCurrency !== 'ngn' || !['usdc', 'usdt'].includes(input.destinationCurrency))) throw badRequest('NGN on-ramp must quote NGN to USDC/USDT.');
  if (input.direction === 'offramp' && (!['usdc', 'usdt'].includes(input.sourceCurrency) || input.destinationCurrency !== 'ngn')) throw badRequest('NGN off-ramp must quote USDC/USDT to NGN.');
  const amount = Number(input.sourceAmount);
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest('Invalid source amount.');
}

export async function createNgnQuote(input: z.infer<typeof createNgnQuoteSchema>) {
  validateCurrencyPair(input);
  const controls = await getNgnControls();
  if (input.direction === 'onramp' && !controls.onrampEnabled) throw forbidden('NGN on-ramp is currently disabled.');
  if (input.direction === 'offramp' && !controls.offrampEnabled) throw forbidden('NGN off-ramp is currently disabled.');
  if (Number(input.sourceAmount) > Number(controls.maxTransactionNgn) && input.sourceCurrency === 'ngn') throw forbidden('NGN amount exceeds current transaction limit.');
  await requireSivanVerified(input.userId, input, controls.activeProvider);

  // A Bridge customer is looked up only when the flow actually needs one. NGN
  // rails do not, so a user with no Bridge customer - which under this model is
  // most users - is no longer blocked, and no $2 is spent to let naira move.
  const customer = requiresBridgeCustomer('ngn')
    ? await getCustomerByUserId(input.userId)
    : await getCustomerByUserId(input.userId).catch(() => undefined);

  const provider = getNgnProvider(controls.activeProvider);
  const quote = await provider.createQuote({ ...input, customerId: customer?.id });

  // The provider quote carries the PROVIDER's fee only. Sivan's margin is added
  // here, on top. Without this the NGN path ran at cost: Breet took 0.5%, Sivan
  // took nothing, on every naira transaction.
  //
  // Margin is charged on the GROSS, not on what is left after the provider's
  // cut - otherwise a provider raising its rate would quietly shrink Sivan's
  // revenue, which is the opposite of what a margin is for.
  const grossForMargin = Number(quote.sourceAmount);
  const margin = await applySivanMargin({
    direction: input.direction,
    grossAmount: grossForMargin,
    providerFeeAmount: Number(quote.feeAmount ?? 0),
  });

  // The user receives less by exactly Sivan's margin. Recomputed rather than
  // re-quoted so the number shown is the number charged.
  const providerDestination = Number(quote.destinationAmount);
  const rate = Number(quote.rate) || 0;
  const destinationAfterMargin =
    input.direction === 'onramp'
      ? Math.max(providerDestination - (rate > 0 ? margin.sivanMargin / rate : 0), 0)
      : Math.max(providerDestination - margin.sivanMargin, 0);

  // Resolved once so the stored quote and the gas estimate cannot disagree.
  const quoteNetwork = String(input.network ?? env.BREET_DEFAULT_NETWORK ?? 'solana').toLowerCase();
  const estimatedGasUsd = typicalGasUsd(quoteNetwork);

  /**
   * WHERE THE BOUGHT CRYPTO IS SENT. THE ON-RAMP HAD NOWHERE TO SEND IT.
   *
   * createOnrampTransfer() reads metadata.recipientAddress and refuses with
   * "No destination wallet address for the Breet on-ramp." when it is absent.
   * Nothing in the product ever set it: the field appeared in no schema, no
   * route and no frontend call. Only BREET_DEFAULT_RECIPIENT_ADDRESS could
   * satisfy it, and that is a single shared address - it is EMPTY on test, and
   * setting it in production would send every user's purchase to the same
   * wallet. So the on-ramp was unreachable for everybody, which is what
   * walking the flow end to end exposed.
   *
   * Taken from the user's OWN wallet on the quoted chain, server-side. It is
   * deliberately NOT accepted from the client: a caller who could name the
   * destination could have someone else's purchased crypto delivered to their
   * own address.
   *
   * Solana settles on a Solana wallet; base and ethereum share the EVM wallet,
   * which is how the wallet fleet is provisioned (see walletsToProvision).
   */
  /**
   * QUOTING MUST NOT REQUIRE A WALLET; ACCEPTING MUST.
   *
   * A first draft threw here when the user had no wallet yet. That broke four
   * assertions in test:kyc-ngn-gate, and they were right to break: a quote is
   * a PRICE. Refusing to show someone what naira buys until they have
   * provisioned a wallet inverts the order a person actually shops in, and it
   * conflated "you are not verified enough" - which this endpoint does police
   * - with "you have not set up a destination yet", which it should not.
   *
   * So the address is attached when it exists and simply omitted when it does
   * not. The refusal lives at acceptance, in acceptNgnQuote, where the money
   * is about to move and a destination is genuinely mandatory.
   */
  let recipientAddress: string | undefined;
  if (input.direction === 'onramp') {
    const walletChain = quoteNetwork === 'solana' ? 'solana' : 'ethereum';
    const wallet = await db.findUserWallet(input.userId, walletChain as any);
    recipientAddress = wallet?.address;
  }

  const now = nowIso();
  const record: NgnQuoteRecord = { id: id('ngnq'), userId: input.userId, customerId: customer?.id, direction: input.direction, provider: quote.provider, sourceCurrency: input.sourceCurrency, destinationCurrency: input.destinationCurrency, sourceAmount: quote.sourceAmount, destinationAmount: destinationAfterMargin.toFixed(input.destinationCurrency === 'ngn' ? 2 : 6), rate: quote.rate, feeAmount: String(margin.totalFee), status: 'quote_created', providerQuoteId: quote.providerQuoteId, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), metadata: {
    ...(typeof quote.metadata === 'object' && quote.metadata ? quote.metadata : {}),
    // Kept separate on purpose. One blended number makes it impossible to tell
    // a provider price rise from Sivan earning more, and a support agent cannot
    // explain a fee they cannot break down.
    // Carried so acceptance can reproduce the same floor the user was shown.
    // Without these, breet.provider.ts computed the minimum with gas = 0.
    network: quoteNetwork,
    estimatedGasUsd,
    // Present only for on-ramps; an off-ramp has no destination wallet.
    ...(recipientAddress ? { recipientAddress } : {}),
    fees: {
      providerFee: margin.providerFee,
      providerName: quote.provider,
      sivanMargin: margin.sivanMargin,
      totalFee: margin.totalFee,
      effectivePercent: margin.effectivePercent,
      appliedRule: margin.appliedRule,
      explanation: margin.explanation,
    },
  }, createdAt: now, updatedAt: now };
  await db.upsertNgnQuoteRecord(record);
  await createAuditLog({ actorType: 'user', actorId: input.userId, action: 'ngn.quote_created', resourceType: 'payments_ngn_quote', resourceId: record.id, metadata: { direction: record.direction, provider: record.provider } });
  return record;
}

export async function getNgnQuote(quoteId: string) {
  const quote = (await db.listNgnQuotes()).find((item) => item.id === quoteId);
  if (!quote) throw notFound('NGN quote');
  return quote;
}

export async function listNgnQuotes(options: { userId?: string } = {}) {
  return (await db.listNgnQuotes()).filter((item) => !options.userId || item.userId === options.userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function markQuoteAccepted(quote: NgnQuoteRecord) {
  const now = nowIso();
  const accepted: NgnQuoteRecord = { ...quote, status: 'quote_accepted', updatedAt: now };
  await db.upsertNgnQuoteRecord(accepted);
  return accepted;
}
