import { z } from 'zod';
import { db } from '../database/json-database.js';
import type { SystemStatusRecord } from '../database/types.js';
import { listActiveSystemIncidents } from '../incidents/system-incidents.service.js';
import { nowIso } from '../shared/id.js';
import { createAuditLog } from '../audit/audit.service.js';

const defaultStatus = (): SystemStatusRecord => ({
  id: 'global',
  mode: 'active',
  updatedBy: 'system',
  updatedAt: nowIso()
});

export const updateSystemStatusSchema = z.object({
  mode: z.enum(['active', 'maintenance', 'paused']),
  message: z.string().max(500).optional().nullable(),
  estimatedResumeAt: z.string().datetime().optional().nullable()
});

/**
 * The platform's on/off state, read on EVERY /api/* request by the app.ts
 * preHandler - GETs included, which is what made this worse than the
 * audit-log equivalent.
 *
 * It used to call db.read() (all 28 tables) to find one row keyed 'global'.
 */
export async function getSystemStatus(): Promise<SystemStatusRecord> {
  const status = (await db.getSystemStatusRecord()) ?? defaultStatus();
  const activeIncidents = await listActiveSystemIncidents();
  return { ...status, activeIncidents };
}

export async function updateSystemStatus(input: z.infer<typeof updateSystemStatusSchema>, actorId = 'admin_api_key') {
  const previous = await getSystemStatus();
  const next: SystemStatusRecord = {
    id: 'global',
    mode: input.mode,
    message: input.message || undefined,
    estimatedResumeAt: input.estimatedResumeAt || undefined,
    updatedBy: actorId,
    updatedAt: nowIso()
  };

  await db.updateSystemStatusRecord(next);

  await createAuditLog({
    actorType: 'admin',
    actorId,
    action: 'system_status.updated',
    resourceType: 'payments_system_status',
    resourceId: 'global',
    severity: next.mode === 'active' ? 'info' : 'warning',
    metadata: { previous, next }
  });

  return next;
}

export function isUserMutationBlocked(mode: SystemStatusRecord['mode'], method: string, url: string): boolean {
  if (mode === 'active') return false;
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE') return false;

  // Never block provider/admin/system update flows that keep already-moving money visible.
  if (url.startsWith('/api/admin')) return false;
  if (url.startsWith('/api/webhooks')) return false;
  if (url.startsWith('/api/auth')) return false;

  // THE NGN RAILS WERE MISSING FROM BOTH LISTS.
  //
  // These patterns were written when Bridge was the only way money moved. The
  // naira rails were added later and never registered here, so an operator
  // pausing the system - the single lever for "stop everything, something is
  // wrong" - stopped Bridge withdrawals and left NGN off-ramps running.
  //
  // That is the worst possible shape for a kill switch: it reports success
  // and keeps paying out. Caught by the full-system e2e, not by reading.
  //
  // Accepting a quote is what commits money, so /offramp/orders and
  // /onramp/orders are blocked. Quoting is a read-shaped POST-free path and
  // is left alone deliberately - a user should still be able to see a rate
  // while payments are down, and blocking it only produces a confusing error
  // on a screen that moves nothing.
  const ngnBlocked = [
    /^\/api\/ngn\/offramp\/orders$/,
    /^\/api\/ngn\/onramp\/orders$/,
    // A payout account is identity evidence, not a payment - but creating one
    // spends a paid provider lookup, so it stops with everything else.
    /^\/api\/ngn\/payout-accounts$/
  ];

  const maintenanceBlocked = [
    /^\/api\/external-accounts/,
    /^\/api\/withdrawals$/,
    /^\/api\/onramp\/orders$/,
    ...ngnBlocked
  ];

  const pausedBlocked = [
    /^\/api\/customers$/,
    /^\/api\/customers\/kyc-link$/,
    /^\/api\/external-accounts/,
    /^\/api\/withdrawals$/,
    /^\/api\/onramp\/orders$/,
    ...ngnBlocked
  ];

  const patterns = mode === 'maintenance' ? maintenanceBlocked : pausedBlocked;
  return patterns.some((pattern) => pattern.test(url));
}

export function systemStatusMessage(status: SystemStatusRecord) {
  if (status.mode === 'active') return undefined;
  return status.message || (status.mode === 'maintenance'
    ? 'Sivan Payments is currently under maintenance. You can view your account, but new withdrawals are temporarily unavailable.'
    : 'Sivan Payments is temporarily paused. You can view your account, but new payment actions are unavailable.');
}
