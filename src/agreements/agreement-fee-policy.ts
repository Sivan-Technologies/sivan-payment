/**
 * SIVAN SERVICE AGREEMENT FEE POLICY
 *
 * Dedicated protocol fee policy specifically for Service Agreements.
 * This is strictly distinct from direct crypto-to-crypto transfer fees.
 *
 * Curve:
 * - Every chain: 2.0% platform fee, floor $0.50, cap $50.00
 *
 * Fee Allocation:
 * - 'buyer':  Buyer pays amount + fee; Seller receives amount.
 * - 'seller': Buyer pays amount;       Seller receives amount - fee.
 * - 'split':  Fee is split 50/50.
 *
 * Pure, deterministic, and fully tested.
 */

export type FeePayer = 'buyer' | 'seller' | 'split';

export interface ServiceAgreementFeeConfig {
  percent: number;
  fixedUsd?: number;
  minimumUsd: number;
  maximumUsd: number;
}

export interface ServiceAgreementFeeQuote {
  amount: number;
  feeAmount: number;
  feePercent: number;
  feePayer: FeePayer;
  buyerTotalPayable: number;
  sellerNetAmount: number;
  appliedRule: 'percent' | 'minimum' | 'maximum';
  explanation: string;
}

/**
 * Service Agreement fee: 2.0 percent, floor $0.50, cap $50.00.
 *
 * ONE RATE ON EVERY CHAIN. This deliberately differs from the TRANSFER fee in
 * transfer-fee-policy.ts, which does vary per chain (floor $0.10 on Arc, Celo,
 * Stellar and Starknet, $0.25 elsewhere) because per-transfer gas is a real
 * cost that differs by rail.
 *
 * An agreement fee is not priced against gas. It is priced against the work
 * the protocol does around the money: holding funds through a delivery review
 * window, arbitration, and the dispute trail. That work is identical whichever
 * chain settles it, so charging Celo less for it was never justified by cost.
 *
 * HISTORY, because the old numbers are still quoted in places. This was
 * previously 1.0 percent standard with a 0.75 percent "micro-rail" discount on
 * Celo and Stellar. Two problems with that: the discount had no cost basis, and
 * the `main` branch had already flattened both constants to 1.0 percent while
 * leaving a docblock promising 0.75, so the code and its own comment disagreed.
 * Collapsing to a single rate removes both the unjustified discount and the
 * drift.
 */
export const DEFAULT_AGREEMENT_FEE_CONFIG: ServiceAgreementFeeConfig = {
  percent: 2.0,
  minimumUsd: 0.50,
  maximumUsd: 50.00,
};

/**
 * Resolve the agreement fee for a network.
 *
 * The `network` parameter is retained because every caller already passes it
 * and because a future rail may justify a different rate. It is currently
 * unused BY DESIGN rather than by accident, which is the distinction that was
 * missing the last time this function ignored its own argument.
 */
export function resolveAgreementFeeConfig(_network?: string): ServiceAgreementFeeConfig {
  return { ...DEFAULT_AGREEMENT_FEE_CONFIG };
}

export function quoteServiceAgreementFee(
  amount: number,
  network?: string,
  feePayer: FeePayer = 'buyer',
  customConfig?: Partial<ServiceAgreementFeeConfig>
): ServiceAgreementFeeQuote {
  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const baseConfig = resolveAgreementFeeConfig(network);
  const config: ServiceAgreementFeeConfig = {
    percent: customConfig?.percent ?? baseConfig.percent,
    minimumUsd: customConfig?.minimumUsd ?? baseConfig.minimumUsd,
    maximumUsd: customConfig?.maximumUsd ?? baseConfig.maximumUsd,
  };

  const fixedFee = customConfig?.fixedUsd ?? baseConfig.fixedUsd ?? 0;
  const raw = safeAmount * (config.percent / 100) + fixedFee;
  let fee = raw;
  let appliedRule: ServiceAgreementFeeQuote['appliedRule'] = 'percent';

  if (config.minimumUsd > 0 && fee < config.minimumUsd) {
    fee = config.minimumUsd;
    appliedRule = 'minimum';
  }

  if (config.maximumUsd > 0 && fee > config.maximumUsd) {
    fee = config.maximumUsd;
    appliedRule = 'maximum';
  }

  // Round to 6 decimal places for stablecoin precision
  const roundedFee = parseFloat(fee.toFixed(6));
  let buyerTotalPayable = safeAmount;
  let sellerNetAmount = safeAmount;

  if (feePayer === 'buyer') {
    buyerTotalPayable = parseFloat((safeAmount + roundedFee).toFixed(6));
    sellerNetAmount = safeAmount;
  } else if (feePayer === 'seller') {
    buyerTotalPayable = safeAmount;
    sellerNetAmount = Math.max(0, parseFloat((safeAmount - roundedFee).toFixed(6)));
  } else if (feePayer === 'split') {
    const halfFee = parseFloat((roundedFee / 2).toFixed(6));
    buyerTotalPayable = parseFloat((safeAmount + halfFee).toFixed(6));
    sellerNetAmount = Math.max(0, parseFloat((safeAmount - halfFee).toFixed(6)));
  }

  const effectivePercent = safeAmount > 0
    ? parseFloat(((roundedFee / safeAmount) * 100).toFixed(3))
    : 0;

  const formulaDesc = fixedFee > 0
    ? `${config.percent}% + $${fixedFee.toFixed(2)}`
    : `${config.percent}%`;

  const explanation = appliedRule === 'minimum'
    ? `$${config.minimumUsd.toFixed(2)} Sivan service agreement platform fee minimum applied.`
    : appliedRule === 'maximum'
    ? `$${config.maximumUsd.toFixed(2)} Sivan service agreement platform fee cap applied.`
    : `${formulaDesc} Sivan service agreement platform fee ($${roundedFee.toFixed(2)}).`;

  return {
    amount: safeAmount,
    feeAmount: roundedFee,
    feePercent: effectivePercent,
    feePayer,
    buyerTotalPayable,
    sellerNetAmount,
    appliedRule,
    explanation,
  };
}
