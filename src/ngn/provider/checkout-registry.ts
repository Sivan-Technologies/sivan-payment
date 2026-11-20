/**
 * SIVAN CHECKOUT PROVIDER REGISTRY
 *
 * Central factory for resolving checkout providers dynamically.
 * Reads environment variable CHECKOUT_PROVIDER ('nomba' | '9psb' | 'paystack')
 * without requiring any code changes to switch rails.
 */

import type { ICheckoutProvider, CheckoutProviderName } from './checkout-provider.interface.js';
import { NombaCheckoutProvider } from './nomba-checkout.provider.js';
import { NinePsbCheckoutProvider } from './ninepsb-checkout.provider.js';
import { PaystackCheckoutProvider } from './paystack-checkout.provider.js';

export interface CheckoutProviderInfo {
  name: CheckoutProviderName;
  isConfigured: boolean;
  isDefault: boolean;
}

export function getDefaultCheckoutProviderName(): CheckoutProviderName {
  const envProvider = (process.env.CHECKOUT_PROVIDER || '').trim().toLowerCase();
  if (envProvider) return envProvider;
  return 'nomba';
}

export function getCheckoutProvider(name?: string): ICheckoutProvider {
  const targetName = (name || getDefaultCheckoutProviderName()).trim().toLowerCase();

  switch (targetName) {
    case 'nomba':
      return new NombaCheckoutProvider();
    case '9psb':
    case 'ninepsb':
      return new NinePsbCheckoutProvider();
    case 'paystack':
      return new PaystackCheckoutProvider();
    default:
      throw new Error(
        `Unknown checkout provider '${targetName}'. Supported providers: nomba, 9psb, paystack.`
      );
  }
}

export function listAvailableCheckoutProviders(): CheckoutProviderInfo[] {
  const defaultName = getDefaultCheckoutProviderName();
  const providers: ICheckoutProvider[] = [
    new NombaCheckoutProvider(),
    new NinePsbCheckoutProvider(),
    new PaystackCheckoutProvider(),
  ];

  return providers.map((p) => ({
    name: p.name,
    isConfigured: p.isConfigured(),
    isDefault: p.name === defaultName,
  }));
}
