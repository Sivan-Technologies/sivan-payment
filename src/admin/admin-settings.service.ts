import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../database/json-database.js';
import { createAuditLog } from '../audit/audit.service.js';
import { badRequest } from '../shared/errors.js';
import { nowIso } from '../shared/id.js';

export const adminPlatformSettingsSchema = z.object({
  maintenanceMode: z.boolean().default(false),
  newUserSignups: z.boolean().default(true),
  instantPayouts: z.boolean().default(false),
  sanctionsScreening: z.boolean().default(true),
  deviceBinding: z.boolean().default(true),
  globalGeoBlock: z.boolean().default(true),
  onRampEnabled: z.boolean().default(true),
  offRampEnabled: z.boolean().default(true),
  usdtEnabled: z.boolean().default(true),
  /**
   * Bridge -> Privy auto-sweep, OFF until it has been exercised for real.
   *
   * The sweep moves a settled virtual-account deposit out of the Bridge
   * custodial wallet into the user's own Privy wallet. It fires from a webhook
   * and signs an on-chain transfer, so the failure mode is somebody's money in
   * the wrong custody with no user-visible trace. It shipped with no switch at
   * all: the only gate was BRIDGE_TO_PRIVY_MIN_SWEEP_USD, which decides HOW
   * MUCH to sweep, never WHETHER to.
   *
   * Default false. Capability controls fail closed -- an operator turning this
   * on is an explicit decision, and a fresh database or a failed settings read
   * must not start moving funds on its own.
   *
   * Turning it off does NOT strand anyone: a user whose balance stays in the
   * Bridge wallet can still send it, because transfers resolve the wallet's
   * own provider rather than the deployment-wide active one.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * @deprecated NOT THE SWITCH ANY MORE. Use `autoSweepBridgeWallet` on
   * wallet-controls.service.ts (Admin hub -> Wallets tab).
   *
   * This setting and that one were both created for the same capability, by
   * two people, and the sweep guard OR'd them together - so either alone
   * opened a gate that moves customer funds, and turning EITHER one off did
   * not stop it. An operator cannot trust a kill-switch that behaves that way.
   *
   * The field is retained rather than deleted so that:
   *   - a stored `true` in an existing database does not fail schema parsing,
   *   - the value can still be READ and reported when it disagrees with the
   *     real switch (bridge-to-privy-sweep.service.ts does exactly that),
   *   - and no migration is needed during launch week.
   *
   * It no longer enables anything on its own. Do not add new readers.
   * ─────────────────────────────────────────────────────────────────────────
   */
  bridgeToPrivySweepEnabled: z.boolean().default(false),
  updatedBy: z.string().min(2).default('admin_api_key'),
  reason: z.string().max(1000).optional()
});

export type AdminPlatformSettings = z.infer<typeof adminPlatformSettingsSchema>;

const defaultPlatformSettings = (): AdminPlatformSettings & { updatedAt: string } => ({
  maintenanceMode: false,
  newUserSignups: true,
  instantPayouts: false,
  sanctionsScreening: true,
  deviceBinding: true,
  globalGeoBlock: true,
  onRampEnabled: true,
  offRampEnabled: true,
  usdtEnabled: true,
  // OFF for launch. See the schema above for why this fails closed.
  bridgeToPrivySweepEnabled: false,
  updatedBy: 'system',
  reason: 'Default platform settings',
  updatedAt: nowIso()
});

/**
 * Platform settings, read on EVERY mutating request by the app.ts preHandler.
 *
 * This used to call db.read(), which loads all 28 tables - including an
 * unbounded `select * from payments_audit_logs` - to find a single row. On the
 * deployed test API that made a signup POST take 146 SECONDS while GET /health
 * answered in 0.08s, and it degrades further as the audit log grows.
 *
 * Found by driving the real frontend in a browser: the gateway returned
 * UPSTREAM_UNAVAILABLE on signup and nothing in any test suite had caught it,
 * because every suite runs against a database with a handful of rows.
 */
export async function getAdminPlatformSettings() {
  const latest = await db.latestAuditLogByAction('admin.platform_settings.updated');
  if (!latest) return defaultPlatformSettings();
  return { ...defaultPlatformSettings(), ...((latest.metadata as any)?.settings ?? {}), updatedBy: latest.actorId ?? 'admin_api_key', updatedAt: latest.createdAt };
}

export async function updateAdminPlatformSettings(input: z.infer<typeof adminPlatformSettingsSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const current = await getAdminPlatformSettings();
  const { updatedBy, reason, ...settings } = input;
  const next = { ...current, ...settings, updatedBy, reason, updatedAt: nowIso() };
  await createAuditLog({
    actorType: 'admin',
    actorId: updatedBy,
    action: 'admin.platform_settings.updated',
    resourceType: 'admin_platform_settings',
    resourceId: 'global',
    severity: 'warning',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { previous: current, settings: next, reason }
  });
  return next;
}

export function isPlatformMutationBlocked(settings: Awaited<ReturnType<typeof getAdminPlatformSettings>>, method: string, url: string) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return undefined;
  if (url.startsWith('/api/admin') || url.startsWith('/api/webhooks')) return undefined;
  if (settings.maintenanceMode && [/^\/api\/external-accounts/, /^\/api\/withdrawals$/, /^\/api\/onramp\/orders$/].some((pattern) => pattern.test(url))) return 'Sivan is in maintenance mode. New payment actions are temporarily unavailable.';
  if (!settings.onRampEnabled && url === '/api/onramp/orders') return 'On-ramp orders are temporarily disabled.';
  if (!settings.offRampEnabled && url === '/api/withdrawals') return 'Off-ramp withdrawals are temporarily disabled.';
  return undefined;
}

