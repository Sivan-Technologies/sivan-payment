/**
 * WHAT A CROSS-BORDER SUPPLIER PAYOUT COSTS.
 *
 * createSupplierPayment() charged NOTHING. Grepped before writing this: the
 * word "fee" did not appear in the supplier service at all. It held the
 * payment amount, routed it to Bridge, and Sivan earned zero on the most
 * expensive, highest-touch flow in the product - a third-party payout to a
 * foreign bank account, through a compliance review, on a rail Sivan pays for.
 *
 * Send-crypto was priced (transfer-fee-policy.ts). Off-ramp was priced
 * (SIVAN_OFFRAMP_FEE_PERCENT, 1.25%). Supplier payouts were the hole.
 *
 *
 * WHY THIS FLOW CAN HAVE TIERS WHEN OFF-RAMP CANNOT.
 *
 * Not a product preference - a provider constraint, verified against the real
 * Bridge sandbox rather than read off a doc:
 *
 *   OFF-RAMP    POST /liquidation_addresses { custom_developer_fee_percent }
 *               A flat percentage fixed WHEN THE ADDRESS IS CREATED. The user
 *               sends funds later, so no amount exists at that moment. A floor
 *               or a tier is not restricted, it is IMPOSSIBLE.
 *
 *   SUPPLIER    POST /transfers { developer_fee: "15.00" }
 *               A fixed USD AMOUNT computed per payment, exactly like on-ramp.
 *               The amount is known at quote time, so tiers and a floor are
 *               fully expressible.
 *
 * MEASURED CONSTRAINTS on developer_fee (real sandbox, this session):
 *
 *   developer_fee: "500.00" on amount "1.00"
 *     -> 400 {"developer_fee":"must be less than total amount"}
 *   developer_fee: "0.12345"
 *     -> 400 {"developer_fee":"is only allowed 2 digits max of precision"}
 *
 * So the fee must be strictly below the transfer amount and carry at most two
 * decimals. Both are enforced here rather than discovered at payout time,
 * because a 400 from Bridge after a compliance hold is a support ticket about
 * money that appears stuck.
 *
 *
 * THE FEE IS ADDED, NOT DEDUCTED. This flow is the opposite of send-crypto.
 *
 * A supplier invoices $1,000 and expects $1,000. Deducting the fee would wire
 * $985 against a $1,000 invoice and leave the user underpaying a business
 * relationship - the user would have to gross up by hand, every time, and get
 * it wrong. So the user is debited amount + fee, and the supplier receives
 * exactly what was entered.
 *
 * Mechanically: Bridge deducts developer_fee FROM the transfer amount, so to
 * land `net` in the supplier's account Sivan submits
 *
 *     amount        = net + fee     (gross, debited from the user)
 *     developer_fee = fee
 *
 * and Bridge pays out `net`. That also satisfies "fee < amount" for any
 * positive net, automatically.
 *
 *
 * WHY MARGINAL TIERS AND NOT BANDS.
 *
 * transfer-fee-policy.ts rejected banded pricing for a reason that applies
 * with more force here, because the amounts are larger:
 *
 *     0-500:1.5% | 500-2000:1.2%
 *         $499.99 -> $7.50        $500.01 -> $6.00
 *
 * Paying MORE for sending LESS. At supplier-payment sizes a band edge can move
 * the fee by tens of dollars across one cent, and a user who notices is being
 * cheated in a way that cannot be defended.
 *
 * These tiers are MARGINAL, like income-tax brackets: each slice of the
 * payment is charged at its own rate. The curve is continuous everywhere - at
 * a boundary the next cent is simply charged at the next rate - and the
 * effective rate falls smoothly as the payment grows.
 *
 *     $200      $3.00    1.500%
 *     $500      $7.50    1.500%
 *     $2,000   $25.50    1.275%
 *     $10,000  $97.50    0.975%
 *     $50,000 $337.50    0.675%
 *
 *
 * WHY THE VOLUME DISCOUNT IS ALLOWED A CLIFF WHEN THE TIERS ARE NOT.
 *
 * The 30-day discount steps: 0% / 10% / 20% / 30%. That IS a cliff, and it is
 * deliberate. A cliff in a FEE is a trap - one cent more and you pay more. A
 * cliff in a DISCOUNT can only ever reduce what you owe, so crossing it is
 * always good news and never a surprise on a receipt. It is also how every
 * loyalty tier a user has ever seen behaves, so it needs no explaining.
 */

import type { SupplierPayoutCurrency } from '../database/types.js';

