/**
 * DVA INFLOW FEE CALCULATOR
 *
 * Extracted from paystackWebhookHandler.ts so that NGN agreement runtime
 * logic has zero direct Paystack imports. The fee policy itself is
 * Sivan-owned (not Paystack-owned), so it belongs here.
 *
 * Policy (CBN-compliant, 2024):
 *   - Under 3,000 NGN: 0% fee (free tier)
 *   - 3,000 NGN and above: 1.3% of gross, capped at 500 NGN
 *
 * Both paystackWebhookHandler.ts and runtime.ts now import from this file.
 */

/**
 * Calculate Sivan's platform fee on an inbound DVA deposit.
 * All values in NGN (not kobo).
 */
export function calculateDvaInflowFee(grossNgn: number): {
  feeNgn: number;
  netNgn: number;
} {
  if (grossNgn < 3000) {
    return { feeNgn: 0, netNgn: grossNgn };
  }
  const rawFee = grossNgn * 0.013;
  const feeNgn = Math.min(500, Math.round(rawFee * 100) / 100);
  const netNgn = Math.round((grossNgn - feeNgn) * 100) / 100;
  return { feeNgn, netNgn };
}
