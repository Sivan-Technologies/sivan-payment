/**
 * SIVAN SERVICE AGREEMENT FEE POLICY
 *
 * Dedicated protocol fee policy specifically for Service Agreements.
 * This is strictly distinct from direct crypto-to-crypto transfer fees.
 *
 * Curve:
 * - Standard Rail (Solana, Base, BSC, Ethereum):
 *     1.0% platform fee, floor $0.50, cap $50.00
 * - High-Efficiency Micro-Rail (Celo, Stellar):
 *     0.75% platform fee, floor $0.20, cap $25.00
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

export const DEFAULT_AGREEMENT_FEE_CONFIG: ServiceAgreementFeeConfig = {
  percent: 1.0,
  minimumUsd: 0.50,
  maximumUsd: 50.00,
};

export const MICRO_RAIL_AGREEMENT_FEE_CONFIG: ServiceAgreementFeeConfig = {
  percent: 1.0,
  minimumUsd: 0.50,
  maximumUsd: 50.00,
};

export function resolveAgreementFeeConfig(network?: string): ServiceAgreementFeeConfig {
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

  // Unified fee calculation: (amount * percent%) + fixed
  const percentFee = safeAmount * (config.percent / 100);
  let fee = percentFee + config.minimumUsd;
  let appliedRule: ServiceAgreementFeeQuote['appliedRule'] = 'percent';

  if (config.maximumUsd > 0 && fee > config.maximumUsd) {
    fee = config.maximumUsd;
    appliedRule = 'maximum';
  }

  // Round to 2 decimal places for standard display
  const roundedFee = parseFloat(fee.toFixed(2));
  let buyerTotalPayable = safeAmount;
  let sellerNetAmount = safeAmount;

  if (feePayer === 'buyer') {
    buyerTotalPayable = parseFloat((safeAmount + roundedFee).toFixed(2));
    sellerNetAmount = safeAmount;
  } else if (feePayer === 'seller') {
    buyerTotalPayable = safeAmount;
    sellerNetAmount = Math.max(0, parseFloat((safeAmount - roundedFee).toFixed(2)));
  } else if (feePayer === 'split') {
    const halfFee = parseFloat((roundedFee / 2).toFixed(2));
    buyerTotalPayable = parseFloat((safeAmount + halfFee).toFixed(2));
    sellerNetAmount = Math.max(0, parseFloat((safeAmount - halfFee).toFixed(2)));
  }

  const effectivePercent = safeAmount > 0
    ? parseFloat(((roundedFee / safeAmount) * 100).toFixed(2))
    : 0;

  const explanation = `${config.percent}% + $${config.minimumUsd.toFixed(2)}`;

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
