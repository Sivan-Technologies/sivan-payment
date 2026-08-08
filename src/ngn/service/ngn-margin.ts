/**
 * Sivan's margin on NGN transactions.
 *
 * THE PROBLEM THIS FIXES
 *
 * The NGN quote path applied the PROVIDER's fee and nothing else. Breet charges
 * 0.5%, Sivan charged 0%, so every naira transaction ran at cost. The admin fee
 * settings existed and worked - they were simply never read by this path.
 *
 * HOW THE TWO FEES STACK
 *
 * They are different things and must stay visible separately:
 *
 *   provider fee - what Breet or Paj deducts. A COST to Sivan. Not revenue.
 *   sivan margin - what Sivan adds on top. Revenue.
 *
 * Collapsing them into one number would make it impossible to answer "are we
 * making money on this flow", because a provider raising its rate would look
 * identical to Sivan earning more. It also means a support agent cannot explain
 * a fee to a user, and reconciliation cannot separate cost from income.
 *
 * So a quote carries three figures: what the provider took, what Sivan took,
 * and the total the user actually paid.
 *
 * MARGIN IS CHARGED ON THE GROSS
 *
 * Sivan's percentage applies to the full transaction amount, not to what is
 * left after the provider's cut. Charging on the net would silently shrink
 * Sivan's revenue whenever a provider raised its fee - the opposite of what a
 * margin is for.
 */

import { getAdminFeeSettings } from '../../admin/admin-fees.service.js';
import { calculateOnrampFee } from '../../admin/fee-policy.js';
import type { NgnDirection } from '../types/ngn.types.js';

export interface MarginInput {
  direction: NgnDirection;
  /**
   * Gross amount the margin is charged on, in the currency the fee is
   * denominated in. On-ramp: NGN. Off-ramp: the USD value of the crypto.
   */
  grossAmount: number;
  /** Fee the provider already deducted, same units as grossAmount. */
  providerFeeAmount: number;
  /**
   * NGN per source unit, when the provider's fee is denominated in naira but
   * the gross is not.
   *
   * Off-ramp only. breet.provider.ts computes its off-ramp fee on the NAIRA
   * gross while `grossAmount` here is USDC, so the two must be reconciled or
   * the totals are out by the exchange rate - a 1,500x error that reads as a
   * 751% fee. Optional: when absent the provider fee is assumed to already be
   * in source units, which is what the mock provider and on-ramp both do.
   */
  rate?: number | string;
}

export interface MarginResult {
  /** Provider's cut. A cost, not revenue. */
  providerFee: number;
  /** Sivan's cut. Revenue. */
  sivanMargin: number;
  /** What the user pays in total. */
  totalFee: number;
  /** Total as a percentage of gross, for display. */
  effectivePercent: number;
  /** Which admin rule produced the margin, for support and the UI. */
  appliedRule: string;
  explanation: string;
}

