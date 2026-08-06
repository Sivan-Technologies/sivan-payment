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
import { listVerificationLimitOverrides } from '../../kyc/service/verification-limits.service.js';
import { userLimitOverrideFor } from '../../kyc/service/user-limits.service.js';
import { effectiveUsedNgn } from '../../kyc/service/user-limit-usage.js';
import { VOLUME_WINDOW_DAYS } from '../../kyc/types/verification.types.js';
import { applySivanMargin } from './ngn-margin.js';
import { gasEstimateUsd, networkDisplayLabel } from '../network-costs.js';
import type { NgnControlsRecord, NgnProviderName, NgnQuoteInput, NgnQuoteRecord } from '../types/ngn.types.js';


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
 * Gas estimates now live in one place, shared with GET /api/ngn/networks, so
 * the figure the UI shows and the figure the floor is computed from cannot
 * drift apart. See network-costs.ts for why an unknown chain returns undefined
 * instead of a guess.
 */
export { gasEstimateUsd, NETWORK_GAS_USD } from '../network-costs.js';



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
/**
 * Is tier-limit enforcement switched on for this flow?
 *
 * Three independent switches rather than one master off - see
 * NgnControlsRecord. Defaults to TRUE for an unknown flow and for a control
 * row that predates the columns: a control whose job is to refuse must refuse
 * when nobody has said otherwise.
 */
function limitEnforcementEnabled(controls: NgnControlsRecord, flow: 'onramp' | 'offramp'): boolean {
  if (flow === 'onramp') return controls.limitEnforcementOnramp ?? true;
  return controls.limitEnforcementOfframp ?? true;
}

