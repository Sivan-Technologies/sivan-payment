/**
 * SIVAN UTILITY PROVIDER REGISTRY
 *
 * Pluggable registry for daily utility fulfilment rails.
 *
 * ROUTING IS PER SERVICE, NOT GLOBAL.
 *
 * There is no single "active provider" any more. Each of the three services -
 * airtime, data, electricity - has its own ordered chain of providers, so
 * airtime and data can be moved between aggregators while electricity stays
 * where it is. The chain is persisted (see utility-routing.service) rather
 * than held in a module variable, so a switch survives a restart and applies
 * to every instance.
 *
 * Three rules the old registry did not enforce:
 *
 *  1. CAPABILITY. A provider is only eligible for a service it declares in
 *     `supports` and for which it actually implements the method. That is what
 *     stops an airtime-only aggregator being handed an electricity meter and
 *     replying with placeholder data.
 *
 *  2. FAILOVER IS OPT IN, PER SERVICE. Previously every operation walked every
 *     registered provider by priority, so electricity would silently fall over
 *     to a telco aggregator. Now a service with failover disabled attempts its
 *     primary only, and a failure is a failure.
 *
 *  3. NO SIMULATOR IN THE CHAIN. The mock provider used to sit in the live
 *     chain under the name "nomba", so an outage at the real providers ended
 *     in a fabricated success and a real debit. It is now registered only when
 *     UTILITY_ENABLE_MOCK_PROVIDER is explicitly set, and only under the name
 *     "mock".
 */

import type {
  IUtilityProvider,
  UtilityProviderName,
  UtilityServiceType,
} from './utility-provider.interface.js';
import { UTILITY_SERVICE_TYPES } from './utility-provider.interface.js';
import { PaystackUtilityProvider } from './paystack-utility.provider.js';
import { VtuAggregatorProvider } from './vtu-aggregator.provider.js';
import { SmeApiUtilityProvider } from './smeapi-utility.provider.js';
import { MockUtilityProvider } from './mock-utility.provider.js';
import {
  UtilityProviderError,
  canFailOver,
  type UtilityFailureReason,
} from './utility-provider.error.js';
import { alertFloatExhausted } from '../../monitoring/float-alert.js';
import {
  canAfford,
  recordFloatProbe,
  recordFloatSpend,
  recordFloatExhausted,
  refreshFloatInBackground,
} from './provider-float-cache.js';

const registry = new Map<string, IUtilityProvider>();

registry.set('paystack', new PaystackUtilityProvider());
registry.set('vtu_ng', new VtuAggregatorProvider({ name: 'vtu_ng', priority: 15 }));
registry.set('smeapi', new SmeApiUtilityProvider());

/**
 * The simulator is opt in. It fabricates successful fulfilment, so if it ever
 * reaches production traffic the customer is debited for nothing.
 */
if (String(process.env.UTILITY_ENABLE_MOCK_PROVIDER || '').toLowerCase() === 'true') {
  registry.set('mock', new MockUtilityProvider());
}

/** Registers or overrides a utility provider adapter. */
export function registerUtilityProvider(provider: IUtilityProvider): void {
  registry.set(provider.name.toLowerCase(), provider);
}

/** Lists all registered utility providers. */
export function listUtilityProviders(): string[] {
  return Array.from(registry.keys());
}

/** Lists providers together with the services each one can actually fulfil. */
export function listUtilityProviderCapabilities(): Array<{
  name: string;
  supports: readonly UtilityServiceType[];
  priority: number;
  configured: boolean;
}> {
  return Array.from(registry.entries()).map(([name, provider]) => ({
    name,
    supports: provider.supports ?? [],
    priority: provider.priority ?? 10,
    // Registered is not the same as usable. An adapter with no credentials
    // must be visibly unavailable rather than quietly selectable.
    configured: typeof provider.isConfigured === 'function' ? provider.isConfigured() : true,
  }));
}

/**
 * What each provider is actually holding, so the float stops being invisible.
 *
 * getWalletBalanceNgn is deliberately NOT on IUtilityProvider: a provider we
 * pay per transaction has a float, one we settle with later does not, and
 * forcing a balance onto every adapter would mean inventing a number for the
 * ones that have none. So it is probed structurally and reported honestly -
 * "not applicable" is a real answer here, and so is "we could not reach them".
 *
 * Failures are captured per provider rather than thrown, because a dashboard
 * that shows nothing when one upstream is down is worse than one that shows
 * three balances and an error.
 */
export async function getProviderFloatBalances(): Promise<
  Array<{
    provider: string;
    supportsFloat: boolean;
    balanceNgn: number | null;
    checkedAt: string;
    error: string | null;
  }>