function round(value: number, dp: number): number {
  const factor = 10 ** dp;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Compute Sivan's margin on top of whatever the provider charged.
 *
 * On-ramp reuses calculateOnrampFee so tiers and the minimum fee behave
 * identically to every other on-ramp in the system. Having two fee engines that
 * drift apart is how a user is quoted one number and charged another.
 *
 * Off-ramp is a flat percentage: the admin fee model has no off-ramp tiers, and
 * inventing them here would put a rule in the NGN path that the admin UI cannot
 * see or edit.
 */
export async function applySivanMargin(input: MarginInput): Promise<MarginResult> {
  const settings = await getAdminFeeSettings();

  const gross = Number(input.grossAmount);
  const providerFee = Number(input.providerFeeAmount) || 0;

  if (!Number.isFinite(gross) || gross <= 0) {
    return {
      providerFee: round(providerFee, 2),
      sivanMargin: 0,
      totalFee: round(providerFee, 2),
      effectivePercent: 0,
      appliedRule: 'invalid_amount',
      explanation: 'Amount must be greater than zero.',
    };
  }

  // NGN has its own fee lever, because it is a different rail with a different
  // cost base and different competition. Zero means "not set", in which case it
  // falls back to the Bridge percentage - preserving the behaviour every
  // existing deployment already has rather than silently zeroing the margin.
  const ngnOnramp = Number(settings.ngnOnrampFeePercent ?? 0);
  const ngnOfframp = Number(settings.ngnOfframpFeePercent ?? 0);
  const minimumNgn = Number(settings.ngnMinimumFeeNgn ?? 0);

  if (input.direction === 'onramp') {
    const usingNgnRate = ngnOnramp > 0;

    // Same engine as the rest of the platform, so tiers and the minimum behave
    // exactly as configured. The NGN minimum is denominated in naira and the
    // on-ramp gross IS naira, so it maps onto minimumFeeUsd directly - the
    // field is a floor in the fee's own currency, not specifically dollars.
    const result = calculateOnrampFee({
      amount: gross,
      basePercent: usingNgnRate ? ngnOnramp : Number(settings.onrampFeePercent ?? 0),
      minimumFeeUsd: usingNgnRate ? minimumNgn : Number(settings.onrampMinimumFeeUsd ?? 0),
      // Tiers are a Bridge-side concept keyed to USD amounts. Applying them to
      // a naira gross would compare NGN 50,000 against a $50 tier boundary and
      // silently pick the wrong band, so they are not carried over.
      tiers: usingNgnRate ? [] : (settings.onrampFeeTiers ?? []),
    });

    const sivanMargin = Number(result.feeAmount);
    const totalFee = round(providerFee + sivanMargin, 2);

    return {
      providerFee: round(providerFee, 2),
      sivanMargin: round(sivanMargin, 2),
      totalFee,
      effectivePercent: round((totalFee / gross) * 100, 4),
      appliedRule: result.appliedRule,
      explanation: result.explanation,
    };
  }

  const percent = ngnOfframp > 0 ? ngnOfframp : Number(settings.offrampFeePercent ?? 0);
  const sivanMargin = round((gross * percent) / 100, 6);

  /**
   * THE PROVIDER FEE MUST BE IN THE SAME UNIT AS THE MARGIN, AND IT WAS NOT.
   *
   * On off-ramp `gross` is the SOURCE amount (USDC), so sivanMargin is USDC.
   * But breet.provider.ts computes its off-ramp feeAmount on the NAIRA gross:
   *
   *     const gross = source * rate;          // 51 USDC -> 76,500 NGN
   *     feeAmount = gross * (feePercent/100); // 382.5 ... NGN
   *
   * Adding 382.5 to 0.51 and calling the result USDC is a 1,500x unit error:
   * a 51 USDC withdrawal would have been charged 383 USDC - 751% - and the
   * user would have received nothing.
   *
   * Dormant only because the live NGN provider is `mock`, whose quote reports
   * no fee. It would have fired on the first real Breet off-ramp.
   *
   * Converted here rather than in the provider because the provider's number
   * is correct in its own terms - it is describing a naira deduction - and
   * this function is the one place that knows which unit the total is in.
   */
  const providerFeeInSourceUnits = input.rate && Number(input.rate) > 0
    ? round(providerFee / Number(input.rate), 6)
    : providerFee;

  const totalFee = round(providerFeeInSourceUnits + sivanMargin, 6);

  return {
    // Reported in SOURCE units so providerFee + sivanMargin === totalFee.
    // Returning the naira figure here would make the three numbers on an
    // admin screen fail to add up.
    providerFee: round(providerFeeInSourceUnits, 6),
    sivanMargin,
    totalFee,
    effectivePercent: round((totalFee / gross) * 100, 4),
    appliedRule: 'base_percent',
    explanation: `${percent}% Sivan margin${ngnOfframp > 0 ? ' (NGN rate)' : ' (default rate)'}`,
  };
}
