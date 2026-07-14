import { env } from '../config/env.js';
import type { Chain, Currency, SourceCurrency } from '../database/types.js';

export type ComplianceModel = 'first_party_withdrawal' | 'third_party_payout' | 'b2b_supplier_payout';
export type ProviderSpeed = 'standard' | 'same_day' | 'instant';
export type ProviderReliability = 'low' | 'medium' | 'high';

export interface OfframpProviderSelectionContext {
  sourceCurrency?: SourceCurrency;
  sourceChain?: Chain;
  destinationCurrency?: Currency;
  destinationCountry?: string;
  destinationPaymentRail?: string;
  amountUsd?: string;
  complianceModel?: ComplianceModel;
  requiredSpeed?: ProviderSpeed;
  preferredProvider?: string;
}

export interface ProviderCapability {
  name: string;
  available: boolean;
  sourceCurrencies: SourceCurrency[];
  sourceChains: Chain[];
  destinationCurrencies: Currency[];
  destinationCountries: string[] | 'global';
  destinationPaymentRails: string[];
  complianceModels: ComplianceModel[];
  speed: ProviderSpeed;
  reliability: ProviderReliability;
  priority: number;
  notes?: string;
}

export interface ProviderRoutingDecision {
  providerName: string;
  reason: string;
  matchedCapability: ProviderCapability;
  evaluatedProviders: Array<{
    providerName: string;
    available: boolean;
    matched: boolean;
    reasons: string[];
  }>;
}

export const providerCapabilities: ProviderCapability[] = [
  {
    name: 'bridge',
    available: true,
    sourceCurrencies: ['usdc'],
    sourceChains: ['ethereum', 'polygon', 'base', 'solana', 'arbitrum', 'optimism', 'avalanche'],
    destinationCurrencies: ['usd', 'gbp', 'eur'],
    destinationCountries: 'global',
    destinationPaymentRails: ['ach', 'wire', 'faster_payments', 'sepa', 'sepa_instant'],
    complianceModels: ['first_party_withdrawal'],
    speed: 'standard',
    reliability: 'high',
    priority: 100,
    notes: 'Current MVP provider for USDC to USD/GBP first-party bank withdrawals. Supports Avalanche C-Chain as source.'
  }
];

export function chooseOfframpProvider(context: OfframpProviderSelectionContext = {}): ProviderRoutingDecision {
  const preferredProvider = context.preferredProvider || env.DEFAULT_OFFRAMP_PROVIDER;
  const evaluated = providerCapabilities.map((capability) => evaluateCapability(capability, context, preferredProvider));

  const matched = evaluated
    .filter((item) => item.available && item.matched)
    .sort((a, b) => {
      const aCapability = providerCapabilities.find((capability) => capability.name === a.providerName)!;
      const bCapability = providerCapabilities.find((capability) => capability.name === b.providerName)!;
      return bCapability.priority - aCapability.priority;
    });

  const selected = matched[0];
  if (!selected) {
    const reasons = evaluated.flatMap((item) => item.reasons.map((reason) => `${item.providerName}: ${reason}`));
    throw new Error(`No off-ramp provider available for this route. ${reasons.join('; ')}`);
  }

  const capability = providerCapabilities.find((item) => item.name === selected.providerName)!;
  return {
    providerName: selected.providerName,
    reason: buildDecisionReason(context, capability),
    matchedCapability: capability,
    evaluatedProviders: evaluated
  };
}

function evaluateCapability(capability: ProviderCapability, context: OfframpProviderSelectionContext, preferredProvider: string) {
  const reasons: string[] = [];

  if (!capability.available) reasons.push('provider unavailable');
  if (preferredProvider && capability.name !== preferredProvider) reasons.push(`not preferred provider ${preferredProvider}`);
  if (context.sourceCurrency && !capability.sourceCurrencies.includes(context.sourceCurrency)) reasons.push(`unsupported source currency ${context.sourceCurrency}`);
  if (context.sourceChain && !capability.sourceChains.includes(context.sourceChain)) reasons.push(`unsupported source chain ${context.sourceChain}`);
  if (context.destinationCurrency && !capability.destinationCurrencies.includes(context.destinationCurrency)) reasons.push(`unsupported destination currency ${context.destinationCurrency}`);
  if (context.destinationCountry && capability.destinationCountries !== 'global' && !capability.destinationCountries.includes(context.destinationCountry)) reasons.push(`unsupported destination country ${context.destinationCountry}`);
  if (context.destinationPaymentRail && !capability.destinationPaymentRails.includes(context.destinationPaymentRail)) reasons.push(`unsupported payment rail ${context.destinationPaymentRail}`);
  if (context.complianceModel && !capability.complianceModels.includes(context.complianceModel)) reasons.push(`unsupported compliance model ${context.complianceModel}`);
  if (context.requiredSpeed && !speedSatisfies(capability.speed, context.requiredSpeed)) reasons.push(`speed ${capability.speed} does not satisfy ${context.requiredSpeed}`);

  return {
    providerName: capability.name,
    available: capability.available,
    matched: reasons.length === 0,
    reasons: reasons.length ? reasons : ['matched']
  };
}

function speedSatisfies(providerSpeed: ProviderSpeed, requiredSpeed: ProviderSpeed): boolean {
  const score: Record<ProviderSpeed, number> = {
    standard: 1,
    same_day: 2,
    instant: 3
  };
  return score[providerSpeed] >= score[requiredSpeed];
}

function buildDecisionReason(context: OfframpProviderSelectionContext, capability: ProviderCapability): string {
  const parts = [
    `selected ${capability.name}`,
    context.destinationCurrency ? `currency=${context.destinationCurrency}` : undefined,
    context.destinationPaymentRail ? `rail=${context.destinationPaymentRail}` : undefined,
    context.destinationCountry ? `country=${context.destinationCountry}` : undefined,
    context.complianceModel ? `compliance=${context.complianceModel}` : undefined,
    `reliability=${capability.reliability}`,
    `speed=${capability.speed}`
  ].filter(Boolean);

  return parts.join(', ');
}