> {
  const entries = Array.from(registry.entries());
  return Promise.all(
    entries.map(async ([name, provider]) => {
      const probe = (provider as { getWalletBalanceNgn?: () => Promise<number> }).getWalletBalanceNgn;
      const checkedAt = new Date().toISOString();
      if (typeof probe !== 'function') {
        return { provider: name, supportsFloat: false, balanceNgn: null, checkedAt, error: null };
      }
      try {
        const balanceNgn = await probe.call(provider);
        // An admin opening the dashboard warms the same cache routing reads,
        // so looking at the float also makes the next purchase better informed.
        recordFloatProbe(name, balanceNgn);
        return { provider: name, supportsFloat: true, balanceNgn, checkedAt, error: null };
      } catch (err: any) {
        return {
          provider: name,
          supportsFloat: true,
          balanceNgn: null,
          checkedAt,
          error: String(err?.message || err),
        };
      }
    })
  );
}

// ---------------------------------------------------------------------------
// Routing configuration
// ---------------------------------------------------------------------------

export interface UtilityRoutingConfig {
  /** Ordered chains. Index 0 is the primary; the rest are fallbacks. */
  routes: Record<UtilityServiceType, string[]>;
  /** Whether a service may walk past its primary. */
  failover: Record<UtilityServiceType, boolean>;
}

export const DEFAULT_UTILITY_ROUTING: UtilityRoutingConfig = {
  routes: {
    // Only providers that are actually credentialed here. These defaults
    // previously led with vtu_ng, which has no API key anywhere in the repo
    // or in render.yaml and whose base URL does not resolve, so any service
    // falling back to defaults would have routed first to a certain failure.
    airtime: ['smeapi', 'paystack'],
    data: ['smeapi', 'paystack'],
    electricity: ['paystack'],
  },
  failover: {
    airtime: true,
    data: true,
    // Electricity issues a meter token. A blind second attempt at another
    // provider is how a customer ends up paying twice for one token.
    electricity: false,
  },
};

let runtimeRouting: UtilityRoutingConfig | null = null;

/**
 * Normalises any stored or submitted routing config: unknown provider names
 * and providers that cannot serve the service are dropped, so a bad entry
 * degrades to the remaining chain instead of failing at purchase time.
 */
export function normaliseUtilityRouting(input: Partial<UtilityRoutingConfig> | null | undefined): UtilityRoutingConfig {
  const routes = {} as Record<UtilityServiceType, string[]>;
  const failover = {} as Record<UtilityServiceType, boolean>;

  for (const service of UTILITY_SERVICE_TYPES) {
    const requested = input?.routes?.[service];
    const chain = (Array.isArray(requested) ? requested : DEFAULT_UTILITY_ROUTING.routes[service])
      .map((name) => String(name).toLowerCase().trim())
      .filter((name, index, all) => name && all.indexOf(name) === index)
      .filter((name) => {
        const provider = registry.get(name);
        return Boolean(provider && providerServes(provider, service));
      });

    routes[service] = chain.length > 0 ? chain : [];
    const requestedFailover = input?.failover?.[service];
    failover[service] =
      typeof requestedFailover === 'boolean' ? requestedFailover : DEFAULT_UTILITY_ROUTING.failover[service];
  }

  return { routes, failover };
}

export function getUtilityRouting(): UtilityRoutingConfig {
  if (runtimeRouting) return runtimeRouting;
  const fromEnv = process.env.UTILITY_ROUTING;
  if (fromEnv) {
    try {
      return normaliseUtilityRouting(JSON.parse(fromEnv));
    } catch {
      console.warn('[utility-registry] UTILITY_ROUTING is not valid JSON, falling back to defaults.');
    }
  }
  return normaliseUtilityRouting(DEFAULT_UTILITY_ROUTING);
}

/** Applies a routing config in memory. Persistence lives in utility-routing.service. */
export function setUtilityRouting(config: Partial<UtilityRoutingConfig>): UtilityRoutingConfig {
  runtimeRouting = normaliseUtilityRouting(config);
  return runtimeRouting;
}

// ---------------------------------------------------------------------------
// Capability-aware resolution
// ---------------------------------------------------------------------------

const METHOD_FOR_SERVICE: Record<UtilityServiceType, Array<keyof IUtilityProvider>> = {
  airtime: ['purchaseAirtime'],
  data: ['purchaseDataBundle'],
  electricity: ['inquireElectricityMeter', 'payElectricityBill'],
};

