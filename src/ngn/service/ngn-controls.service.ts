import { z } from 'zod';
import { db } from '../../database/json-database.js';
import { nowIso } from '../../shared/id.js';
import { createAuditLog } from '../../audit/audit.service.js';
import type { NgnControlsRecord } from '../types/ngn.types.js';

export const updateNgnControlsSchema = z.object({
  onrampEnabled: z.boolean().optional(),
  offrampEnabled: z.boolean().optional(),
  mockProviderEnabled: z.boolean().optional(),
  /**
   * INERT. Stored and displayed, but no code path reads it.
   *
   * Traced across the whole backend: the only references are the Postgres
   * column, this schema, the default, and the TypeScript type. It is never
   * used in a condition anywhere.
   *
   * Proven rather than assumed - forcing it to FALSE on every read of
   * getNgnControls() left 179 assertions green across breet-e2e (41),
   * full-system (68), failure-paths (54) and kyc-ngn-gate (16), INCLUDING
   * suites that deliberately set it true. A load-bearing flag could not
   * survive that.
   *
   * What actually gates the NGN rail is onrampEnabled / offrampEnabled /
   * maxTransactionNgn / activeProvider, all read in createNgnQuote(). Bank
   * payout itself is driven by Breet's autoSettlement and its webhook, not
   * by this toggle.
   *
   * Left in place because the column exists and removing it is a migration,
   * but flagged here so nobody treats flipping it as a safety control - it
   * neither enables nor prevents a payout.
   */
  bankSettlementEnabled: z.boolean().optional(),
  virtualAccountEnabled: z.boolean().optional(),
  activeProvider: z.enum(['mock', 'linkio', 'eversend', 'nomba', 'paj', 'breet']).optional(),
  backupProvider: z.enum(['mock', 'linkio', 'eversend', 'nomba', 'paj', 'breet']).optional().nullable(),
  identityVerificationEnabled: z.boolean().optional(),
  externalFundingEnabled: z.boolean().optional(),
  limitEnforcementOfframp: z.boolean().optional(),
  limitEnforcementOnramp: z.boolean().optional(),
  limitEnforcementEscrow: z.boolean().optional(),
  maxTransactionNgn: z.string().optional(),
  dailyLimitNgn: z.string().optional(),
  highValueReviewThresholdNgn: z.string().optional(),
  updatedBy: z.string().optional().default('admin_api_key')
});

export function defaultNgnControls(): NgnControlsRecord {
  return { id: 'global', onrampEnabled: true, offrampEnabled: true, mockProviderEnabled: true, bankSettlementEnabled: true, virtualAccountEnabled: true, activeProvider: 'breet', backupProvider: undefined, identityVerificationEnabled: true, externalFundingEnabled: true, limitEnforcementOfframp: true, limitEnforcementOnramp: true, limitEnforcementEscrow: true, maxTransactionNgn: '500000', dailyLimitNgn: '2000000', highValueReviewThresholdNgn: '1000000', updatedBy: 'system', updatedAt: nowIso() };
}

export async function getNgnControls() {
  const existing = (await db.listNgnControls?.()) ?? [];
  const found = existing.find((item) => item.id === 'global');
  const defaults = defaultNgnControls();
  if (!found) return defaults;
  return {
    ...defaults,
    ...found,
    onrampEnabled: found.onrampEnabled ?? true,
    offrampEnabled: found.offrampEnabled ?? true,
  };
}

export async function updateNgnControls(input: z.infer<typeof updateNgnControlsSchema>) {
  const current = await getNgnControls();
  const next: NgnControlsRecord = { ...current, ...input, backupProvider: input.backupProvider === null ? undefined : input.backupProvider ?? current.backupProvider, updatedBy: input.updatedBy ?? 'admin_api_key', updatedAt: nowIso() };
  await db.upsertNgnControlsRecord(next);
  await createAuditLog({ actorType: 'admin', actorId: next.updatedBy, action: 'ngn.controls_updated', resourceType: 'payments_ngn_controls', resourceId: 'global', severity: 'warning', metadata: { previous: current, next } });
  return next;
}
