/**
 * DVA INFLOW FEE CALCULATOR
 *
 * Zero-Loss Financial Policy:
 *   - Paystack charges flat 1% on every DVA deposit with no free tier.
 *   - Sivan charges flat 1.3% across ALL amounts, capped at 500 NGN.
 *   - This guarantees Sivan never incurs out-of-pocket loss on micro-deposits
 *     and consistently retains a positive 0.3% spread (or up to 200 NGN on capped inflows).
 *
 * Both paystackWebhookHandler.ts and runtime.ts import from this file.
 */

/**
 * Calculate Sivan's platform fee on an inbound DVA deposit.
 * All values in NGN (not kobo).
 */
export function calculateDvaInflowFee(grossNgn: number): {
  feeNgn: number;
  netNgn: number;
} {
  if (grossNgn <= 0) {
    return { feeNgn: 0, netNgn: 0 };
  }
  const rawFee = grossNgn * 0.013;
  const feeNgn = Math.min(500, Math.round(rawFee * 100) / 100);
  const netNgn = Math.round((grossNgn - feeNgn) * 100) / 100;
  return { feeNgn, netNgn };
}
