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
import {
  getActiveUtilityProviderName,
  setActiveUtilityProviderName,
  listUtilityProviders,
} from '../provider/utility-registry.js';

export interface UtilityDataPlanRecord {
  id: string;
  bundleSize: string; // '1GB', '2GB', '5GB', '10GB'
  amountNgn: number;
  network: string; // 'all' | 'mtn' | 'airtel' | 'glo' | '9mobile'
  isActive: boolean;
  planCode?: string;
  description?: string;
  updatedAt: string;
  updatedBy: string;
}

export const DEFAULT_DATA_PLANS: UtilityDataPlanRecord[] = [
  {
    id: 'plan_1gb_all',
    bundleSize: '1GB',
    amountNgn: 350,
    network: 'all',
    isActive: true,
    planCode: 'DATA_1GB',
    description: '1GB Mobile Internet Data (All Networks, 30 Days)',
    updatedAt: new Date().toISOString(),
    updatedBy: 'system',
  },
  {
    id: 'plan_2gb_all',
    bundleSize: '2GB',
    amountNgn: 700,
    network: 'all',
    isActive: true,
    planCode: 'DATA_2GB',
    description: '2GB Mobile Internet Data (All Networks, 30 Days)',
    updatedAt: new Date().toISOString(),
    updatedBy: 'system',
  },
  {
    id: 'plan_5gb_all',
    bundleSize: '5GB',
    amountNgn: 1750,
    network: 'all',
    isActive: true,
    planCode: 'DATA_5GB',
    description: '5GB Mobile Internet Data (All Networks, 30 Days)',
    updatedAt: new Date().toISOString(),
    updatedBy: 'system',
  },
  {
    id: 'plan_10gb_all',
    bundleSize: '10GB',
    amountNgn: 3500,
    network: 'all',
    isActive: true,
    planCode: 'DATA_10GB',
    description: '10GB Mobile Internet Data (All Networks, 30 Days)',
    updatedAt: new Date().toISOString(),
    updatedBy: 'system',
  },
];

// In-memory caching for sub-millisecond public API and bot queries
let cachedPlans: UtilityDataPlanRecord[] | null = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const updateDataPlanSchema = z.object({
  bundleSize: z.string().min(1, 'bundleSize is required'),
  amountNgn: z.number().int().min(100, 'Minimum price is 100 NGN'),
  network: z.string().optional().default('all'),
  isActive: z.boolean().optional().default(true),
  planCode: z.string().optional(),
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
    const latestAudit = (data.auditLogs ?? [])
      .filter((log) => log.action === 'utility.data_plans.updated')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

    const saved = (latestAudit?.metadata as any)?.plans as UtilityDataPlanRecord[] | undefined;
    if (saved && Array.isArray(saved) && saved.length > 0) {
      cachedPlans = saved;
      lastCacheTime = now;
      return filterPlans(saved, options);
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
  updatedBy = 'admin_api_key'
): Promise<UtilityDataPlanRecord[]> {
  const current = await getUtilityDataPlans();
  const planMap = new Map<string, UtilityDataPlanRecord>();

  for (const p of current) {
    const key = `${p.bundleSize.toUpperCase()}_${p.network.toLowerCase()}`;
    planMap.set(key, p);
  }

  const now = nowIso();
  for (const input of inputPlans) {
    const cleanSize = input.bundleSize.toUpperCase().replace(/\s+/g, '');
    const cleanNet = (input.network || 'all').toLowerCase();
    const key = `${cleanSize}_${cleanNet}`;
    const id = `plan_${cleanSize.toLowerCase()}_${cleanNet}`;

    const existing = planMap.get(key);
    planMap.set(key, {
      id,
      bundleSize: cleanSize,
      amountNgn: input.amountNgn,
      network: cleanNet,
      isActive: input.isActive ?? (existing ? existing.isActive : true),
      planCode: input.planCode || existing?.planCode || `DATA_${cleanSize}`,
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
    action: 'utility.data_plans.updated',
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
