/**
 * SIVAN UTILITY DATA PLANS SERVICE (DYNAMIC PRICING & AGGREGATOR CONTROLS)
 *
 * Manages retail pricing for mobile data bundles (1GB, 2GB, 5GB, 10GB)
 * and active utility aggregator provider toggle (Paystack vs VTU Aggregator).
 *
 * Features:
 * - Admin Hub live pricing configuration with audit logging
 * - In-memory caching for sub-millisecond bot response times
 * - Multi-network pricing overrides ('all' fallback or network-specific)
 * - Safe fail-closed defaults matching realistic Nigerian telco retail prices
 */

import { z } from 'zod';
import { db } from '../../database/json-database.js';
import { nowIso } from '../../shared/id.js';
import { createAuditLog } from '../../audit/audit.service.js';
import { badRequest } from '../../shared/errors.js';
import type { TelcoOperator, DataPlanOption } from '../types/paystackUtilityTypes.js';
import {
  getActiveUtilityProviderName,
  setActiveUtilityProviderName,
  listUtilityProviders,
  getUtilityProvider,
} from '../provider/utility-registry.js';

export interface UtilityDataPlanRecord {
  id: string;
  bundleSize: string; // '1GB', '2GB', '5GB', '10GB'
  /**
   * Wholesale cost actually charged by the upstream provider.
   * `null` means "not yet known": it has never been synced from a provider
   * catalogue. It is deliberately not defaulted to an invented figure, because
   * a plausible wrong cost silently produces a wrong margin.
   */
  costPriceNgn: number | null;
  /** Derived: amountNgn - costPriceNgn. `null` while the cost is unknown. */
  markupNgn: number | null;
  /** Retail price charged to the customer. Set by an admin, never guessed. */
  amountNgn: number;
  network: string; // 'mtn' | 'airtel' | 'glo' | '9mobile' | 'all'
  isActive: boolean;
  /** Sivan's own catalogue code, e.g. DATA_1GB. Not a provider identifier. */
  planCode?: string;
  /**
   * Per-provider identifiers for this same bundle, keyed by provider name as
   * registered in the utility registry, e.g. { smeapi: '6' }. Providers do not
   * share a plan namespace: SME API wants its own numeric id, so Sivan's
   * planCode cannot be forwarded upstream.
   */
  providerPlanCodes?: Record<string, string>;
  /** Free-text plan family from the provider catalogue, e.g. 'SME2'. */
  planType?: string;
  validity?: string;
  description?: string;
  updatedAt: string;
  updatedBy: string;
}

/**
 * There is deliberately no built-in plan catalogue.
 *
 * The previous default list carried invented wholesale costs (1GB at 350, 5GB
 * at 1750). Verified against the live SME API catalogue those were wrong in
 * both directions, so the admin hub reported margins that did not exist. An
 * empty catalogue fails closed: data purchases are refused with a clear reason
 * until an admin syncs real costs from a provider and sets a retail price.
 */
export const DEFAULT_DATA_PLANS: UtilityDataPlanRecord[] = [];

// In-memory caching for sub-millisecond public API and bot queries
let cachedPlans: UtilityDataPlanRecord[] | null = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const updateDataPlanSchema = z.object({
  bundleSize: z.string().min(1, 'bundleSize is required'),
  costPriceNgn: z.number().int().min(0, 'Cost price cannot be negative').optional(),
  markupNgn: z.number().int().min(0, 'Markup cannot be negative').optional(),
  amountNgn: z.number().int().min(100, 'Minimum price is 100 NGN').optional(),
  network: z.string().optional().default('all'),
  isActive: z.boolean().optional().default(true),
  planCode: z.string().optional(),
  providerPlanCodes: z.record(z.string(), z.string()).optional(),
  planType: z.string().optional(),
  validity: z.string().optional(),
  description: z.string().optional(),
  updatedBy: z.string().optional().default('admin_api_key'),
});

