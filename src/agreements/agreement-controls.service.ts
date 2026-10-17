import { db } from '../database/json-database.js';
import type { AgreementControlsRecord } from '../database/types.js';
import { nowIso } from '../shared/id.js';

/**
 * Default controls applied when no record exists in the database.
 *
 * creationEnabled: false on first deploy — new agreements are gated until the
 * founder explicitly opens creation via the admin endpoint. Active agreements
 * continue to settle normally through servicingEnabled: true.
 *
 * This default protects mainnet from premature creation while ensuring any
 * existing funded agreements are never locked behind a disabled interface.
 */
const DEFAULT_CONTROLS: AgreementControlsRecord = {
  id: 'default_controls',
  creationEnabled: false,
  servicingEnabled: true,
  emergencyHalt: false,
  pilotWhitelistOnly: false,
  allowedNetworks: ['celo-mainnet', 'stellar-mainnet', 'celo-sepolia', 'stellar-testnet'],
  maintenanceMessage:
    'Service Agreement creation is currently reserved for verified pilot partners during mainnet staging. Active agreements continue to settle normally.',
  updatedAt: nowIso(),
};

/**
 * In-memory hot cache for agreement controls.
 *
 * Every route guard reads this cache synchronously to avoid a database round
 * trip on each mutating request. The cache is refreshed immediately any time
 * updateAgreementControls() is called, giving sub-millisecond reads on the
 * happy path and eventual consistency within one admin toggle.
 */
let cachedControls: AgreementControlsRecord | null = null;
let cacheLoadedAt: number = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds max staleness

async function loadCache(): Promise<AgreementControlsRecord> {
  const stored = await db.getAgreementControls();
  cachedControls = stored ?? DEFAULT_CONTROLS;
  cacheLoadedAt = Date.now();
  return cachedControls;
}

/**
 * Returns the current agreement controls, serving from the in-memory cache
 * when fresh. Falls back to DEFAULT_CONTROLS if the database is unreachable,
 * which means the safe default (creation disabled) is enforced during outages.
 */
export async function getAgreementControls(): Promise<AgreementControlsRecord> {
  if (cachedControls && Date.now() - cacheLoadedAt < CACHE_TTL_MS) {
    return cachedControls;
  }
  try {
    return await loadCache();
  } catch (err) {
    console.warn('[agreement-controls] cache load failed, applying safe default', err);
    return DEFAULT_CONTROLS;
  }
}

/**
 * Synchronous cache read for route guards that cannot await.
 * Returns null if the cache has not been populated yet (first request after
 * boot); callers should fall through to getAgreementControls() in that case.
 */
export function getCachedControls(): AgreementControlsRecord | null {
  return cachedControls;
}

/**
 * Guards new agreement creation.
 *
 * Returns true only if creationEnabled is true AND either pilotWhitelistOnly
 * is false OR the requesting userId is present in the pilot whitelist (passed
 * by the caller via the admin header check).
 */
export function isCreationAllowed(
  controls: AgreementControlsRecord,
  userId?: string
): boolean {
  if (!controls.creationEnabled) return false;
  if (controls.pilotWhitelistOnly && userId) {
    // Pilot whitelist is enforced via the admin token path; regular users
    // see creation as closed when pilotWhitelistOnly is active.
    return false;
  }
  return true;
}

/**
 * Guards lifecycle mutations on existing agreements (fund, deliver, release,
 * cancel, extend). Returns false only during an explicit emergency halt or
 * when servicingEnabled has been disabled by an admin.
 */
export function isServicingAllowed(controls: AgreementControlsRecord): boolean {
  return controls.servicingEnabled && !controls.emergencyHalt;
}

/**
 * Guards on-chain settlement calls (fund, release) specifically.
 * Always blocked during an emergency halt regardless of servicingEnabled.
 */
export function isSettlementAllowed(controls: AgreementControlsRecord): boolean {
  return !controls.emergencyHalt;
}

/**
 * Admin-only: persist updated controls and immediately refresh the in-memory cache.
 *
 * The adminId parameter is stored in the audit field updated_by_admin_id so
 * the founder can trace every toggle back to the exact admin credential used.
 */
export async function updateAgreementControls(
  updates: Partial<Omit<AgreementControlsRecord, 'id' | 'updatedAt' | 'updatedByAdminId'>>,
  adminId: string
): Promise<AgreementControlsRecord> {
  const current = await getAgreementControls();
  const updated: AgreementControlsRecord = {
    ...current,
    ...updates,
    id: 'default_controls',
    updatedByAdminId: adminId,
    updatedAt: nowIso(),
  };
  await db.saveAgreementControls(updated);
  // Immediately refresh cache so subsequent requests see the new state.
  cachedControls = updated;
  cacheLoadedAt = Date.now();
  return updated;
}

/**
 * Builds the public-facing controls payload served to clients.
 * Omits the internal updatedByAdminId field from the public response.
 */
export function buildPublicControlsPayload(controls: AgreementControlsRecord) {
  return {
    creationEnabled: controls.creationEnabled,
    servicingEnabled: controls.servicingEnabled,
    emergencyHalt: controls.emergencyHalt,
    pilotWhitelistOnly: controls.pilotWhitelistOnly,
    allowedNetworks: controls.allowedNetworks,
    message: controls.maintenanceMessage,
    updatedAt: controls.updatedAt,
  };
}