/** Bridge accepts at most 2 decimal places on developer_fee. Measured. */
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const money2 = (value: number) => round2(value).toFixed(2);

/**
 * One marginal band.
 *
 * `upToUsd: null` is the open-ended top band. Bands are applied in order and
 * each charges only the portion of the payment that falls inside it.
 */
export interface SupplierFeeTier {
  /** Exclusive upper bound of this band in USD, or null for the top band. */
  upToUsd: number | null;
  percent: number;
}

/** One step of the cumulative-volume discount. */
export interface SupplierVolumeDiscountTier {
  /** Inclusive 30-day settled volume, in USD, at which this step begins. */
  fromVolumeUsd: number;
  /** Percentage OFF the computed fee. 10 means "10% cheaper", not "10% fee". */
  discountPercent: number;
}

export interface SupplierFeeConfig {
  /** Marginal bands, ascending. */
  tiers: SupplierFeeTier[];
  /** 30-day volume discount steps, ascending. */
  volumeDiscounts: SupplierVolumeDiscountTier[];
  /** Never charge less than this, in USD. 0 disables the floor. */
  minimumUsd: number;
  /** Never charge more than this, in USD. 0 disables the cap. */
  maximumUsd: number;
  /**
   * Added on the FIRST payment to each supplier, covering the compliance
   * review that relationship triggers.
   *
   * THE COST IS PER RELATIONSHIP, NOT PER PAYMENT - which is why this exists
   * and why the floor came down to meet it. supplier-risk.service.ts computes
   * `isFirstPayment` per supplier and scores +25 for it, and with
   * autoApproveApprovedSuppliers a low-risk repeat payment to an already
   * approved supplier is auto-approved: no human touches it. So the expensive
   * event is onboarding a supplier, and every subsequent invoice to that same
   * supplier is cheap to process.
   *
   * A flat $2 floor charged EVERY payment for a review most of them never
   * trigger. A business paying one supplier weekly paid the onboarding cost
   * 52 times a year. Now they pay it once.
   *
   * Directly mirrors `newRecipientUsd` in transfer-fee-policy.ts, which
   * recovers Solana ATA rent only on the send that actually creates the
   * account. Same argument, same shape.
   *
   * 0 disables it.
   */
  newSupplierUsd: number;
}

export interface SupplierFeeQuote {
  /** What the supplier receives. Exactly what the user asked to send. */
  netAmount: string;
  /** Sivan's fee, two decimals - the value sent to Bridge as developer_fee. */
  fee: string;
  /** What leaves the user's balance: netAmount + fee. */
  grossAmount: string;
  /** Fee before the volume discount, for showing the saving. */
  feeBeforeDiscount: string;
  /** Money saved by the user's 30-day volume, or "0.00". */
  volumeDiscountAmount: string;
  /** The discount step that applied, 0 when none. */
  volumeDiscountPercent: number;
  /** The 30-day volume the discount was based on. */
  volumeUsd: string;
  /** Effective rate against the amount sent. Never the nominal band rate. */
  effectivePercent: string;
  /** The one-time new-supplier charge, or "0.00" when none applies. */
  newSupplierFee: string;
  /** True when this is the first payment to this supplier. */
  isFirstPaymentToSupplier: boolean;
  /** Which rule set the final number. For the UI, and for support. */
  appliedRule: 'tiered' | 'minimum' | 'maximum';
  /** Per-band breakdown, so the UI can show its work. */
  breakdown: Array<{ fromUsd: number; toUsd: number | null; percent: number; amountInBand: string; feeFromBand: string }>;
  /** One line, safe to show a user. */
  explanation: string;
}

/**
 * The default curve.
 *
 * Anchored on what the flow actually costs Sivan, not picked to look tidy.
 * Bridge charges for the payout rail, the payment carries a compliance review
 * (supplier risk scoring, an approval queue, an admin release), and the money
 * is held on Sivan's balance sheet between hold and release. 1.5% at the small
 * end sits under the 2-4% that Wise/Payoneer-style business payouts cost out
 * of Nigeria, and 0.6% at the top keeps large invoices worth routing here.
 *
 * Overridden by admin settings at runtime; these exist so a deployment that has
 * never opened the fee tab charges something defensible rather than nothing.
 */
