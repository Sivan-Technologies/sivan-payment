import type { SupplierPayoutCurrency } from '../database/types.js';

export type SupplierExecutionProvider = 'bridge' | 'manual_treasury' | 'nomba' | 'eversend' | 'linkio' | 'circle' | 'yellowcard' | 'bvnk' | 'conduit';
export type SupplierExecutionMode = 'provider' | 'manual_review' | 'manual_treasury';

export type SupplierProviderRoute = {
  provider: SupplierExecutionProvider;
  fallbackProvider?: SupplierExecutionProvider;
  rail: string;
  executionMode: SupplierExecutionMode;
  reason: string;
};

export function routeSupplierPayout(input: { currency: SupplierPayoutCurrency; country?: string; accountType?: string }): SupplierProviderRoute {
  const currency = input.currency;
  if (currency === 'gbp') return { provider: 'bridge', fallbackProvider: 'manual_treasury', rail: 'faster_payments', executionMode: 'provider', reason: 'GBP supplier payout currently routes to Bridge Faster Payments when enabled.' };
  if (currency === 'usd') return { provider: 'bridge', fallbackProvider: 'manual_treasury', rail: 'ach', executionMode: 'provider', reason: 'USD supplier payout currently routes to Bridge ACH/Wire when enabled.' };
  if (currency === 'eur') return { provider: 'bridge', fallbackProvider: 'manual_treasury', rail: 'sepa', executionMode: 'provider', reason: 'EUR supplier payout currently routes to Bridge SEPA when enabled.' };
  if (currency === 'mxn') return { provider: 'bridge', fallbackProvider: 'manual_treasury', rail: 'spei', executionMode: 'provider', reason: 'MXN supplier payout currently routes to Bridge SPEI when enabled.' };
  if (currency === 'brl') return { provider: 'bridge', fallbackProvider: 'manual_treasury', rail: 'pix', executionMode: 'provider', reason: 'BRL supplier payout currently routes to Bridge PIX when enabled.' };
  return { provider: 'manual_treasury', rail: 'manual', executionMode: 'manual_treasury', reason: 'No automated provider route is configured for this supplier payout.' };
}