export async function getAdminTeamMembers() {
  const data = await db.read();
  const latest = (data.auditLogs ?? [])
    .filter((log) => log.action === 'admin.team_members.updated')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const fallback = [
    { name: 'Sivan Admin', email: 'admin@sivantech.online', role: 'Super Admin', status: 'active' },
    { name: 'Operations', email: 'ops@sivantech.online', role: 'Operator', status: 'active' },
    { name: 'Compliance', email: 'compliance@sivantech.online', role: 'Compliance', status: 'active' }
  ];
  return (latest?.metadata as any)?.members ?? fallback;
}


export async function inviteAdminTeamMember(input: { name: string; email: string; role: string; invitedBy?: string; reason?: string }, context: { ipAddress?: string; userAgent?: string } = {}) {
  const current = await getAdminTeamMembers();
  const normalizedEmail = input.email.toLowerCase();
  if (current.some((member: any) => String(member.email).toLowerCase() === normalizedEmail)) {
    return { invited: false, duplicate: true, members: current };
  }
  const invited = { name: input.name, email: normalizedEmail, role: input.role, status: 'invited', invitedAt: nowIso() };
  const members = [...current, invited];
  await createAuditLog({
    actorType: 'admin',
    actorId: input.invitedBy ?? 'admin_api_key',
    action: 'admin.team_member_invited',
    resourceType: 'admin_team_member',
    resourceId: normalizedEmail,
    severity: 'warning',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { invited, reason: input.reason ?? 'Team invitation from admin settings' }
  });
  await createAuditLog({
    actorType: 'admin',
    actorId: input.invitedBy ?? 'admin_api_key',
    action: 'admin.team_members.updated',
    resourceType: 'admin_team_members',
    resourceId: 'global',
    severity: 'warning',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { members }
  });
  return { invited: true, member: invited, members };
}

export async function getAdminApiKeyInventory() {
  const data = await db.read();
  const rotations = (data.auditLogs ?? [])
    .filter((log) => log.action === 'admin.api_key_rotation_requested')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const last = (key: string) => rotations.find((log) => (log.metadata as any)?.key === key)?.createdAt;
  return [
    { key: 'bridgeApiKey', label: 'Bridge API', masked: maskConfigured(env.BRIDGE_API_KEY, 'brg'), configured: Boolean(env.BRIDGE_API_KEY), lastRotatedAt: last('bridgeApiKey') },
    { key: 'bridgeWebhookPublicKey', label: 'Bridge webhook public key', masked: env.BRIDGE_WEBHOOK_PUBLIC_KEY ? '-----BEGIN PUBLIC KEY-----••••' : 'not configured', configured: Boolean(env.BRIDGE_WEBHOOK_PUBLIC_KEY), lastRotatedAt: last('bridgeWebhookPublicKey') },
    { key: 'resendApiKey', label: 'Resend email', masked: maskConfigured(env.RESEND_API_KEY, 're'), configured: Boolean(env.RESEND_API_KEY), lastRotatedAt: last('resendApiKey') },
    { key: 'sentryDsn', label: 'Sentry monitoring', masked: env.SENTRY_DSN ? 'https://••••@sentry.io' : 'not configured', configured: Boolean(env.SENTRY_DSN), lastRotatedAt: last('sentryDsn') },
    { key: 'r2Uploads', label: 'R2 uploads', masked: env.R2_BUCKET ? `${env.R2_BUCKET.slice(0, 4)}••••` : 'not configured', configured: Boolean(env.R2_BUCKET && env.R2_ACCESS_KEY_ID), lastRotatedAt: last('r2Uploads') }
  ];
}

export async function requestApiKeyRotation(input: { key: string; requestedBy?: string; reason?: string }, context: { ipAddress?: string; userAgent?: string } = {}) {
  const allowed = ['bridgeApiKey', 'bridgeWebhookPublicKey', 'resendApiKey', 'sentryDsn', 'r2Uploads'];
  if (!allowed.includes(input.key)) throw badRequest('Unknown API key');
  await createAuditLog({
    actorType: 'admin',
    actorId: input.requestedBy ?? 'admin_api_key',
    action: 'admin.api_key_rotation_requested',
    resourceType: 'admin_api_key',
    resourceId: input.key,
    severity: 'warning',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { key: input.key, reason: input.reason ?? 'Rotation requested from admin settings' }
  });
  return { requested: true, key: input.key };
}

export async function buildAllAdminExport() {
  const data = await db.read();
  return {
    exportedAt: nowIso(),
    users: data.users,
    customers: data.customers,
    externalAccounts: data.externalAccounts,
    withdrawals: data.withdrawals,
    onrampOrders: data.onrampOrders ?? [],
    supportTickets: data.supportTickets ?? [],
    legalAcceptances: data.legalAcceptances ?? [],
    auditLogs: data.auditLogs ?? [],
    reconciliationRuns: data.reconciliationRuns ?? [],
    reconciliationFindings: data.reconciliationFindings ?? [],
    webhookEvents: data.webhookEvents ?? []
  };
}

function maskConfigured(value: string | undefined, prefix: string) {
  if (!value) return 'not configured';
  return `${prefix}_••••••••${value.slice(-4)}`;
}
