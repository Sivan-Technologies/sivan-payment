import { z } from 'zod';
import { db } from '../database/json-database.js';
import type { SystemStatusRecord } from '../database/types.js';
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

export async function getSystemStatus(): Promise<SystemStatusRecord> {
  const data = await db.read();
  return (data.systemStatus ?? []).find((status) => status.id === 'global') ?? defaultStatus();
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

  const maintenanceBlocked = [
    /^\/api\/external-accounts/,
    /^\/api\/withdrawals$/,
    /^\/api\/onramp\/orders$/
  ];

  const pausedBlocked = [
    /^\/api\/customers$/,
    /^\/api\/customers\/kyc-link$/,
    /^\/api\/external-accounts/,
    /^\/api\/withdrawals$/,
    /^\/api\/onramp\/orders$/
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
