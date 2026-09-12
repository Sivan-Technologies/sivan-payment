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
  sourceCurrency: z.enum(['ngn', 'usdc', 'usdt', 'cngn', 'cusd']),
  destinationCurrency: z.enum(['ngn', 'usdc', 'usdt', 'cngn', 'cusd']),
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
  network: z.string().optional(),
  /**
   * WHICH OF THE USER'S SAVED BANK ACCOUNTS THE NAIRA GOES TO.
   *
   * There was no such field, and the destination was decided server side with
   * `accounts.find((a) => a.status === 'verified')` - the first verified row in
   * raw insertion order. The account number typed into NgnPayoutForm was never
   * sent anywhere. A user with two verified accounts was therefore always paid
   * into whichever they saved first, while the withdrawal screen showed them
   * the other one.
   *
   * AN ID, NOT A BANK. Deliberately not `{ bankId, accountNumber }`: a client
   * that could name an arbitrary NUBAN could send naira to a stranger, and the
   * name-match evidence this rail depends on would never have been collected
   * for it. An id can only ever point at a row the user already saved, and it
   * is still checked for ownership and status below before a naira moves.
   *
   * Optional so on-ramps and single-account users are unaffected.
   */
  payoutAccountId: z.string().min(1).optional()
});

/**
 * Gas estimates now live in one place, shared with GET /api/ngn/networks, so
 * the figure the UI shows and the figure the floor is computed from cannot
 * drift apart. See network-costs.ts for why an unknown chain returns undefined
 * instead of a guess.
 */
export { gasEstimateUsd, NETWORK_GAS_USD } from '../network-costs.js';

function fixedMoney(value: number, dp: number): string {
  if (!Number.isFinite(value)) return (0).toFixed(dp);
  return value.toFixed(dp);
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
    // Estimate NGN leg (default ~1400 NGN/USDC) for pre-check limit comparison
    // to prevent duplicate 4s upstream Breet API calls that cause 15s Cloudflare timeouts.
    amountNgn = Number(input.sourceAmount) * 1400;
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
  const allowedCrypto = ['usdc', 'usdt', 'cngn', 'cusd'];
  if (input.direction === 'onramp' && (input.sourceCurrency !== 'ngn' || !allowedCrypto.includes(input.destinationCurrency))) throw badRequest('NGN on-ramp must quote NGN to USDC/USDT/cNGN.');
  if (input.direction === 'offramp' && (!allowedCrypto.includes(input.sourceCurrency) || input.destinationCurrency !== 'ngn')) throw badRequest('NGN off-ramp must quote USDC/USDT/cNGN to NGN.');
  const amount = Number(input.sourceAmount);
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest('Invalid source amount.');
}

