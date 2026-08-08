import { badRequest } from '../../shared/errors.js';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { getAdminFeeSettings } from '../../admin/admin-fees.service.js';
import type { Currency } from '../../database/types.js';
import { usdtSurchargePercentFor } from '../../suppliers/supplier-fee-policy.js';

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

export async function getDefaultOfframpFeePolicy(): Promise<FeePolicy> {
  const settings = await getAdminFeeSettings();
  const percent = normalizePercent(settings.offrampFeePercent);
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

export async function getBridgeCostPolicy(): Promise<CostPolicy> {
  const settings = await getAdminFeeSettings();
  return {
    bridgeOfframpCostPercent: normalizePercent(settings.bridgeOfframpCostPercent),
    bridgeKycCostUsd: toMoney(env.BRIDGE_KYC_COST_USD),
    bridgeKybCostUsd: toMoney(env.BRIDGE_KYB_COST_USD),
    note: 'These are configured business-cost assumptions from Bridge pricing. Confirm final billing in your Bridge agreement.'
  };
}

/**
 * Sivan's fee on fiat arriving through a virtual account, sent to Bridge as
 * developer_fee_percent at creation time.
 *
 * Bridge fixes this when the virtual account is provisioned, so it cannot be
 * corrected later for accounts already issued. Returns undefined when the fee
 * is zero so we omit the field rather than explicitly asking Bridge for 0%.
 */
export async function getVirtualAccountFeePercent(): Promise<string | undefined> {
  const settings = await getAdminFeeSettings();
  const percent = normalizePercent(settings.virtualAccountFeePercent);
  if (!(Number(percent) > 0)) return undefined;
  return percent;
}

/**
 * Rails a USD/GBP/EUR virtual account can receive on.
 *
 * GBP arrives only via faster_payments and EUR only via sepa, so for those two
 * a per-rail config is effectively per-currency. USD has both ach_push and
 * wire, which is the only place the distinction bites.
 */
const CAPPED_RAILS = ['ach_push', 'faster_payments', 'sepa'] as const;

export interface VirtualAccountFeeSelection {
  /** Send exactly one of these to Bridge. They are mutually exclusive. */
  developerFeePercent?: string;
  feeConfig?: { source: Record<string, Record<string, string>> };
  /** Why this shape was chosen, for logging and for the admin UI. */
  reason: string;
}

/**
 * Decide how to express the virtual account fee to Bridge.
 *
 * Bridge offers two mutually exclusive shapes, and their docs are explicit
 * that "updating developer_fee_percent clears fee_config, and updating
 * fee_config clears developer_fee_percent". Sending both in one request is
 * rejected. So the choice is made here, once, rather than at each call site
 * where the two could drift apart and silently wipe each other.
 *
 * fee_config is beta and gated per developer account. Sending it before Bridge
 * enables it fails the whole provisioning call with
 * `"fee_config": "is not yet available"` - verified against sandbox on
 * 2026-07-29. A floor or cap is therefore ignored unless
 * virtualAccountFeeConfigEnabled is explicitly true, so a half-configured
 * setting degrades to a working plain percentage instead of breaking
 * provisioning entirely.
 */
/**
 * The floor below which a virtual account must not be provisioned.
 *
 * Bridge fixes developer_fee_percent AT CREATION. Every deposit that lands
 * afterwards is billed at whatever was set then, and none of it can be
 * reclaimed - PUT /virtual_accounts can change the figure for FUTURE deposits
 * only. So a virtual account created at 0% is not a setting to correct later,
 * it is permanent revenue loss on that account for as long as the user keeps
 * depositing.
 *
 * Which is exactly what happened: virtualAccountFeePercent falls back to
 * SIVAN_OFFRAMP_FEE_PERCENT, that defaulted to 0, and getVirtualAccountFeeSelection()
 * returned `{ reason: 'No virtual account fee configured' }` with no fee at
 * all - a clean, well-worded, revenue-free provisioning.
 */
export const MINIMUM_VIRTUAL_ACCOUNT_FEE_PERCENT = 1.25;

/**
 * Refuse to provision a virtual account with no fee, or below the floor.
 *
 * THROWS rather than defaulting silently. Substituting 1.25% here would work
 * for the first account and hide a misconfiguration that an operator needs to
 * see - and the fee is unreclaimable, so "worked but wrong" is the expensive
 * outcome. Failing the request is recoverable; a wrong permanent fee is not.
 */
export async function assertVirtualAccountFeeConfigured(): Promise<number> {
  const settings = await getAdminFeeSettings();
  const percent = Number(settings.virtualAccountFeePercent);

  if (!Number.isFinite(percent) || percent < MINIMUM_VIRTUAL_ACCOUNT_FEE_PERCENT) {
    throw badRequest(
      `Virtual account fee is ${Number.isFinite(percent) ? `${percent}%` : 'not set'}, below the required ` +
      `minimum of ${MINIMUM_VIRTUAL_ACCOUNT_FEE_PERCENT}%. Bridge fixes this fee when the account is created ` +
      `and it cannot be reclaimed on deposits already received, so provisioning is refused rather than ` +
      `locking in a fee that earns nothing. Set virtualAccountFeePercent in Admin > Fees, or ` +
      `BRIDGE_VIRTUAL_ACCOUNT_DEVELOPER_FEE_PERCENT, then retry.`
    );
  }

  return percent;
}

export async function getVirtualAccountFeeSelection(): Promise<VirtualAccountFeeSelection> {
  const settings = await getAdminFeeSettings();
  const percent = normalizePercent(settings.virtualAccountFeePercent);

  if (!(Number(percent) > 0)) {
    return { reason: 'No virtual account fee configured; Bridge treats a missing fee as 0%.' };
  }

  const min = Number(settings.virtualAccountMinimumFeeUsd ?? 0);
  const max = Number(settings.virtualAccountMaximumFeeUsd ?? 0);
  const wantsLimits = min > 0 || max > 0;

  if (!wantsLimits) {
    return {
      developerFeePercent: percent,
      reason: `Flat ${percent}% with no floor or cap.`,
    };
  }

  if (!settings.virtualAccountFeeConfigEnabled) {
    // Deliberately degrade rather than fail. An operator who sets a floor
    // before Bridge enables the feature should still get working virtual
    // accounts, and should be told plainly why the floor is not applied.
    return {
      developerFeePercent: percent,
      reason:
        `Floor/cap ignored: Bridge has not enabled fee_config for this account. ` +
        `Falling back to a flat ${percent}%. Request enablement from Bridge, then set ` +
        `virtualAccountFeeConfigEnabled.`,
    };
  }

  // A cap below Bridge's own uncapped 0.50% orchestration cost turns large
  // deposits into a loss. Surfaced rather than silently accepted.
  const lossAbove = max > 0 ? max / 0.005 : Infinity;

  const params: Record<string, string> = { fee_percent: percent };
  if (min > 0) params.minimum_fee = min.toFixed(2);

  const source: Record<string, Record<string, string>> = {};
  for (const rail of CAPPED_RAILS) {
    source[rail] = max > 0 ? { ...params, maximum_fee: max.toFixed(2) } : { ...params };
  }
  // Wire is left uncapped on purpose: large deposits arrive this way, and
  // Bridge's cost on them is uncapped too.
  source.wire = { fee_percent: percent, ...(min > 0 ? { minimum_fee: Math.max(min, 5).toFixed(2) } : {}) };

  return {
    feeConfig: { source },
    reason:
      `${percent}% with ${min > 0 ? `$${min.toFixed(2)} floor` : 'no floor'}` +
      `${max > 0 ? `, $${max.toFixed(2)} cap on ACH/FPS/SEPA (loss above a $${lossAbove.toLocaleString()} deposit), wire uncapped` : ''}.`,
  };
}

export async function getLiquidationAddressFeePercent(input: {
  destinationCurrency: Currency;
  destinationPaymentRail: string;
  /**
   * The stablecoin being sold. Optional so existing callers keep compiling,
   * but supplying it is what makes USDT priced correctly.
   */
  sourceCurrency?: string;
}): Promise<string | undefined> {
  const policy = await getDefaultOfframpFeePolicy();
  if (!policy.enabled) return undefined;

  /**
   * USDT COSTS BRIDGE 0.10% MORE, AND THAT HAS TO REACH THE USER'S RATE.
   *
   * The parameter was `_input` - deliberately unused - because this fee is a
   * flat percentage fixed when the liquidation address is created. That is
   * true of the AMOUNT (no amount exists yet, so no floor or tier is possible)
   * but NOT of the asset: the address is created for one specific source
   * currency, so the asset is knowable at exactly the moment Bridge wants the
   * number.
   *
   * Without this, a USDT withdrawal was quoted the USDC rate and earned 0.10%
   * less than the fee table claimed, on every single withdrawal, invisibly.
   *
   * PASSED THROUGH TO THE USER rather than absorbed: a surcharge Sivan swallows
   * is a margin leak that grows with USDT adoption, and the alternative -
   * quietly making USDT less profitable than USDC - is the kind of thing
   * nobody notices until the monthly reconciliation.
   */
  const surcharge = usdtSurchargePercentFor(input.sourceCurrency);
  if (surcharge <= 0) return policy.percent;

  const withSurcharge = Number(policy.percent) + surcharge;
  // Bridge accepts at most 2 decimals on custom_developer_fee_percent.
  return (Math.round(withSurcharge * 100) / 100).toFixed(2);
}

export async function estimateFee(input: z.infer<typeof feeEstimateSchema>) {
  const policy = await getDefaultOfframpFeePolicy();
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

export async function estimateEconomics(input: z.infer<typeof economicsEstimateSchema>) {
  const amount = Number(input.amount);
  const thirdPartyRailFee = Number(input.thirdPartyRailFee);
  const sivanFeePercent = Number((await getDefaultOfframpFeePolicy()).percent);
  const bridgeOfframpCostPercent = Number((await getBridgeCostPolicy()).bridgeOfframpCostPercent);
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