export const DEFAULT_SUPPLIER_FEE: SupplierFeeConfig = {
  tiers: [
    { upToUsd: 500, percent: 1.5 },
    { upToUsd: 2_000, percent: 1.2 },
    { upToUsd: 10_000, percent: 0.9 },
    { upToUsd: null, percent: 0.6 },
  ],
  volumeDiscounts: [
    { fromVolumeUsd: 0, discountPercent: 0 },
    { fromVolumeUsd: 10_000, discountPercent: 10 },
    { fromVolumeUsd: 50_000, discountPercent: 20 },
    { fromVolumeUsd: 250_000, discountPercent: 30 },
  ],
  /**
   * Floor, LOWERED FROM $2.00.
   *
   * At $2 a $50 invoice paid 4% - against Nigerian P2P spreads of 1-3% and
   * Wise/Payoneer business payouts at 2-4%. It made Sivan the expensive option
   * for exactly the small, frequent invoices a WhatsApp-first product exists
   * to serve, and it did so by charging every payment for a compliance review
   * that only the first payment to a supplier actually triggers.
   *
   * $0.50 covers the payout rail and the ledger work on a repeat payment. The
   * review is recovered once, by newSupplierUsd, from the payment that causes
   * it.
   *
   *     $50 repeat  -> $0.75  (1.50%)   was $2.00 (4.00%)
   *     $20 repeat  -> $0.50  (2.50%)   was $2.00 (10.0%)
   */
  minimumUsd: 0.5,
  /**
   * No cap by default. Unlike a crypto send - where the cost is half a cent of
   * gas and an uncapped percentage becomes indefensible - a large cross-border
   * payout carries proportionally larger settlement and compliance exposure.
   * Set a non-zero value in the fee tab to cap it.
   */
  maximumUsd: 0,
  /**
   * Onboarding a supplier: risk scoring, an approval queue and an admin
   * decision, plus Bridge's external-account creation. Charged once per
   * supplier, on the first payment to them.
   */
  newSupplierUsd: 1.5,
};

/** The rolling window the volume discount is measured over. */
export const SUPPLIER_VOLUME_WINDOW_DAYS = 30;

/**
 * The discount step for a given 30-day volume.
 *
 * Highest qualifying step wins. Exported so the UI can show a user how far
 * they are from the next one without duplicating the ladder.
 */
export function volumeDiscountFor(volumeUsd: number, config: SupplierFeeConfig = DEFAULT_SUPPLIER_FEE): SupplierVolumeDiscountTier {
  const safe = Number.isFinite(volumeUsd) && volumeUsd > 0 ? volumeUsd : 0;
  const steps = [...(config.volumeDiscounts ?? [])].sort((a, b) => a.fromVolumeUsd - b.fromVolumeUsd);
  let applicable: SupplierVolumeDiscountTier = { fromVolumeUsd: 0, discountPercent: 0 };
  for (const step of steps) {
    if (safe >= step.fromVolumeUsd) applicable = step;
  }
  return applicable;
}

/**
 * The next discount step a user has not yet reached, if any.
 *
 * For the "send $X more this month to reach 20%" line. Undefined at the top.
 */
export function nextVolumeDiscount(volumeUsd: number, config: SupplierFeeConfig = DEFAULT_SUPPLIER_FEE):
  { tier: SupplierVolumeDiscountTier; remainingUsd: number } | undefined {
  const safe = Number.isFinite(volumeUsd) && volumeUsd > 0 ? volumeUsd : 0;
  const steps = [...(config.volumeDiscounts ?? [])].sort((a, b) => a.fromVolumeUsd - b.fromVolumeUsd);
  const next = steps.find((step) => step.fromVolumeUsd > safe && step.discountPercent > 0);
  if (!next) return undefined;
  return { tier: next, remainingUsd: round2(next.fromVolumeUsd - safe) };
}

/**
 * Price one supplier payment.
 *
 * Pure: no database, no clock, no environment. The quote endpoint, the payment
 * path and the tests all run the same arithmetic on the same inputs, which is
 * the only way the number a user is shown can be the number they are charged.
 *
 * @param netAmount    what the supplier must receive
 * @param volumeUsd    the user's settled supplier volume over the rolling window
 */
