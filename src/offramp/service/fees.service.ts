import { z } from 'zod';
import { env } from '../../config/env.js';
import type { Currency } from '../../database/types.js';

export const feeEstimateSchema = z.object({
  amount: z.string().regex(/^\d+(\.\d{1,6})?$/),
  currency: z.enum(['usd', 'gbp', 'eur']).default('usd')
});

export const economicsEstimateSchema = feeEstimateSchema.extend({
  customerType: z.enum(['individual', 'business']).default('individual'),
  includeOnboardingCost: z.boolean().default(false),
  thirdPartyRailFee: z.string().regex(/^\d+(\.\d{1,6})?$/).default('0')
});

export interface FeePolicy {
  id: string;
  name: string;
  type: 'percentage';
  percent: string;
  appliesTo: 'liquidation_address';
  settlement: 'bridge_monthly_usd';
  enabled: boolean;
}

export interface CostPolicy {
  bridgeOfframpCostPercent: string;
  bridgeKycCostUsd: string;
  bridgeKybCostUsd: string;
  note: string;
}

export function getDefaultOfframpFeePolicy(): FeePolicy {
  const percent = normalizePercent(env.SIVAN_OFFRAMP_FEE_PERCENT);
  return {
    id: 'default_offramp_fee',
    name: 'Default Sivan off-ramp fee',
    type: 'percentage',
    percent,
    appliesTo: 'liquidation_address',
    settlement: 'bridge_monthly_usd',
    enabled: Number(percent) > 0
  };
}

export function getBridgeCostPolicy(): CostPolicy {
  return {
    bridgeOfframpCostPercent: normalizePercent(env.BRIDGE_OFFRAMP_COST_PERCENT),
    bridgeKycCostUsd: toMoney(env.BRIDGE_KYC_COST_USD),
    bridgeKybCostUsd: toMoney(env.BRIDGE_KYB_COST_USD),
    note: 'These are configured business-cost assumptions from Bridge pricing. Confirm final billing in your Bridge agreement.'
  };
}

export function getLiquidationAddressFeePercent(_input: {
  destinationCurrency: Currency;
  destinationPaymentRail: string;
}): string | undefined {
  const policy = getDefaultOfframpFeePolicy();
  if (!policy.enabled) return undefined;
  return policy.percent;
}

export function estimateFee(input: z.infer<typeof feeEstimateSchema>) {
  const policy = getDefaultOfframpFeePolicy();
  const amount = Number(input.amount);
  const percent = Number(policy.percent);
  const fee = policy.enabled ? amount * (percent / 100) : 0;
  const net = Math.max(amount - fee, 0);

  return {
    amount: toMoney(amount),
    currency: input.currency,
    feePercent: policy.percent,
    estimatedFeeAmount: toMoney(fee),
    estimatedNetAmount: toMoney(net),
    note: 'This is an estimate. Final fee is calculated by Bridge when the liquidation-address drain is processed.'
  };
}

export function estimateEconomics(input: z.infer<typeof economicsEstimateSchema>) {
  const amount = Number(input.amount);
  const thirdPartyRailFee = Number(input.thirdPartyRailFee);
  const sivanFeePercent = Number(getDefaultOfframpFeePolicy().percent);
  const bridgeOfframpCostPercent = Number(getBridgeCostPolicy().bridgeOfframpCostPercent);
  const onboardingCost = input.includeOnboardingCost
    ? input.customerType === 'business'
      ? env.BRIDGE_KYB_COST_USD
      : env.BRIDGE_KYC_COST_USD
    : 0;

  const sivanRevenue = amount * (sivanFeePercent / 100);
  const bridgeVariableCost = amount * (bridgeOfframpCostPercent / 100);
  const totalCost = bridgeVariableCost + onboardingCost + thirdPartyRailFee;
  const contributionMargin = sivanRevenue - totalCost;
  const customerNetBeforeRailFees = Math.max(amount - sivanRevenue, 0);
  const marginPercentOfVolume = amount > 0 ? (contributionMargin / amount) * 100 : 0;

  const variableSpreadPercent = sivanFeePercent - bridgeOfframpCostPercent;
  const onboardingBreakEvenVolume = variableSpreadPercent > 0
    ? onboardingCost / (variableSpreadPercent / 100)
    : null;

  return {
    amount: toMoney(amount),
    currency: input.currency,
    customerType: input.customerType,
    includeOnboardingCost: input.includeOnboardingCost,
    revenue: {
      sivanFeePercent: normalizePercent(sivanFeePercent),
      estimatedSivanFeeRevenue: toMoney(sivanRevenue)
    },
    costs: {
      bridgeOfframpCostPercent: normalizePercent(bridgeOfframpCostPercent),
      estimatedBridgeOfframpCost: toMoney(bridgeVariableCost),
      onboardingCost: toMoney(onboardingCost),
      thirdPartyRailFee: toMoney(thirdPartyRailFee),
      estimatedTotalCost: toMoney(totalCost)
    },
    user: {
      estimatedNetPayoutBeforeThirdPartyRailFees: toMoney(customerNetBeforeRailFees)
    },
    margin: {
      estimatedContributionMargin: toMoney(contributionMargin),
      marginPercentOfVolume: normalizePercent(marginPercentOfVolume),
      onboardingBreakEvenVolume: onboardingBreakEvenVolume === null ? null : toMoney(onboardingBreakEvenVolume)
    },
    note: 'This is a business estimate only. Bridge final invoice, FX, gas, ACH/wire, failed checks, or enhanced due diligence may change actual cost.'
  };
}

function normalizePercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  return Number(value.toFixed(6)).toString();
}

function toMoney(value: number): string {
  return value.toFixed(2);
}
