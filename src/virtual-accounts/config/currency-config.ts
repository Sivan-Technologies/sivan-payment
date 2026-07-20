import type { VirtualAccountCurrency, VirtualAccountProviderName } from '../types/virtual-account.types.js';

export type VirtualAccountCurrencyConfig = {
  currency: VirtualAccountCurrency;
  label: string;
  country: string;
  accountType: 'us' | 'gb' | 'iban' | 'ngn';
  rails: string[];
  defaultProvider: VirtualAccountProviderName;
  enabled: boolean;
  requestable: boolean;
};

export const virtualAccountCurrencyConfig: Record<'usd' | 'gbp' | 'eur', VirtualAccountCurrencyConfig> = {
  usd: { currency: 'usd', label: 'USD — US bank account', country: 'US', accountType: 'us', rails: ['ach', 'wire'], defaultProvider: 'bridge', enabled: false, requestable: false },
  gbp: { currency: 'gbp', label: 'GBP — UK bank account', country: 'GB', accountType: 'gb', rails: ['faster_payments'], defaultProvider: 'bridge', enabled: false, requestable: false },
  eur: { currency: 'eur', label: 'EUR — SEPA / IBAN', country: 'EU', accountType: 'iban', rails: ['sepa'], defaultProvider: 'bridge', enabled: false, requestable: false },
};

export function getVirtualAccountCurrencyConfig(currency: VirtualAccountCurrency) {
  if (currency !== 'usd' && currency !== 'gbp' && currency !== 'eur') return undefined;
  return virtualAccountCurrencyConfig[currency];
}
