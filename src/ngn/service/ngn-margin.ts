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

  if (input.direction === 'onramp') {
    // Same engine as the rest of the platform, so tiers and the USD minimum
    // apply exactly as an admin configured them.
    const result = calculateOnrampFee({
      amount: gross,
      basePercent: Number(settings.onrampFeePercent ?? 0),
      minimumFeeUsd: Number(settings.onrampMinimumFeeUsd ?? 0),
      tiers: settings.onrampFeeTiers ?? [],
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

  const percent = Number(settings.offrampFeePercent ?? 0);
  const sivanMargin = round((gross * percent) / 100, 6);
  const totalFee = round(providerFee + sivanMargin, 6);

  return {
    providerFee: round(providerFee, 6),
    sivanMargin,
    totalFee,
    effectivePercent: round((totalFee / gross) * 100, 4),
    appliedRule: 'base_percent',
    explanation: `${percent}% Sivan margin`,
  };
}