/** True when a provider both declares a service and implements its methods. */
export function providerServes(provider: IUtilityProvider, service: UtilityServiceType): boolean {
  const declared = (provider.supports ?? []).includes(service);
  if (!declared) return false;
  return METHOD_FOR_SERVICE[service].every((method) => typeof (provider as any)[method] === 'function');
}

/**
 * Resolves the chain for a service: the configured providers in order, trimmed
 * to the primary when failover is off for that service.
 */
export function getProviderChainForService(service: UtilityServiceType): IUtilityProvider[] {
  const routing = getUtilityRouting();
  const names = routing.routes[service] ?? [];
  const chain = names
    .map((name) => registry.get(name))
    .filter((p): p is IUtilityProvider => Boolean(p && providerServes(p, service)));

  if (chain.length === 0) {
    throw new Error(
      `No provider is routed to "${service}". Configure it with PUT /api/admin/utilities/routing.`
    );
  }
  return routing.failover[service] ? chain : [chain[0]];
}

type ProviderWith<K extends keyof IUtilityProvider> = IUtilityProvider & Required<Pick<IUtilityProvider, K>>;

/**
 * Runs an operation against the chain configured for one service.
 *
 * Only providers that can serve the service are attempted, and the chain stops
 * at the primary unless failover is enabled for that service.
 */
export async function executeForService<K extends keyof IUtilityProvider, T>(
  service: UtilityServiceType,
  method: K,
  operation: (provider: ProviderWith<K>) => Promise<T>,
  options: {
    /**
     * What this purchase will cost US at the provider, when it is known.
     * Omitted for reads, and omitted when the wholesale cost has never been
     * synced - guessing it would mean skipping a provider over a number we
     * invented.
     */
    costNgn?: number;
  } = {}
): Promise<{ result: T; providerName: string }> {
  const fullChain = getProviderChainForService(service).filter(
    (provider) => typeof (provider as any)[method] === 'function'
  );

  /**
   * PRE-FLIGHT: skip a provider we already know cannot pay.
   *
   * This reads cached balances only and never calls the provider, so it adds
   * no latency and cannot fail. A refresh is kicked off in the background for
   * anything stale and this request does not wait for it.
   *
   * The guard below is the important half. "Unknown" is treated as yes, and
   * if the filter would empty the chain we fall back to the full one: a cache
   * that is wrong, stale or simply never populated must never be able to
   * refuse traffic that the provider would have accepted. The worst case is
   * the behaviour we had before - dispatch and be declined.
   */
  for (const provider of fullChain) {
    const probe = (provider as { getWalletBalanceNgn?: () => Promise<number> }).getWalletBalanceNgn;
    if (typeof probe === 'function') {
      refreshFloatInBackground(provider.name, () => probe.call(provider));
    }
  }

  const costNgn = options.costNgn;
  let chain = fullChain;
  if (typeof costNgn === 'number' && costNgn > 0 && fullChain.length > 0) {
    const affordable = fullChain.filter((provider) => canAfford(provider.name, costNgn) !== 'no');
    if (affordable.length > 0 && affordable.length < fullChain.length) {
      const skipped = fullChain.filter((p) => !affordable.includes(p)).map((p) => p.name);
      console.warn(
        `[utility-float] Skipping ${skipped.join(', ')} for ${service}: ` +
          `known float below the ${costNgn} NGN this purchase costs us.`
      );
      chain = affordable;
    } else if (affordable.length === 0) {
      // Every provider looks unaffordable. Attempt anyway rather than refusing
      // a customer on the strength of cached numbers that may all be stale.
      console.warn(
        `[utility-float] Every provider for ${service} looks short of ${costNgn} NGN. ` +
          `Attempting anyway rather than refusing on cached figures.`
      );
    }
  }

  if (chain.length === 0) {
    throw new Error(`No provider routed to "${service}" implements ${String(method)}.`);
  }

  let lastError: any = null;
  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];
    try {
      const result = await operation(provider as ProviderWith<K>);
      // Keep the estimate moving between probes so a drain shows up early
      // rather than at the moment a customer is declined.
      if (typeof costNgn === 'number' && costNgn > 0) {
        recordFloatSpend(provider.name, costNgn);
      }
      return { result, providerName: provider.name };
    } catch (err: any) {
      lastError = err;
      const next = chain[i + 1];
      const reason: UtilityFailureReason | null =
        err instanceof UtilityProviderError ? err.reason : null;

      /**
       * An empty float is a treasury problem, so it pages a human even when a
       * fallback absorbs it: the customer is served, but we are now one
       * provider deep with no margin, and nobody finds out unless we say so.
       */
      if (reason === 'provider_float_exhausted' && err instanceof UtilityProviderError) {
        // The provider declining for want of funds is the most reliable float
        // reading available, and it costs nothing extra to believe it.
        recordFloatExhausted(provider.name);
        void alertFloatExhausted({
          provider: provider.name,
          service,
          upstreamMessage: err.upstreamMessage,
          failedOverTo: next ? next.name : null,
        });
      }

      /**
       * NOT EVERY FAILURE MAY BE RETRIED ELSEWHERE.
       *
       * This loop used to treat any thrown value as a reason to try the next
       * provider. Two of those cases are wrong and one of them costs money:
       *
       *   - A timeout means we never learned the outcome. The first provider
       *     may already have delivered, so sending the same purchase to a
       *     second one risks paying twice for one sale. We stop and surface it
       *     for reconciliation instead of guessing.
       *   - A malformed phone number or an unmapped plan code is deterministic.
       *     The next provider rejects it for the same reason, so failing over
       *     only doubles the customer's wait before the identical answer.
       *
       * Everything else here is a provider that answered and declined, which
       * tells us it delivered nothing, so retrying elsewhere is safe.
       */
      if (reason && !canFailOver(reason)) {
        console.error(
          `[utility-failover] "${provider.name}" failed on ${service} with reason="${reason}". ` +
            `Not retrying on another provider: ${err?.message || err}`
        );
        throw err;
      }

      if (next) {
        console.warn(
          `[utility-failover] "${provider.name}" failed on ${service}: ${err?.message || err}. Trying "${next.name}".`
        );
      } else {
        console.error(`[utility-failover] "${provider.name}" failed on ${service} with no fallback: ${err?.message || err}`);
      }
    }
  }
  throw lastError || new Error(`All providers routed to "${service}" failed.`);
}

