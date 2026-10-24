/**
 * SIVAN UTILITY ROUTING SERVICE
 *
 * Owns persistence for the per-service provider routing map.
 *
 * The previous active-provider switch lived in a module variable, so it was
 * lost on restart and differed between instances. Routing is persisted here
 * through the same audit-backed settings mechanism the data plan prices use,
 * then applied to the registry in memory and cached.
 */

import { z } from 'zod';
import { db } from '../../database/json-database.js';
import { createAuditLog } from '../../audit/audit.service.js';
import { badRequest } from '../../shared/errors.js';
import {
  DEFAULT_UTILITY_ROUTING,
  getUtilityRouting,
  listUtilityProviderCapabilities,
  normaliseUtilityRouting,
  providerServes,
  setUtilityRouting,
  type UtilityRoutingConfig,
} from '../provider/utility-registry.js';
import { UTILITY_SERVICE_TYPES, type UtilityServiceType } from '../provider/utility-provider.interface.js';

const ROUTING_AUDIT_ACTION = 'utility.routing.updated';

const serviceChainSchema = z.array(z.string().min(1)).min(1, 'At least one provider is required');

export const updateUtilityRoutingSchema = z.object({
  routes: z
    .object({
      airtime: serviceChainSchema.optional(),
      data: serviceChainSchema.optional(),
      electricity: serviceChainSchema.optional(),
    })
    .optional(),
  failover: z
    .object({
      airtime: z.boolean().optional(),
      data: z.boolean().optional(),
      electricity: z.boolean().optional(),
    })
    .optional(),
  updatedBy: z.string().optional(),
});

let loaded = false;

/**
 * Loads persisted routing into the registry once per process.
 *
 * Called before any purchase so a provider switch made on another instance is
 * picked up rather than silently ignored.
 */
export async function ensureUtilityRoutingLoaded(): Promise<UtilityRoutingConfig> {
  if (loaded) return getUtilityRouting();
  try {
    const data = await db.read();
    const latest = (data.auditLogs ?? [])
      .filter((log) => log.action === ROUTING_AUDIT_ACTION)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

    const saved = (latest?.metadata as any)?.routing as Partial<UtilityRoutingConfig> | undefined;
    if (saved) setUtilityRouting(saved);
  } catch (err) {
    console.warn('[utility-routing] Could not read persisted routing, using defaults:', err);
  }
  loaded = true;
  return getUtilityRouting();
}

/** Current routing plus the capability matrix, for the admin hub. */
export async function getUtilityRoutingInfo() {
  const routing = await ensureUtilityRoutingLoaded();
  return {
    routing,
    defaults: DEFAULT_UTILITY_ROUTING,
    providers: listUtilityProviderCapabilities(),
  };
}

/**
 * Validates and persists a routing change.
 *
 * Rejects a chain naming a provider that cannot serve that service, rather
 * than silently dropping it, so an operator who routes electricity to an
 * airtime-only aggregator is told why instead of discovering it at purchase.
 */
export async function setUtilityRoutingConfig(
  input: z.infer<typeof updateUtilityRoutingSchema>,
  updatedBy = 'admin_api_key'
): Promise<UtilityRoutingConfig> {
  await ensureUtilityRoutingLoaded();
  const current = getUtilityRouting();
  const capabilities = listUtilityProviderCapabilities();
  const known = new Map(capabilities.map((c) => [c.name, c]));

  for (const service of UTILITY_SERVICE_TYPES) {
    const requested = input.routes?.[service];
    if (!requested) continue;
    for (const rawName of requested) {
      const name = String(rawName).toLowerCase().trim();
      const capability = known.get(name);
      if (!capability) {
        throw badRequest(
          `Provider "${rawName}" is not registered. Available: ${capabilities.map((c) => c.name).join(', ')}`
        );
      }
      if (!capability.supports.includes(service)) {
        throw badRequest(
          `Provider "${name}" does not support ${service}. It supports: ${capability.supports.join(', ') || 'nothing'}`
        );
      }
    }
  }

  const merged: UtilityRoutingConfig = {
    routes: {
      airtime: input.routes?.airtime ?? current.routes.airtime,
      data: input.routes?.data ?? current.routes.data,
      electricity: input.routes?.electricity ?? current.routes.electricity,
    },
    failover: {
      airtime: input.failover?.airtime ?? current.failover.airtime,
      data: input.failover?.data ?? current.failover.data,
      electricity: input.failover?.electricity ?? current.failover.electricity,
    },
  };

  const applied = setUtilityRouting(merged);

  await createAuditLog({
    actorType: 'admin',
    actorId: updatedBy,
    action: ROUTING_AUDIT_ACTION,
    resourceType: 'utility_routing',
    resourceId: 'global',
    severity: 'info',
    metadata: { routing: applied, previous: current },
  });

  return applied;
}

/** Narrow helper for callers that only need the primary of one service. */
export async function getPrimaryProviderForService(service: UtilityServiceType): Promise<string | null> {
  const routing = await ensureUtilityRoutingLoaded();
  return routing.routes[service]?.[0] ?? null;
}

export { normaliseUtilityRouting, providerServes };
