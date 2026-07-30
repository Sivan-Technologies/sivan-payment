import { getAdminFeeSettings } from '../../admin/admin-fees.service.js';
import { calculateOnrampFee } from '../../admin/fee-policy.js';

export function money(value: number, decimals = 2) {
  return value.toFixed(decimals);
}

/**
 * Bridge's transaction minimum for USD on-ramp.
 *
 * Minimums are enforced AFTER the developer fee is deducted, and deposits that
 * fall below are "not credited or returned". A fee that pushes the net under
 * this destroys the user's money, so the policy caps the fee rather than
 * collecting it. Conservative on purpose: better to under-charge than to void
 * a deposit.
 */
const USD_TRANSACTION_MINIMUM = 1;

export async function getOnrampFeePercent(): Promise<string> {
  const settings = await getAdminFeeSettings();
  return settings.onrampFeePercent.toFixed(2).replace(/\.00$/, '');
}

/**
 * Quote an on-ramp order.
 *
 * The fee is a fixed USD amount rather than a percentage because that is what
 * Bridge accepts on POST /transfers (`developer_fee`), and because the amount
 * is known here. That is what makes a minimum fee and amount tiers possible on
 * on-ramp when they are impossible on off-ramp and virtual accounts, where the
 * fee is fixed before any amount exists.
 *
 * Bridge withholds exactly the amount sent, so there is no shortfall for Sivan
 * to absorb and no separate ledger to reconcile.
 */
export async function calculateOnrampQuote(amount: number) {
  const settings = await getAdminFeeSettings();

  const result = calculateOnrampFee({
    amount,
    basePercent: settings.onrampFeePercent,
    minimumFeeUsd: settings.onrampMinimumFeeUsd ?? 0,
    tiers: settings.onrampFeeTiers ?? [],
    transactionMinimumUsd: USD_TRANSACTION_MINIMUM,
  });

  return {
    amount: money(amount),
    // The percentage actually charged, not the configured one. With a floor
    // applied these differ, and showing the configured rate would misstate
    // what the user is paying.
    feePercent: result.effectivePercent,
    feeAmount: result.feeAmount,
    netAmount: money(Number(result.netAmount), 6),
    /** Which rule produced the fee. Surfaced for support and admin display. */
    feeRule: result.appliedRule,
    feeExplanation: result.explanation,
  };
}