export function quoteSupplierFee(
  netAmount: number,
  volumeUsd = 0,
  config: SupplierFeeConfig = DEFAULT_SUPPLIER_FEE,
  options: { isFirstPaymentToSupplier?: boolean } = {}
): SupplierFeeQuote {
  const net = Number.isFinite(netAmount) && netAmount > 0 ? netAmount : 0;
  const tiers = [...(config.tiers ?? [])].sort((a, b) => {
    // null (open-ended) always sorts last.
    if (a.upToUsd === null) return 1;
    if (b.upToUsd === null) return -1;
    return a.upToUsd - b.upToUsd;
  });

  /**
   * MARGINAL, so the curve is continuous.
   *
   * Each band charges only the slice of the payment inside it. A payment that
   * crosses a boundary pays the higher rate on the part below it and the lower
   * rate on the part above - never a jump.
   */
  const breakdown: SupplierFeeQuote['breakdown'] = [];
  let remaining = net;
  let lowerBound = 0;
  let tieredFee = 0;

  for (const tier of tiers) {
    if (remaining <= 0) break;
    const bandWidth = tier.upToUsd === null ? Infinity : Math.max(0, tier.upToUsd - lowerBound);
    const amountInBand = Math.min(remaining, bandWidth);
    if (amountInBand > 0) {
      const percent = Math.max(0, tier.percent);
      const feeFromBand = amountInBand * (percent / 100);
      tieredFee += feeFromBand;
      breakdown.push({
        fromUsd: lowerBound,
        toUsd: tier.upToUsd,
        percent,
        amountInBand: money2(amountInBand),
        feeFromBand: money2(feeFromBand),
      });
      remaining -= amountInBand;
    }
    lowerBound = tier.upToUsd ?? lowerBound;
  }

  const feeBeforeDiscount = tieredFee;

  // The loyalty step, applied to the fee rather than the amount.
  const discount = volumeDiscountFor(volumeUsd, config);
  const discountPercent = Math.max(0, Math.min(100, discount.discountPercent));
  const discountAmount = feeBeforeDiscount * (discountPercent / 100);
  let fee = feeBeforeDiscount - discountAmount;

  let appliedRule: SupplierFeeQuote['appliedRule'] = 'tiered';

  /**
   * FLOOR AFTER THE DISCOUNT.
   *
   * The floor is the point below which the payment stops covering its own
   * compliance review, and a discount does not make that review cheaper. Order
   * matters: applying the floor first and then discounting would let a 30%
   * member pay $1.40 against a $2.00 floor - a floor that does not hold is not
   * a floor.
   */
  /**
   * THE FLOOR APPLIES TO A PAYMENT, NOT TO NOTHING.
   *
   * `net > 0` is load-bearing. Without it a zero, negative or NaN amount was
   * charged the $2 minimum - so an empty amount field in the confirm dialog
   * quoted "$0.00 to your supplier, $2.00 fee", and a malformed request would
   * have created a payment that was pure fee. Caught by test, not by reading.
   */
  const floor = Math.max(0, config.minimumUsd);
  if (net > 0 && floor > 0 && fee < floor) {
    fee = floor;
    appliedRule = 'minimum';
  }

  const ceiling = Math.max(0, config.maximumUsd);
  if (ceiling > 0 && fee > ceiling) {
    fee = ceiling;
    appliedRule = 'maximum';
  }

  /**
   * THE ONE-TIME SUPPLIER ONBOARDING CHARGE, added AFTER the cap.
   *
   * Deliberately outside the cap, for the same reason the ATA-rent surcharge
   * is in transfer-fee-policy.ts: the cap limits Sivan's MARGIN, while this
   * recovers a real cost incurred on this specific payment. Folding it under
   * the cap would mean a large first payment silently absorbs the review it
   * triggered - the exact subsidy this exists to remove.
   *
   * And NOT discounted by volume. A high-volume user onboarding a brand new
   * supplier causes exactly the same review as anyone else; the loyalty
   * discount applies to the rate they pay for moving money, not to a
   * one-off cost they have just caused.
   */
  const isFirstPaymentToSupplier = Boolean(options.isFirstPaymentToSupplier);
  const newSupplierFee = isFirstPaymentToSupplier && net > 0 ? Math.max(0, config.newSupplierUsd) : 0;
  fee += newSupplierFee;

  /**
   * BRIDGE REQUIRES developer_fee < amount, MEASURED.
   *
   *   developer_fee "500.00" on amount "1.00"
   *     -> 400 "must be less than total amount"
   *
   * Because the fee is ADDED here, gross = net + fee, so the fee is strictly
   * below the gross for any positive net and this can never trip in normal
   * use. It is enforced anyway for the misconfiguration case - a floor set
   * absurdly high against a tiny payment - so the refusal happens at quote
   * time with an explanation, rather than as a 400 from Bridge after the money
   * is already on hold.
   */
  if (net > 0 && fee >= net + fee) {
    fee = Math.max(0, net - 0.01);
    appliedRule = 'maximum';
  }

  fee = round2(fee);
  const gross = round2(net + fee);
  /**
   * THE RATE EXCLUDES THE ONE-TIME SETUP CHARGE.
   *
   * Caught in the screenshot: a $600 first payment showed "Sivan fee (1.700%)"
   * because the 1.50 onboarding charge was folded into the percentage. That
   * overstates the ONGOING rate - the next invoice to the same supplier is
   * 1.450% - so the headline number described a cost the user would never pay
   * again, right beside a row explaining the charge was one-time. The two
   * contradicted each other.
   *
   * The recurring rate is the honest one to advertise; the setup charge is
   * shown separately as cash, which is how a one-off should be presented.
   */
  const recurringFee = Math.max(0, fee - newSupplierFee);
  const effective = net > 0 ? (recurringFee / net) * 100 : 0;

  const bandsUsed = breakdown.length;
  const base =
    appliedRule === 'minimum'
      ? `Minimum fee of $${floor.toFixed(2)} applied`
      : appliedRule === 'maximum' && ceiling > 0
        ? `Capped at the maximum fee of $${ceiling.toFixed(2)}`
        : bandsUsed > 1
          ? `Tiered rate across ${bandsUsed} bands`
          : `${breakdown[0]?.percent ?? 0}% of the amount sent`;

  const discountNote = discountPercent > 0 && appliedRule === 'tiered'
    ? `, less ${discountPercent}% for your ${SUPPLIER_VOLUME_WINDOW_DAYS}-day volume`
    : '';
  /**
   * Named as a ONE-TIME SETUP cost and said to be once, because the thing a
   * user needs to know is that the next invoice to this supplier is cheaper.
   * A surcharge that appears without explanation reads as a rate rise.
   */
  const setupNote = newSupplierFee > 0
    ? `, plus a one-time $${newSupplierFee.toFixed(2)} to set up this supplier (first payment only)`
    : '';
  const explanation = `${base}${discountNote}${setupNote}. Added on top, so your supplier receives the full $${money2(net)}.`;

  return {
    netAmount: money2(net),
    fee: money2(fee),
    newSupplierFee: money2(newSupplierFee),
    isFirstPaymentToSupplier,
    grossAmount: money2(gross),
    feeBeforeDiscount: money2(feeBeforeDiscount),
    volumeDiscountAmount: money2(appliedRule === 'tiered' ? discountAmount : 0),
    volumeDiscountPercent: appliedRule === 'tiered' ? discountPercent : 0,
    volumeUsd: money2(Number.isFinite(volumeUsd) && volumeUsd > 0 ? volumeUsd : 0),
    effectivePercent: effective.toFixed(3),
    appliedRule,
    breakdown,
    explanation,
  };
}