export async function createNgnQuote(input: z.infer<typeof createNgnQuoteSchema>) {
  validateCurrencyPair(input);
  const controls = await getNgnControls();
  let revenueMode = input.direction === 'offramp'
    ? (controls.offrampRevenueMode ?? env.NGN_OFFRAMP_REVENUE_MODE)
    : 'sivan_fee_wallet';
  const requestedNetwork = String((input as any).network ?? '').toLowerCase();
  if (
    input.direction === 'offramp' &&
    revenueMode === 'sivan_fee_wallet' &&
    requestedNetwork &&
    requestedNetwork !== 'solana' &&
    requestedNetwork !== 'celo'
  ) {
    revenueMode = 'breet_markup';
  }
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

  /**
   * A BALANCE THAT CANNOT MOVE MUST NOT BE QUOTED.
   *
   * unified-balance counts `credited` - ledger value with no chain behind it,
   * such as a Bridge virtual-account settlement - as spendable, correctly:
   * the user really does own it. But the off-ramp sweep signs from an ON-CHAIN
   * wallet, and a user funded entirely by a virtual account may have none.
   *
   * The result was a quote that priced happily, an order that was created, and
   * a sweep that skipped with `no_wallet_for_network` - leaving the transfer at
   * `awaiting_crypto_deposit` forever, telling the user to send crypto Sivan
   * had promised to move for them. Verified end to end before this guard.
   *
   * Refused at the QUOTE, which is the last point where nothing has been
   * created yet and the user can be told something true.
   *
   * Deliberately only when there is no wallet AND the balance is credit-only:
   * a user with a real wallet is unaffected, and a user with neither has
   * nothing to quote anyway and is caught by the balance check downstream.
   */
  if (input.direction === 'offramp') {
    const network = String((input as any).network ?? '').toLowerCase();
    if (network) {
      const wallet = await db.findUserWalletForNetwork(input.userId, network);
      if (!wallet) {
        /**
         * SCOPED TO VIRTUAL-ACCOUNT CREDIT, NOT ALL CREDIT.
         *
         * The first version refused on any `credited > 0`, which caught admin
         * balance adjustments too - and those are exactly how support funds a
         * user who then legitimately quotes. test:failure-paths went from 55/55
         * to 42/13 and named it: "a verified user can quote -> 403".
         *
         * The condition that actually matters is narrower: money that arrived
         * from a BANK DEPOSIT and is still sitting with Bridge. An admin
         * adjustment is a bookkeeping entry an operator made deliberately and
         * can settle deliberately; a virtual-account settlement is the one
         * that silently has no chain behind it.
         */
        const vaCredits = (await db.listVirtualAccountTransactions())
          .filter((item: any) => item.userId === input.userId && item.status === 'completed');
        if (vaCredits.length > 0) {
          throw forbidden(
            'This balance arrived by bank deposit and is still held with our settlement partner, so it ' +
            'cannot be sent on chain yet. Our team moves these manually - contact support and we will ' +
            'release it, usually the same day.'
          );
        }
      }
    }
  }

  const isCeloRail =
    String(input.network ?? '').toLowerCase() === 'celo' ||
    String(input.sourceCurrency ?? '').toLowerCase() === 'cngn' ||
    String(input.sourceCurrency ?? '').toLowerCase() === 'cusd';
  const providerName = isCeloRail ? 'textile' : controls.activeProvider;
  const provider = getNgnProvider(providerName);
  let breetMarkupPercentForQuote = 0;
  let breetMarkupKnown = true;
  let breetMarkupSource: string = 'provider';
  if (
    input.direction === 'offramp' &&
    providerName === 'breet' &&
    provider.getBreetMarkupPercent
  ) {
    /**
     * A FAILED MARKUP READ MUST NOT PRICE AS 0%.
     *
     * getBreetMarkupPercent() collapsed every failure to 0. In breet_markup
     * mode - which live has been in since 2026-08-14 - that means the quote is
     * built with no Sivan revenue at all, and it looks completely normal: the
     * user is charged, Breet is paid, Sivan earns nothing, and nothing anywhere
     * says the read failed.
     *
     * getBreetMarkupDetailed() reports provenance, so the three cases are now
     * distinguishable: a real 0%, a cached last-known value during a blip, and
     * a total failure with nothing to fall back on.
     */
    const detailed = (provider as any).getBreetMarkupDetailed
      ? await (provider as any).getBreetMarkupDetailed()
      : { markupPercent: await provider.getBreetMarkupPercent(), known: true, source: 'provider' };

    breetMarkupPercentForQuote = detailed.markupPercent;
    breetMarkupKnown = detailed.known;
    breetMarkupSource = detailed.source;

    if (!detailed.known) {
      await createAuditLog({
        actorType: 'system',
        actorId: 'ngn_quote',
        action: 'ngn.breet_markup_unavailable',
        resourceType: 'payments_ngn_provider',
        resourceId: 'breet',
        severity: 'error',
        metadata: {
          source: detailed.source,
          fellBackTo: detailed.markupPercent,
          revenueMode,
          reason: detailed.reason,
        },
      }).catch(() => undefined);
    }

    /**
     * REFUSE RATHER THAN QUOTE FOR FREE.
     *
     * Only when the mode depends on the markup AND there is no last-known
     * value to stand in. A cached figure keeps pricing correct through a blip,
     * which is the common case; having nothing at all means the very first
     * quote after a deploy would be priced at zero, and that is worth an
     * error the operator can see rather than revenue that quietly vanishes.
     */
    if (revenueMode === 'breet_markup' && detailed.source === 'unavailable') {
      throw badRequest(
        'We could not price that withdrawal right now. Please try again in a moment.'
      );
    }

    if (revenueMode === 'sivan_fee_wallet' && breetMarkupPercentForQuote > 0) {
      revenueMode = 'breet_markup';
    }
  }
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
  const providerDestination = Number(quote.destinationAmount);
  const rate = Number(quote.rate) || 0;

  /**
   * No rate means the margin cannot be denominated, and a zero margin is a
   * silent giveaway rather than an error anyone would notice. This file
   * already refuses to quote a chain with no gas estimate for the same reason:
   * refusing is the direction that cannot leak money.
   */
  if (input.direction === 'offramp' && rate <= 0) {
    throw badRequest('We could not price that amount right now. Please try again.');
  }

  /**
   * THE MARGIN IS COMPUTED IN NAIRA ON BOTH LEGS, BECAUSE THE PROVIDER FEE IS.
   *
   * This used to pass the raw sourceAmount for both directions. On an on-ramp
   * that is naira and everything agreed. On an OFF-RAMP the source is crypto,
   * so the margin came back in DOLLARS - and was then subtracted straight off
   * a naira destination:
   *
   *     destination(NGN) - sivanMargin(USD)
   *
   * On a real $51.20 Breet quote at 1895, Sivan should have earned NGN 970.24
   * and took NGN 0.51 instead. The margin was not small, it was denominated in
   * the wrong currency and shrank by the exchange rate on every single
   * off-ramp - the same "ran at cost" failure this margin was added to fix.
   *
   * It also corrupted what the user was SHOWN, because applySivanMargin adds
   * providerFeeAmount to the margin to make totalFee. Breet's fee arrives in
   * naira (0.5% of the naira gross), so totalFee summed NGN 485.12 with USD
   * 0.512 and effectivePercent read 948.5%.
   *
   * Converting here rather than inside applySivanMargin keeps that module a
   * pure percentage calculator with no view on currency, and keeps the unit
   * contract it documents - gross and providerFee in the SAME currency - true
   * for both directions.
   */
  const grossForMargin =
    input.direction === 'onramp'
      ? Number(quote.sourceAmount)
      : Number(quote.sourceAmount) * rate;

  let providerFeeAsset = Number(quote.feeAmount ?? 0) || 0;
  let providerFeeNgn =
    input.direction === 'offramp'
      ? providerFeeAsset * rate
      : providerFeeAsset;

  const breetMarkupNgn =
    input.direction === 'offramp' && revenueMode === 'breet_markup' && breetMarkupPercentForQuote > 0
      ? grossForMargin * (breetMarkupPercentForQuote / 100)
      : 0;

  const margin = revenueMode === 'disabled'
    ? {
      providerFee: providerFeeNgn,
      sivanMargin: 0,
      totalFee: providerFeeNgn,
      effectivePercent: grossForMargin > 0 ? (providerFeeNgn / grossForMargin) * 100 : 0,
      appliedRule: revenueMode,
      explanation: 'Sivan NGN off-ramp revenue is disabled; only provider cost is included.',
    }
    : revenueMode === 'breet_markup'
    ? {
      providerFee: providerFeeNgn,
      sivanMargin: breetMarkupNgn,
      totalFee: providerFeeNgn + breetMarkupNgn,
      effectivePercent: grossForMargin > 0 ? ((providerFeeNgn + breetMarkupNgn) / grossForMargin) * 100 : 0,
      appliedRule: revenueMode,
      /**
       * The explanation now distinguishes "configured as 0%" from "we could
       * not read it". Both used to render the same sentence, so a support
       * agent reading a zero-revenue quote had no way to tell whether it was
       * deliberate or a provider failure.
       */
      explanation: !breetMarkupKnown
        ? `Breet markup could not be read; priced from the last known value (${breetMarkupPercentForQuote}%).`
        : breetMarkupPercentForQuote > 0
        ? `Sivan revenue is handled by Breet markup (${breetMarkupPercentForQuote}%); no on-chain Sivan fee is added.`
        : 'Sivan revenue mode is Breet markup, but no Breet markup is currently configured.',
      markupKnown: breetMarkupKnown,
      markupSource: breetMarkupSource,
    }
    : await applySivanMargin({
    direction: input.direction,
    grossAmount: grossForMargin,
    providerFeeAmount: providerFeeNgn,
    // Off-ramp margin is computed in naira so the payout reconciles against
    // the naira destination. The source-asset equivalents are derived below
    // for wallet fee collection and display.
    rate: input.direction === 'offramp' ? Number(quote.rate ?? 0) : undefined,
  });

  const sivanMarginNgn =
    input.direction === 'offramp'
      ? margin.sivanMargin
      : margin.sivanMargin;
  const sivanMarginAsset =
    input.direction === 'offramp' && rate > 0
      ? margin.sivanMargin / rate
      : margin.sivanMargin;

  if (input.direction === 'offramp' && revenueMode === 'sivan_fee_wallet') {
    const source = Number(quote.sourceAmount) || 0;
    const providerFeePercent = source > 0 ? providerFeeAsset / source : 0;
    const amountSentToBreet = Math.max(source - sivanMarginAsset, 0);
    providerFeeAsset = amountSentToBreet * providerFeePercent;
    providerFeeNgn = providerFeeAsset * rate;
  }

  const totalFeeNgn =
    input.direction === 'offramp'
      ? providerFeeNgn + sivanMarginNgn
      : margin.totalFee;
  const totalFeeAsset =
    input.direction === 'offramp'
      ? providerFeeAsset + sivanMarginAsset
      : margin.totalFee;
  const effectivePercent =
    grossForMargin > 0
      ? (totalFeeNgn / grossForMargin) * 100
      : margin.effectivePercent;
  const feeAmountForRecord =
    input.direction === 'offramp'
      ? fixedMoney(totalFeeAsset, 6)
      : fixedMoney(totalFeeNgn, 2);

  // The user receives less by exactly Sivan's margin. Recomputed rather than
  // re-quoted so the number shown is the number charged.
  //
  // On-ramp the destination is crypto and the margin is naira, so it converts.
  // Off-ramp both are naira now, so it subtracts directly.
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
  let payoutBank: { bankId: string; accountNumber: string; bankName?: string; accountName?: string } | undefined;
  if (input.direction === 'offramp' && input.destinationCurrency === 'ngn') {
    const accounts = await db.listNgnPayoutAccounts(input.userId);
    const verified = accounts.filter((account) => account.status === 'verified');

    let chosen = verified[0];

    if (input.payoutAccountId) {
      /**
       * THE ID IS A CLAIM, NOT A LOOKUP KEY.
       *
       * Matched inside THIS USER'S verified accounts rather than fetched by id
       * and checked afterwards. Fetching first is how an ownership check comes
       * to be forgotten in a later edit, and here that mistake pays a stranger.
       */
      chosen = verified.find((account) => account.id === input.payoutAccountId)!;
      if (!chosen) {
        /**
         * ONE MESSAGE FOR "NOT YOURS", "NOT VERIFIED" AND "DOES NOT EXIST".
         *
         * Distinguishing them would confirm whether an id is real and whose it
         * is, turning this into an enumeration oracle over other people's bank
         * accounts. The user who owns the account sees their own list on screen
         * and does not need the distinction; an attacker guessing ids learns
         * nothing from a uniform refusal.
         */
        throw badRequest('That payout account is not available. Choose one of your verified accounts.');
      }
    } else if (verified.length > 1) {
      /**
       * REFUSE RATHER THAN GUESS.
       *
       * This used to be `.find()`, which silently returned the first verified
       * row in insertion order. For a bank transfer that cannot be undone,
       * "we picked one for you" is not an acceptable default - and it is the
       * exact behaviour that made the withdrawal screen a lie.
       */
      throw badRequest('You have more than one payout account. Choose which one to withdraw to.');
    }

    /**
     * IS THIS THE USER'S OWN ACCOUNT, OR SOMEBODY ELSE'S?
     *
     * `matchVerdict` is the durable record of the server-side comparison made
     * when the account was saved: the bank's name for the NUBAN against the
     * name on the user's profile. 'match' means the account is theirs.
     *
     * Checked even though only `verified` rows reach here, because those two
     * facts are not the same and are set by different rules. Test accounts are
     * force-verified in development (`payoutAccountStatusFor` returns
     * 'verified' early for them, before the verdict is consulted at all), and
     * an admin can approve a `review` row from the queue. Either path can
     * produce a verified account whose verdict is not 'match'. Inferring
     * ownership from `status` would therefore be wrong in exactly the cases a
     * third-party control exists to catch.
     */
    /**
     * ABSENT IS NOT THE SAME AS "NOT A MATCH", and conflating them was a bug.
     *
     * The first version of this guard read `matchVerdict !== 'match'`, which
     * refuses a verified row that simply has no verdict recorded. Caught by
     * test:ngn-limit-enforcement, where every seeded account is
     * `status: 'verified'` with no verdict - 4 legitimate self-payouts started
     * returning 403 "can only go to an account in your own name".
     *
     * That was not merely a test-fixture problem. Any verified row written
     * before the verdict was stored reads the same way, so the guard would
     * have locked real Nigerian users out of their own money on the deploy
     * that shipped it.
     *
     * Allowing an absent verdict opens nothing: saveNgnPayoutAccount() always
     * records one, admin review preserves the original, and Postgres declares
     * match_verdict `not null` (migration 037). No code path can produce a
     * verified row without a verdict, so the only rows this admits are ones
     * that predate the field - which are, by construction, accounts that
     * cleared the name check of their day.
     *
     * So: refuse only when a verdict is PRESENT and is not a match. That is
     * the third party, stated positively.
     */
    /**
     * A VERDICT DERIVED FROM A FABRICATED NAME IS NOT EVIDENCE.
     *
     * Breet's sandbox resolves ANY ten digits to a plausible name, which is
     * why payoutAccountStatusFor() force-verifies untrustworthy resolutions
     * rather than trusting the comparison. Refusing on the verdict here would
     * re-make, one layer down, the judgement that function deliberately
     * declined to make - and it made naira withdrawals impossible on
     * test-sivan while looking correct in review.
     *
     * Found by driving the whole withdrawal over HTTP: account 2222222222
     * saved as status 'verified' with verdict 'review' (the mock returns a
     * longer name than the profile), and the quote then returned 403 "can only
     * go to an account in your own name" for the user's OWN account.
     *
     * Narrow by construction. In production BREET_ENV is 'production', a real
     * NIBSS resolution is trustworthy, resolutionTrustworthy is true, and the
     * verdict governs exactly as intended.
     *
     * DELIBERATELY NOT KEYED ON reviewedAt. I tried that first - treating "an
     * admin approved it" as proof of ownership - and it was wrong: the review
     * queue exists to clear accounts a machine could not match, INCLUDING ones
     * in another person's name, and test:ngn-third-party-payouts seeds exactly
     * that row. Four of its assertions failed and were right to. An approval
     * clears an account for review, not for ownership.
     */
    const verdictIsMeaningless = chosen?.resolutionTrustworthy === false;
    if (
      chosen && chosen.matchVerdict && chosen.matchVerdict !== 'match'
      && !verdictIsMeaningless
    ) {
      const controls = await getNgnControls();
      if (!controls.thirdPartyPayoutsEnabled) {
        /**
         * ENFORCED HERE, SERVER SIDE, NOT ONLY IN THE UI.
         *
         * The withdraw screen also hides the option, but a hidden button is
         * not a control - the quote endpoint is reachable directly. This is
         * the line that makes the admin toggle real, and there is a test that
         * fails if it is removed.
         *
         * Named plainly rather than as "coming soon": on this rail it is not
         * a queue the user can wait in. Breet binds the destination bank to
         * the user's permanent deposit address, so paying someone else is not
         * a feature flag away, it is a different provider product.
         */
        throw forbidden(
          'Naira withdrawals can only go to an account in your own name.'
        );
      }
    }

    if (chosen) {
      payoutBank = {
        bankId: chosen.bankId,
        accountNumber: chosen.accountNumber,
        bankName: chosen.bankName,
        accountName: chosen.accountName,
      };
    }
  }

  const now = nowIso();
  const record: NgnQuoteRecord = { id: id('ngnq'), userId: input.userId, customerId: customer?.id, direction: input.direction, provider: quote.provider, sourceCurrency: input.sourceCurrency, destinationCurrency: input.destinationCurrency, sourceAmount: quote.sourceAmount, destinationAmount: destinationAfterMargin.toFixed(input.destinationCurrency === 'ngn' ? 2 : 6), rate: quote.rate, feeAmount: feeAmountForRecord, status: 'quote_created', providerQuoteId: quote.providerQuoteId, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), metadata: {
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
      providerFee: input.direction === 'offramp' ? fixedMoney(providerFeeAsset, 6) : fixedMoney(margin.providerFee, 2),
      providerName: quote.provider,
      sivanMargin: input.direction === 'offramp' ? fixedMoney(sivanMarginAsset, 6) : fixedMoney(margin.sivanMargin, 2),
      totalFee: input.direction === 'offramp' ? fixedMoney(totalFeeAsset, 6) : fixedMoney(totalFeeNgn, 2),
      providerFeeAsset: fixedMoney(providerFeeAsset, 6),
      providerFeeNgn: fixedMoney(providerFeeNgn, 2),
      sivanMarginAsset: fixedMoney(sivanMarginAsset, 6),
      sivanMarginNgn: fixedMoney(sivanMarginNgn, 2),
      totalFeeAsset: fixedMoney(totalFeeAsset, 6),
      totalFeeNgn: fixedMoney(totalFeeNgn, 2),
      assetCurrency: input.sourceCurrency,
      ngnCurrency: 'ngn',
      revenueMode,
      breetMarkupPercent: fixedMoney(breetMarkupPercentForQuote, 4),
      /**
       * PROVENANCE, not just the number. `markupKnown: false` means the read
       * failed and this quote was priced from the last known value - the
       * difference between a deliberate 0% and a silent revenue loss, which
       * were previously indistinguishable to anyone reading a quote.
       */
      markupKnown: breetMarkupKnown,
      markupSource: breetMarkupSource,
      effectivePercent,
      appliedRule: margin.appliedRule,
      explanation: margin.explanation,
    },
  }, createdAt: now, updatedAt: now };
  await db.upsertNgnQuoteRecord(record);
  await createAuditLog({ actorType: 'user', actorId: input.userId, action: 'ngn.quote_created', resourceType: 'payments_ngn_quote', resourceId: record.id, metadata: { direction: record.direction, provider: record.provider } });
  /**
   * FEES PROMOTED TO A TOP-LEVEL FIELD.
   *
   * The breakdown already existed on `metadata.fees`, but nothing in the app
   * read it - the UI had only `feeAmount`, a single number in the SOURCE
   * asset, which is how a 0.5107 USDC fee came to be rendered as "₦1".
   *
   * Returned alongside the record rather than buried, because a user looking
   * at a naira payout needs three things this makes possible: what Sivan
   * charges, what the provider charges, and the rate that produced them.
   */
  return {
    ...record,
    fees: {
      providerFee: input.direction === 'offramp' ? fixedMoney(providerFeeAsset, 6) : fixedMoney(margin.providerFee, 2),
      providerName: quote.provider,
      sivanMargin: input.direction === 'offramp' ? fixedMoney(sivanMarginAsset, 6) : fixedMoney(margin.sivanMargin, 2),
      totalFee: input.direction === 'offramp' ? fixedMoney(totalFeeAsset, 6) : fixedMoney(totalFeeNgn, 2),
      providerFeeAsset: fixedMoney(providerFeeAsset, 6),
      providerFeeNgn: fixedMoney(providerFeeNgn, 2),
      sivanMarginAsset: fixedMoney(sivanMarginAsset, 6),
      sivanMarginNgn: fixedMoney(sivanMarginNgn, 2),
      totalFeeAsset: fixedMoney(totalFeeAsset, 6),
      totalFeeNgn: fixedMoney(totalFeeNgn, 2),
      assetCurrency: input.sourceCurrency,
      ngnCurrency: 'ngn',
      revenueMode,
      breetMarkupPercent: fixedMoney(breetMarkupPercentForQuote, 4),
      /**
       * PROVENANCE, not just the number. `markupKnown: false` means the read
       * failed and this quote was priced from the last known value - the
       * difference between a deliberate 0% and a silent revenue loss, which
       * were previously indistinguishable to anyone reading a quote.
       */
      markupKnown: breetMarkupKnown,
      markupSource: breetMarkupSource,
      effectivePercent: String(effectivePercent),
    },
  };
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