export const updateDataPlansBatchSchema = z.object({
  plans: z.array(updateDataPlanSchema).min(1, 'At least one plan must be provided'),
  updatedBy: z.string().optional().default('admin_api_key'),
});

export const updateUtilityProviderSchema = z.object({
  provider: z.string().min(1, 'provider is required'),
  updatedBy: z.string().optional().default('admin_api_key'),
});

/**
 * Retrieves all utility data bundle plans, reading from audit persistence or fallback defaults.
 */
export async function getUtilityDataPlans(options?: {
  activeOnly?: boolean;
  network?: string;
}): Promise<UtilityDataPlanRecord[]> {
  const now = Date.now();
  if (cachedPlans && now - lastCacheTime < CACHE_TTL_MS) {
    return filterPlans(cachedPlans, options);
  }

  try {
    const data = await db.read();
    // Batch saves are recorded as `.synced` and single edits as `.updated`.
    // Reading only `.updated` meant a full catalogue save from the admin hub
    // was written and then never read back again.
    const latestAudit = (data.auditLogs ?? [])
      .filter(
        (log) =>
          log.action === 'utility.data_plans.updated' ||
          log.action === 'utility.data_plans.synced'
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

    const saved = (latestAudit?.metadata as any)?.plans as UtilityDataPlanRecord[] | undefined;
    if (saved && Array.isArray(saved) && saved.length > 0) {
      cachedPlans = saved.map((p) => {
        // Retail price is authoritative; cost may legitimately still be unknown.
        const costPriceNgn = typeof p.costPriceNgn === 'number' ? p.costPriceNgn : null;
        const amountNgn = p.amountNgn;
        return {
          ...p,
          costPriceNgn,
          markupNgn: costPriceNgn === null ? null : amountNgn - costPriceNgn,
          amountNgn,
        };
      });
      lastCacheTime = now;
      return filterPlans(cachedPlans, options);
    }
  } catch (err) {
    console.warn('[utility-data-plans] Failed to read persisted plans from DB, using defaults:', err);
  }

  cachedPlans = [...DEFAULT_DATA_PLANS];
  lastCacheTime = now;
  return filterPlans(cachedPlans, options);
}

function filterPlans(
  plans: UtilityDataPlanRecord[],
  options?: { activeOnly?: boolean; network?: string }
): UtilityDataPlanRecord[] {
  let result = plans;
  if (options?.activeOnly) {
    result = result.filter((p) => p.isActive !== false);
  }
  if (options?.network && options.network !== 'all') {
    const targetNet = options.network.toLowerCase();
    result = result.filter((p) => p.network.toLowerCase() === targetNet || p.network.toLowerCase() === 'all');
  }
  return result;
}

/**
 * Finds a specific bundle size (e.g. "1GB", "2GB") with optional network preference.
 */
export async function getUtilityDataPlanBySize(
  bundleSize: string,
  network?: string
): Promise<UtilityDataPlanRecord | null> {
  const plans = await getUtilityDataPlans({ activeOnly: true });
  const cleanSize = bundleSize.toUpperCase().replace(/\s+/g, '');
  const targetNet = (network || 'all').toLowerCase();

  // 1. Exact network match first (e.g. 1GB for MTN)
  const exact = plans.find(
    (p) => p.bundleSize.toUpperCase().replace(/\s+/g, '') === cleanSize && p.network.toLowerCase() === targetNet
  );
  if (exact) return exact;

  // 2. Fall back to 'all' networks tier
  return (
    plans.find(
      (p) => p.bundleSize.toUpperCase().replace(/\s+/g, '') === cleanSize && p.network.toLowerCase() === 'all'
    ) || null
  );
}

/**
 * Updates or inserts one or more data bundle tiers with admin audit trail and cache invalidation.
 */
export async function updateUtilityDataPlans(
  inputPlans: Array<z.infer<typeof updateDataPlanSchema>>,
  updatedBy = 'admin_api_key',
  options: { replaceAll?: boolean } = {}
): Promise<UtilityDataPlanRecord[]> {
  const current = await getUtilityDataPlans();
  const planMap = new Map<string, UtilityDataPlanRecord>();

  if (!options.replaceAll) {
    for (const p of current) {
      const key = `${p.bundleSize.toUpperCase()}_${p.network.toLowerCase()}`;
      planMap.set(key, p);
    }
  }

  const now = nowIso();
  for (const input of inputPlans) {
    const cleanSize = input.bundleSize.toUpperCase().replace(/\s+/g, '');
    const cleanNet = (input.network || 'all').toLowerCase();
    const key = `${cleanSize}_${cleanNet}`;
    const id = `plan_${cleanSize.toLowerCase()}_${cleanNet}`;

    const existing = current.find(
      (p) => `${p.bundleSize.toUpperCase()}_${p.network.toLowerCase()}` === key
    );
    // Cost is only ever a real synced figure or null. It is never invented,
    // because a wrong cost produces a confidently wrong margin.
    const costPrice: number | null =
      input.costPriceNgn ?? existing?.costPriceNgn ?? null;

    // Retail price is what the customer is charged, so it must be stated
    // explicitly, either directly or as cost + markup over a known cost.
    let amount: number | undefined = input.amountNgn;
    if (amount === undefined && input.markupNgn !== undefined && costPrice !== null) {
      amount = costPrice + input.markupNgn;
    }
    if (amount === undefined) {
      amount = existing?.amountNgn;
    }
    if (amount === undefined) {
      throw badRequest(
        `Plan ${cleanSize} (${cleanNet}) needs a retail price: send amountNgn, ` +
          `or markupNgn once costPriceNgn is known.`
      );
    }

    const mergedProviderCodes = {
      ...(existing?.providerPlanCodes ?? {}),
      ...(input.providerPlanCodes ?? {}),
    };

    planMap.set(key, {
      id,
      bundleSize: cleanSize,
      costPriceNgn: costPrice,
      markupNgn: costPrice === null ? null : amount - costPrice,
      amountNgn: amount,
      network: cleanNet,
      isActive: input.isActive ?? (existing ? existing.isActive : true),
      planCode: input.planCode || existing?.planCode || `DATA_${cleanSize}`,
      providerPlanCodes: mergedProviderCodes,
      planType: input.planType ?? existing?.planType,
      validity: input.validity ?? existing?.validity,
      description: input.description || existing?.description || `${cleanSize} Mobile Data (${cleanNet.toUpperCase()})`,
      updatedAt: now,
      updatedBy,
    });
  }

  const nextPlans = Array.from(planMap.values());
  cachedPlans = nextPlans;
  lastCacheTime = Date.now();

  await createAuditLog({
    actorType: 'admin',
    actorId: updatedBy,
    action: options.replaceAll ? 'utility.data_plans.synced' : 'utility.data_plans.updated',
    resourceType: 'utility_data_plans',
    resourceId: 'global',
    severity: 'warning',
    metadata: {
      updatedCount: inputPlans.length,
      plans: nextPlans,
    },
  }).catch((err) => {
    console.warn('[utility-data-plans] Failed to record audit log:', err);
  });

  return nextPlans;
}

/**
 * Removes a specific data plan bundle by size or id.
 */
export async function deleteUtilityDataPlan(
  bundleSizeOrId: string,
  network = 'all',
  updatedBy = 'admin_api_key'
): Promise<UtilityDataPlanRecord[]> {
  const current = await getUtilityDataPlans();
  const cleanTarget = bundleSizeOrId.trim().toLowerCase().replace(/\s+/g, '');
  const cleanNet = network.trim().toLowerCase();

  const filtered = current.filter((p) => {
    const idMatch = p.id.toLowerCase() === cleanTarget;
    const sizeMatch = p.bundleSize.toLowerCase().replace(/\s+/g, '') === cleanTarget;
    const netMatch = cleanNet === 'all' || p.network.toLowerCase() === cleanNet;
    return !(idMatch || (sizeMatch && netMatch));
  });

  cachedPlans = filtered;
  lastCacheTime = Date.now();

  await createAuditLog({
    actorType: 'admin',
    actorId: updatedBy,
    action: 'utility.data_plan.deleted',
    resourceType: 'utility_data_plans',
    resourceId: bundleSizeOrId,
    severity: 'warning',
    metadata: {
      deletedTarget: bundleSizeOrId,
      remainingCount: filtered.length,
      plans: filtered,
    },
  }).catch((err) => {
    console.warn('[utility-data-plans] Failed to record audit log:', err);
  });

  return filtered;
}

/**
 * Returns the currently active utility provider and list of available providers.
 */
export async function getActiveUtilityProviderInfo(): Promise<{
  activeProvider: string;
  availableProviders: string[];
}> {
  return {
    activeProvider: getActiveUtilityProviderName(),
    availableProviders: listUtilityProviders(),
  };
}

/**
 * Switches the active utility fulfillment rail (e.g. 'paystack' <-> 'vtu_ng') with audit trail.
 */
export async function setUtilityProvider(
  providerName: string,
  updatedBy = 'admin_api_key'
): Promise<{ activeProvider: string }> {
  const target = providerName.toLowerCase().trim();
  const available = listUtilityProviders();

  if (!available.includes(target)) {
    throw badRequest(
      `Provider "${providerName}" is not registered. Available providers: ${available.join(', ')}`
    );
  }

  const previous = getActiveUtilityProviderName();
  setActiveUtilityProviderName(target);

  await createAuditLog({
    actorType: 'admin',
    actorId: updatedBy,
    action: 'utility.provider.switched',
    resourceType: 'utility_provider_settings',
    resourceId: 'global',
    severity: 'warning',
    metadata: {
      previous,
      activeProvider: target,
    },
  }).catch((err) => {
    console.warn('[utility-data-plans] Failed to record provider switch audit log:', err);
  });

  return { activeProvider: target };
}

/**
 * Resolves the identifier a specific provider expects for a bundle.
 *
 * Providers do not share a plan namespace. Sivan's catalogue code is
 * `DATA_1GB`; SME API expects the numeric id from its own catalogue (6 is
 * "MTN 1GB SME2 30days"). Forwarding `DATA_1GB` upstream is rejected by SME
 * API, which is why data fulfilment failed while airtime worked: airtime
 * carries only an amount, so it has no plan namespace to get wrong.
 *
 * Returns null when no mapping exists, so the caller can refuse explicitly
 * instead of sending a code the provider cannot understand.
 */
export function resolveProviderPlanCode(
  plan: UtilityDataPlanRecord | null | undefined,
  providerName: string
): string | null {
  if (!plan?.providerPlanCodes) return null;
  const code = plan.providerPlanCodes[providerName];
  return code && String(code).trim().length > 0 ? String(code) : null;
}

/**
 * Reads a provider's own live catalogue so an admin can map plans and price
 * against the real wholesale cost rather than a remembered one.
 *
 * Note for SME API specifically: the catalogue is cheaper when the request is
 * authenticated. 23 of its 142 plans return a higher public price, so an
 * unauthenticated read understates margin. The provider sends its key, so the
 * figures returned here are the account's true rates.
 */
export async function getProviderPlanCatalogue(
  providerName: string,
  operator: TelcoOperator
): Promise<{ provider: string; operator: TelcoOperator; plans: DataPlanOption[] }> {
  const registered = listUtilityProviders();
  if (!registered.includes(providerName)) {
    throw badRequest(
      `Unknown provider "${providerName}". Registered: ${registered.join(', ')}.`
    );
  }
  const provider = getUtilityProvider(providerName);
  if (typeof (provider as any).listDataPlans !== 'function') {
    throw badRequest(`Provider "${providerName}" does not publish a data plan catalogue.`);
  }
  const plans = await (provider as any).listDataPlans(operator);
  return { provider: providerName, operator, plans };
}
