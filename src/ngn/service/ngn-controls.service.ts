import { z } from 'zod';
import { db } from '../../database/json-database.js';
import { nowIso } from '../../shared/id.js';
import { createAuditLog } from '../../audit/audit.service.js';
import type { NgnControlsRecord } from '../types/ngn.types.js';

export const updateNgnControlsSchema = z.object({
  onrampEnabled: z.boolean().optional(),
  offrampEnabled: z.boolean().optional(),
  mockProviderEnabled: z.boolean().optional(),
  bankSettlementEnabled: z.boolean().optional(),
  virtualAccountEnabled: z.boolean().optional(),
  activeProvider: z.enum(['mock', 'linkio', 'eversend', 'nomba', 'paj']).optional(),
  backupProvider: z.enum(['mock', 'linkio', 'eversend', 'nomba', 'paj']).optional().nullable(),
  maxTransactionNgn: z.string().optional(),
  dailyLimitNgn: z.string().optional(),
  highValueReviewThresholdNgn: z.string().optional(),
  updatedBy: z.string().optional().default('admin_api_key')
});

export function defaultNgnControls(): NgnControlsRecord {
  return { id: 'global', onrampEnabled: false, offrampEnabled: false, mockProviderEnabled: true, bankSettlementEnabled: false, virtualAccountEnabled: false, activeProvider: 'mock', backupProvider: undefined, maxTransactionNgn: '500000', dailyLimitNgn: '2000000', highValueReviewThresholdNgn: '1000000', updatedBy: 'system', updatedAt: nowIso() };
}

export async function getNgnControls() {
  const existing = (await db.listNgnControls?.()) ?? [];
  return existing.find((item) => item.id === 'global') ?? defaultNgnControls();
}

export async function updateNgnControls(input: z.infer<typeof updateNgnControlsSchema>) {
  const current = await getNgnControls();
  const next: NgnControlsRecord = { ...current, ...input, backupProvider: input.backupProvider === null ? undefined : input.backupProvider ?? current.backupProvider, updatedBy: input.updatedBy ?? 'admin_api_key', updatedAt: nowIso() };
  await db.upsertNgnControlsRecord(next);
  await createAuditLog({ actorType: 'admin', actorId: next.updatedBy, action: 'ngn.controls_updated', resourceType: 'payments_ngn_controls', resourceId: 'global', severity: 'warning', metadata: { previous: current, next } });
  return next;
}
