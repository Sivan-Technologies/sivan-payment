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
import { VtuAggregatorProvider } from './vtu-aggregator.provider.js';
import { MockUtilityProvider } from './mock-utility.provider.js';

const registry = new Map<string, IUtilityProvider>();

// Register out-of-the-box providers with default priorities
registry.set('paystack', new PaystackUtilityProvider());
registry.set('vtu_ng', new VtuAggregatorProvider({ name: 'vtu_ng', priority: 15 }));
registry.set('nomba', new MockUtilityProvider());

/**
 * Registers or overrides a utility provider adapter.
 */
export function registerUtilityProvider(provider: IUtilityProvider): void {
  registry.set(provider.name.toLowerCase(), provider);
}

let runtimeActiveProvider: string | null = null;

/**
 * Returns the active or requested utility provider.
 * Sourced dynamically from environment variable or explicit override.
 */
export function getUtilityProvider(name?: string): IUtilityProvider {
  const targetName = (name || getActiveUtilityProviderName()).toLowerCase();
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
 * Returns all active providers sorted by priority descending.
 * If preferredName is provided, it is placed at the head of the chain.
 */
export function getUtilityProviderChain(preferredName?: string): IUtilityProvider[] {
  const all = Array.from(registry.values());
  const sorted = [...all].sort((a, b) => (b.priority ?? 10) - (a.priority ?? 10));

  if (!preferredName) return sorted;

  const target = preferredName.toLowerCase();
  const preferred = sorted.find((p) => p.name.toLowerCase() === target);
  if (!preferred) return sorted;

  return [preferred, ...sorted.filter((p) => p.name.toLowerCase() !== target)];
}

/**
 * Executes a utility operation with automated multi-aggregator failover.
 * If the primary provider fails due to timeout, insufficient float, or upstream outage,
 * Sivan payment Ai automatically attempts the next registered provider in the chain.
 */
export async function executeUtilityWithFailover<T>(
  operation: (provider: IUtilityProvider) => Promise<T>,
  preferredName?: string
): Promise<{ result: T; providerName: string }> {
  const chain = getUtilityProviderChain(preferredName);
  let lastError: any = null;

  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];
    try {
      const result = await operation(provider);
      return { result, providerName: provider.name };
    } catch (err: any) {
      lastError = err;
      const nextProvider = chain[i + 1];
      if (nextProvider) {
        console.warn(
          `[utility-failover] Provider "${provider.name}" failed: ${err?.message || err}. Failing over to "${nextProvider.name}"...`
        );
      }
    }
  }

  throw lastError || new Error('All registered utility providers failed.');
}

/**
 * Lists all registered utility providers.
 */
export function listUtilityProviders(): string[] {
  return Array.from(registry.keys());
}

/**
 * Sets the active utility provider at runtime.
 */
export function setActiveUtilityProviderName(name: string): void {
  const clean = name.toLowerCase().trim();
  if (registry.has(clean)) {
    runtimeActiveProvider = clean;
  } else {
    throw new Error(`Provider "${name}" is not registered in Sivan utility registry.`);
  }
}

/**
 * Resolves the currently active utility provider name.
 */
export function getActiveUtilityProviderName(): string {
  return runtimeActiveProvider || (process.env.UTILITY_PROVIDER || 'paystack').toLowerCase();
}