// ---------------------------------------------------------------------------
// Legacy helpers
// ---------------------------------------------------------------------------

/**
 * Returns a named provider, or the primary for a service when no name is
 * given. Retained for callers that predate per-service routing.
 */
export function getUtilityProvider(name?: string): IUtilityProvider {
  const target = (name || '').toLowerCase();
  if (target) {
    const provider = registry.get(target);
    if (provider) return provider;
  }
  // No name given: prefer the long-standing default rather than whichever
  // service chain happens to be first, so legacy callers keep their provider.
  const paystack = registry.get('paystack');
  if (paystack) return paystack;
  const firstRouted = getUtilityRouting().routes.data[0] || getUtilityRouting().routes.airtime[0];
  const fallback = firstRouted ? registry.get(firstRouted) : undefined;
  if (fallback) return fallback;
  throw new Error(`No utility provider registered in Sivan registry for "${target}"`);
}

/** Priority-ordered chain across every provider. Used by airtime-to-cash. */
export function getUtilityProviderChain(preferredName?: string): IUtilityProvider[] {
  const all = Array.from(registry.values());
  const sorted = [...all].sort((a, b) => (b.priority ?? 10) - (a.priority ?? 10));
  if (!preferredName) return sorted;
  const target = preferredName.toLowerCase();
  const preferred = sorted.find((p) => p.name.toLowerCase() === target);
  if (!preferred) return sorted;
  return [preferred, ...sorted.filter((p) => p.name.toLowerCase() !== target)];
}

/** Generic failover across the priority chain. Used by airtime-to-cash. */
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
    }
  }
  throw lastError || new Error('All registered utility providers failed.');
}

/**
 * The old global active provider. Reported as the data primary so existing
 * admin reads keep working; writes now go through the routing endpoints.
 */
export function getActiveUtilityProviderName(): string {
  const routing = getUtilityRouting();
  return routing.routes.data[0] || routing.routes.airtime[0] || 'paystack';
}

export function setActiveUtilityProviderName(name: string): void {
  const clean = name.toLowerCase().trim();
  if (!registry.has(clean)) {
    throw new Error(`Provider "${name}" is not registered in Sivan utility registry.`);
  }
  const current = getUtilityRouting();
  const next: UtilityRoutingConfig = {
    routes: { ...current.routes },
    failover: { ...current.failover },
  };
  // Only the telco rails follow the legacy switch. Electricity keeps its own
  // route, which is the entire point of per-service routing.
  for (const service of ['airtime', 'data'] as UtilityServiceType[]) {
    const provider = registry.get(clean);
    if (provider && providerServes(provider, service)) {
      next.routes[service] = [clean, ...current.routes[service].filter((n) => n !== clean)];
    }
  }
  setUtilityRouting(next);
}