/**
 * Bridge's own transaction minimums per destination rail.
 *
 * Not Sivan's rule. A payout below these is rejected by Bridge, and dust below
 * the minimum is "neither credited nor returned" - so this is checked before a
 * payment is accepted rather than after the funds have moved.
 *
 * The fee does NOT interact with these here, which is the quiet benefit of
 * adding rather than deducting: the supplier receives exactly the amount
 * entered, so the amount the user typed is the amount checked against the
 * minimum. Under a deducted fee this check would have to run on the net and
 * could fail after the user had already been quoted.
 */
export const SUPPLIER_RAIL_MINIMUM_USD: Record<SupplierPayoutCurrency, number> = {
  usd: 1,
  gbp: 1,
  eur: 1,
  mxn: 1,
  brl: 1,
};

/** The effective rate at a given amount and volume. For the fee tab's preview. */
export function supplierEffectiveRateAt(
  netAmount: number,
  volumeUsd = 0,
  config: SupplierFeeConfig = DEFAULT_SUPPLIER_FEE
): number {
  return Number(quoteSupplierFee(netAmount, volumeUsd, config).effectivePercent);
}

/**
 * Which payment states count toward the volume discount.
 *
 * COMPLETED AND IN-FLIGHT, not merely requested.
 *
 * `pending_review` and `rejected` are excluded on purpose. Counting a pending
 * payment would let a user unlock a discount by submitting a large payment
 * they never intend to complete, taking the cheaper rate on everything else
 * and then abandoning it - the discount would be self-granting. Counting
 * rejected payments would reward exactly the behaviour the risk engine exists
 * to stop.
 *
 * `approved` and `processing` ARE counted: the money is committed and held,
 * and excluding them would make a user's rate flicker back up during the days
 * a payment sits in settlement.
 */
export const SUPPLIER_VOLUME_COUNTING_STATUSES = ['approved', 'processing', 'completed'] as const;
