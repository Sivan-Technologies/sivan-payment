/**
 * SIVAN BANKING RAIL REGISTRY
 *
 * Single source of truth for which banking rail adapter is active.
 * Controlled by BANKING_RAIL_PROVIDER environment variable.
 *
 * Default: 'paystack'
 *
 * To add a new provider (e.g. Mono):
 *   1. Create src/banking-rail/adapters/mono.adapter.ts
 *   2. Import and register it below
 *   3. Set BANKING_RAIL_PROVIDER=mono in environment
 *
 * Pattern mirrors ngn-provider-registry.ts for consistency.
 */

import type { IBankingRailAdapter, BankingRailName } from './banking-rail.adapter.js';
import { PaystackBankingRailAdapter } from './adapters/paystack.adapter.js';
import { MonoBankingRailAdapter } from './adapters/mono.adapter.js';

const _registry = new Map<BankingRailName, IBankingRailAdapter>();

// ── Register built-in adapters ────────────────────────────────────────────────
_registry.set('paystack', new PaystackBankingRailAdapter());
_registry.set('mono', new MonoBankingRailAdapter());
// Future: _registry.set('flutterwave', new FlutterwaveBankingRailAdapter());
// Future: _registry.set('nomba', new NombaBankingRailAdapter());

/**
 * Returns the active banking rail adapter.
 * Controlled by BANKING_RAIL_PROVIDER env var, defaults to 'paystack'.
 */
export function getBankingRailAdapter(name?: BankingRailName): IBankingRailAdapter {
  const target = (name ?? (process.env.BANKING_RAIL_PROVIDER as BankingRailName) ?? 'paystack').toLowerCase() as BankingRailName;
  const adapter = _registry.get(target);

  if (adapter) return adapter;

  // Explicit fallback — never silently return wrong provider
  const fallback = _registry.get('paystack');
  if (fallback) {
    console.warn(
      `[banking-rail-registry] No adapter registered for "${target}". ` +
        'Falling back to paystack. Set BANKING_RAIL_PROVIDER to a registered adapter name.'
    );
    return fallback;
  }

  throw new Error(
    `[banking-rail-registry] No adapter registered for "${target}" and no paystack fallback available.`
  );
}

/**
 * Register or override an adapter at runtime (useful for tests).
 */
export function registerBankingRailAdapter(adapter: IBankingRailAdapter): void {
  _registry.set(adapter.name, adapter);
}

/**
 * List all currently registered adapter names.
 */
export function listRegisteredRails(): BankingRailName[] {
  return Array.from(_registry.keys());
}

/**
 * Returns the currently active adapter name.
 */
export function getActiveBankingRailName(): BankingRailName {
  return ((process.env.BANKING_RAIL_PROVIDER ?? 'paystack').toLowerCase()) as BankingRailName;
}
