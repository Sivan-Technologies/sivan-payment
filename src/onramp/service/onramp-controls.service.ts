import { z } from 'zod';
import { createAuditLog } from '../../audit/audit.service.js';
import { env } from '../../config/env.js';
import { db } from '../../database/json-database.js';
import { forbidden } from '../../shared/errors.js';
import { nowIso } from '../../shared/id.js';

export const onrampControlsSchema = z.object({
  oneTimePaymentInstructionsEnabled: z.boolean().default(true),
  updatedBy: z.string().min(2).default('admin_api_key'),
  reason: z.string().max(1000).optional(),
});

export type OnrampControls = z.infer<typeof onrampControlsSchema> & { updatedAt: string };

function envDefaults(): OnrampControls {
  return {
    oneTimePaymentInstructionsEnabled: process.env.ONRAMP_ONE_TIME_PAYMENT_INSTRUCTIONS_ENABLED === 'false' ? false : true,
    updatedBy: 'env',
    reason: 'Environment fallback settings',
    updatedAt: nowIso(),
  };
}

export async function getOnrampControls() {
  const data = await db.read();
  const latest = (data.auditLogs ?? [])
    .filter((log) => log.action === 'onramp.controls.updated')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const saved = (latest?.metadata as any)?.settings as Partial<OnrampControls> | undefined;
  return {
    ...envDefaults(),
    ...(saved ?? {}),
    updatedBy: latest?.actorId ?? saved?.updatedBy ?? envDefaults().updatedBy,
    updatedAt: latest?.createdAt ?? saved?.updatedAt ?? envDefaults().updatedAt,
  };
}

export async function updateOnrampControls(input: z.infer<typeof onrampControlsSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const current = await getOnrampControls();
  const parsed = onrampControlsSchema.parse(input);
  const next: OnrampControls = { ...current, ...parsed, updatedAt: nowIso() };
  await createAuditLog({
    actorType: 'admin',
    actorId: parsed.updatedBy,
    action: 'onramp.controls.updated',
    resourceType: 'onramp_controls',
    resourceId: 'global',
    severity: 'warning',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { previous: current, settings: next, reason: parsed.reason ?? 'On-ramp controls update' },
  });
  return next;
}

export async function requireOneTimeOnrampEnabled() {
  const controls = await getOnrampControls();
  if (!controls.oneTimePaymentInstructionsEnabled) {
    throw forbidden('One-time on-ramp payment instructions are currently disabled.');
  }
  return controls;
}
