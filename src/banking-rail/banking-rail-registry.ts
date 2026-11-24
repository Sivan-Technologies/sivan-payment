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
import { NombaBankingRailAdapter } from './adapters/nomba.adapter.js';
import { NinePsbBankingRailAdapter } from './adapters/ninepsb.adapter.js';
import { AggregatorBankingRailAdapter } from './adapters/aggregator.adapter.js';

const _registry = new Map<BankingRailName, IBankingRailAdapter>();

function initAdapter(target: BankingRailName): IBankingRailAdapter | undefined {
  let adapter = _registry.get(target);
  if (adapter) return adapter;

  switch (target) {
    case 'paystack':
      adapter = new PaystackBankingRailAdapter();
      break;
    case 'mono':
      adapter = new MonoBankingRailAdapter();
      break;
    case 'nomba':
      adapter = new NombaBankingRailAdapter();
      break;
    case '9psb':
      adapter = new NinePsbBankingRailAdapter();
      break;
    case 'aggregator':
      adapter = new AggregatorBankingRailAdapter();
      break;
  }

  if (adapter) {
    _registry.set(target, adapter);
  }
  return adapter;
}

/**
 * Returns the active banking rail adapter.
 * Controlled by BANKING_RAIL_PROVIDER env var, defaults to 'aggregator'.
 */
export function getBankingRailAdapter(name?: string): IBankingRailAdapter {
  const normalized = (name ?? (process.env.BANKING_RAIL_PROVIDER || 'aggregator')).toLowerCase().trim();
  const target = (
    normalized === 'ninepsb' ? '9psb' :
    normalized === 'hybrid' || normalized === 'smart-router' ? 'aggregator' :
    normalized
  ) as BankingRailName;

  const adapter = initAdapter(target);
  if (adapter) return adapter;

  // Explicit fallback to aggregator, nomba, 9psb, or paystack
  const fallback = initAdapter('aggregator') || initAdapter('nomba') || initAdapter('9psb') || initAdapter('paystack');
  if (fallback) {
    console.warn(
      `[banking-rail-registry] No adapter registered for "${target}". ` +
        `Falling back to ${fallback.name}. Set BANKING_RAIL_PROVIDER to a registered adapter name.`
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

const ALL_RAILS: BankingRailName[] = ['paystack', 'mono', 'nomba', '9psb', 'aggregator'];

/**
 * List all currently registered adapter names.
 */
export function listRegisteredRails(): BankingRailName[] {
  return ALL_RAILS;
}

/**
 * Returns the currently active adapter name.
 */
export function getActiveBankingRailName(): BankingRailName {
  return ((process.env.BANKING_RAIL_PROVIDER ?? 'paystack').toLowerCase()) as BankingRailName;
}
