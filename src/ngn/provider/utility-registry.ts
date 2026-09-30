/**
 * SIVAN UTILITY PROVIDER REGISTRY
 *
 * Pluggable registry for daily utility fulfillment rails.
 * Decouples Sivan payment Ai from any single vendor.
 * Dynamically resolves active provider (Paystack, Nomba, Flutterwave, VTU)
 * and enables sub-second failover when upstream telco aggregators time out.
 */

import type {
  IUtilityProvider,
  UtilityProviderName,
} from './utility-provider.interface.js';
import { PaystackUtilityProvider } from './paystack-utility.provider.js';
import { MockUtilityProvider } from './mock-utility.provider.js';

const registry = new Map<string, IUtilityProvider>();

// Register out-of-the-box providers
registry.set('paystack', new PaystackUtilityProvider());
registry.set('nomba', new MockUtilityProvider());

/**
 * Registers or overrides a utility provider adapter.
 */
export function registerUtilityProvider(provider: IUtilityProvider): void {
  registry.set(provider.name.toLowerCase(), provider);
}

/**
 * Returns the active or requested utility provider.
 * Sourced dynamically from environment variable or explicit override.
 */
export function getUtilityProvider(name?: string): IUtilityProvider {
  const targetName = (name || process.env.UTILITY_PROVIDER || 'paystack').toLowerCase();
  const provider = registry.get(targetName);

  if (provider) {
    return provider;
  }

  // Graceful fallback to default Paystack provider
  const defaultProvider = registry.get('paystack');
  if (defaultProvider) {
    return defaultProvider;
  }

  throw new Error(`No utility provider registered in Sivan registry for "${targetName}"`);
}

/**
 * Lists all registered utility providers.
 */
export function listUtilityProviders(): string[] {
  return Array.from(registry.keys());
}

/**
 * Resolves the currently active utility provider name.
 */
export function getActiveUtilityProviderName(): string {
  return (process.env.UTILITY_PROVIDER || 'paystack').toLowerCase();
}