async function requireSivanVerified(userId: string, input: NgnQuoteInput, providerName: NgnProviderName, controls: NgnControlsRecord) {
  const state = await getVerificationState(userId);
  const flow: 'onramp' | 'offramp' = input.direction === 'onramp' ? 'onramp' : 'offramp';

  /**
   * THE SWITCH IS READ HERE, AT THE ONE PLACE THAT REFUSES.
   *
   * Not in the route, and not in the UI. A limit that is skipped anywhere
   * other than the single enforcement point is a limit with two definitions,
   * and the softer one always wins. Everything above still runs - state,
   * overrides, the naira-leg calculation - so /verification-summary keeps
   * reporting the true consumed figure while enforcement is off. Turning it
   * back on therefore takes effect immediately, with no gap in the numbers.
   */
  if (!limitEnforcementEnabled(controls, flow)) {
    await createAuditLog({
      actorType: 'system',
      action: 'ngn.limit_enforcement_skipped',
      resourceType: 'payments_ngn_quote',
      resourceId: userId,
      // Warning, not info: a quote that bypassed the compliance ceiling is
      // the first thing anyone will look for afterwards.
      severity: 'warning',
      metadata: { flow, rail: 'ngn', userId, sourceAmount: input.sourceAmount, sourceCurrency: input.sourceCurrency },
    }).catch(() => undefined);
    return { allowed: true as const, reason: 'limit enforcement disabled for this flow' };
  }

  /**
   * THE CEILINGS AN ADMIN HAS ACTUALLY SET, not just the compiled defaults.
   *
   * This call previously passed NEITHER override argument to decide(), so it
   * enforced FLOW_LIMITS as shipped. Two consequences, both real: an admin
   * raising a tier ceiling in the console changed /verification-summary (which
   * does load them) but not the quote that enforces it, so the dashboard and
   * the block disagreed; and a per-user exception would have been purely
   * decorative here.
   *
   * priorVolumeNgn now respects any admin reset for the same reason - a
   * forgiven window has to be forgiven at the point of enforcement, or the
   * reset only changes what the user is TOLD they have left.
   */
  const [tierOverrides, userOverride, priorVolumeNgn] = await Promise.all([
    listVerificationLimitOverrides(),
    userLimitOverrideFor(userId, flow, 'ngn'),
    effectiveUsedNgn(userId, flow, 'ngn'),
  ]);

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

  const decision = decide(
    state,
    { flow, rail: 'ngn', amountNgn, priorVolumeNgn },
    tierOverrides,
    userOverride
  );

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
  await requireSivanVerified(input.userId, input, controls.activeProvider, controls);

  // A Bridge customer is looked up only when the flow actually needs one. NGN
  // rails do not, so a user with no Bridge customer - which under this model is
  // most users - is no longer blocked, and no $2 is spent to let naira move.
  const customer = requiresBridgeCustomer('ngn')
    ? await getCustomerByUserId(input.userId)
    : await getCustomerByUserId(input.userId).catch(() => undefined);

  const provider = getNgnProvider(controls.activeProvider);
  // input.network is forwarded so the provider prices - and stamps the assetId
  // for - the chain the user actually picked.
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

  /**
   * NO FEE ESTIMATE MEANS NO QUOTE. IT USED TO MEAN A GUESS OF $0.50.
   *
   * This figure is not decorative - it is added to Breet's minimum to produce
   * the floor that decides whether a withdrawal can clear. The enabled network
   * list is admin-configurable at runtime while the fee table ships with the
   * build, so the two CAN disagree, and the old `?? 0.5` fallback resolved that
   * disagreement by inventing a number.
   *
   * On a chain dearer than the guess that understates the floor, the user is
   * told a too-small amount will clear, and the failure lands after the money
   * has moved: funds held by the provider, uncredited, flag fee charged.
   *
   * Refusing is the safe direction. An admin who enables a chain without adding
   * its fee gets a clear refusal on the very first quote instead of a slow leak
   * of stuck withdrawals.
   */
  const estimatedGasUsd = gasEstimateUsd(quoteNetwork);
  if (estimatedGasUsd === undefined) {
    throw badRequest(
      `${networkDisplayLabel(quoteNetwork)} is not available for this right now. Please choose another network.`
    );
  }


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
    /**
     * By family, not by literal chain name. An exact match on 'ethereum'
     * misses the chain:'base' rows this deployment actually creates, and the
     * on-ramp quote would then carry NO recipient address - so the naira a
     * user paid in would have nowhere documented to land.
     */
    const wallet = await db.findUserWalletForNetwork(input.userId, quoteNetwork);
    recipientAddress = wallet?.address;
  }

  /**
   * THE USER'S OWN BANK, CARRIED SO THE PAYOUT CAN BE AUTOMATIC.
   *
   * breet.provider.ts only sets `autoSettlement: true` on the deposit address
   * when it can see a bankId AND an accountNumber:
   *
   *     if (bankId && accountNumber) { body.autoSettlement = true; }
   *
   * It read those from quote.metadata, and NOTHING EVER PUT THEM THERE. The
   * env fallbacks (BREET_DEFAULT_BANK_ID / _ACCOUNT_NUMBER) were empty too, so
   * autoSettlement was never enabled on any address we have ever generated.
   *
   * The consequence is quiet and expensive: the user's crypto arrives, Breet
   * converts it to naira, and the money STOPS in Sivan's Breet balance instead
   * of reaching their bank. Nothing errors. The transfer just never settles.
   *
   * Taken from the user's VERIFIED payout account, never from configuration.
   * A global default would pay every user's naira into one bank account, which
   * is the worst possible bug in this file - so this deliberately does not
   * fall back to BREET_DEFAULT_*, even though the provider still accepts them
   * for single-tenant setups.
   *
   * Only `verified` accounts qualify. A pending_review NUBAN is one a human
   * was asked to look at; auto-paying it would defeat the review queue.
   */
  let payoutBank: { bankId: string; accountNumber: string; bankName?: string } | undefined;
  if (input.direction === 'offramp' && input.destinationCurrency === 'ngn') {
    const accounts = await db.listNgnPayoutAccounts(input.userId);
    const verified = accounts.find((account) => account.status === 'verified');
    if (verified) {
      payoutBank = {
        bankId: verified.bankId,
        accountNumber: verified.accountNumber,
        bankName: verified.bankName,
      };
    }
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
    // Present only for NGN off-ramps, and only when the user has a VERIFIED
    // payout account. This is what turns autoSettlement on.
    ...(payoutBank ?? {}),
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
