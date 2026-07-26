import { z } from 'zod';
import { createAuditLog } from '../audit/audit.service.js';
import { db } from '../database/json-database.js';
import type { UserRecord } from '../database/types.js';
import { badRequest, conflict, notFound } from '../shared/errors.js';
import { nowIso } from '../shared/id.js';
import { checkUsernameAvailability, validateUsername } from '../users/username.service.js';
import { restrictUser } from './admin-hardening.service.js';

const recoveryBaseSchema = z.object({
  reason: z.string().min(8).max(2000),
  supportTicketId: z.string().min(2).max(120).optional(),
  evidenceUrl: z.string().url().optional(),
  actorId: z.string().min(2).default('admin_api_key')
});

export const adminChangeUsernameSchema = recoveryBaseSchema.extend({
  username: z.string().min(3).max(32),
  releaseLockedUsername: z.boolean().default(false)
});

export const adminResetTwoFactorSchema = recoveryBaseSchema.extend({
  identityReverified: z.boolean().default(false),
  createTemporaryHold: z.boolean().default(true)
});

export const adminRemoveAvatarSchema = recoveryBaseSchema;

export const adminNameCorrectionRequestSchema = recoveryBaseSchema.extend({
  requestedFullName: z.string().min(2).max(160),
  providerChecked: z.boolean().default(false)
});

export const adminEmailChangeRequestSchema = recoveryBaseSchema.extend({
  newEmail: z.string().email().transform((value) => value.toLowerCase()),
  emergencyOverride: z.boolean().default(false)
});

export const adminUnlinkWhatsappSchema = recoveryBaseSchema;

function requireEvidence(input: { supportTicketId?: string; evidenceUrl?: string }, action: string) {
  if (!input.supportTicketId && !input.evidenceUrl) throw badRequest(`${action} requires a support ticket ID or evidence URL.`);
}

async function getUserOrThrow(userId: string) {
  const user = await db.findUserById(userId);
  if (!user) throw notFound('User');
  return user;
}

async function audit(input: { actorId: string; action: string; userId: string; severity?: 'info' | 'warning' | 'error'; reason: string; supportTicketId?: string; evidenceUrl?: string; metadata?: Record<string, unknown>; ipAddress?: string; userAgent?: string }) {
  await createAuditLog({
    actorType: 'admin',
    actorId: input.actorId,
    action: input.action,
    resourceType: 'account_recovery',
    resourceId: input.userId,
    severity: input.severity ?? 'warning',
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    metadata: {
      reason: input.reason,
      supportTicketId: input.supportTicketId,
      evidenceUrl: input.evidenceUrl,
      ...input.metadata
    }
  });
}

export async function getAccountRecoveryControls(userId: string) {
  const data = await db.read();
  const user = data.users.find((item) => item.id === userId);
  if (!user) throw notFound('User');
  const customer = data.customers.find((item) => item.userId === userId) ?? null;
  const twoFactor = await db.getUserTwoFactorRecord(userId);
  const identityLink = (data.customerIdentityLinks ?? []).find((item) => item.paymentUserId === userId && item.status === 'linked') ?? null;
  const restrictions = (data.auditLogs ?? []).filter((log) => ['admin.user_restricted', 'admin.user_unrestricted'].includes(log.action) && log.resourceId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const recoveryAudit = (data.auditLogs ?? []).filter((log) => String(log.resourceType) === 'account_recovery' && log.resourceId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
  const supportTickets = (data.supportTickets ?? []).filter((ticket) => ticket.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
  return {
    user,
    customer,
    twoFactor: twoFactor ? { enabled: twoFactor.enabled, enabledAt: twoFactor.enabledAt, lastVerifiedAt: twoFactor.lastVerifiedAt, recoveryCodesRemaining: twoFactor.recoveryCodeHashes.length } : { enabled: false, recoveryCodesRemaining: 0 },
    identityLink,
    restrictions,
    supportTickets,
    recoveryAudit,
    warnings: [
      customer?.kycStatus === 'kyc_approved' ? 'Verified legal identity: name/email changes require support evidence and provider review.' : undefined,
      twoFactor?.enabled ? '2FA reset is high risk and should require identity re-verification.' : undefined,
      identityLink ? 'WhatsApp identity is linked; unlink only after support verification.' : undefined
    ].filter(Boolean)
  };
}

export async function adminChangeUsername(userId: string, input: z.infer<typeof adminChangeUsernameSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const user = await getUserOrThrow(userId);
  requireEvidence(input, 'Username recovery');
  const username = validateUsername(input.username);
  const availability = await checkUsernameAvailability(username, userId);
  if (!availability.available) throw conflict('This username is already taken or reserved.');
  const now = nowIso();
  const updated: UserRecord = { ...user, username, usernameUpdatedAt: now, updatedAt: now };
  await db.updateUserRecord(updated);
  await audit({ actorId: input.actorId, action: 'user.username_admin_updated', userId, reason: input.reason, supportTicketId: input.supportTicketId, evidenceUrl: input.evidenceUrl, ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { previousUsername: user.username, username, releaseLockedUsername: input.releaseLockedUsername } });
  return updated;
}

export async function adminRemoveAvatar(userId: string, input: z.infer<typeof adminRemoveAvatarSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const user = await getUserOrThrow(userId);
  const now = nowIso();
  const updated: UserRecord = { ...user, avatarUrl: undefined, avatarObjectKey: undefined, avatarUpdatedAt: now, updatedAt: now };
  await db.updateUserRecord(updated);
  await audit({ actorId: input.actorId, action: 'user.avatar_admin_removed', userId, reason: input.reason, supportTicketId: input.supportTicketId, evidenceUrl: input.evidenceUrl, ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { previousAvatarObjectKey: user.avatarObjectKey, previousAvatarUrl: user.avatarUrl } });
  return updated;
}

export async function adminResetTwoFactor(userId: string, input: z.infer<typeof adminResetTwoFactorSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  requireEvidence(input, '2FA reset');
  if (!input.identityReverified) throw badRequest('2FA reset requires identity re-verification confirmation.');
  const user = await getUserOrThrow(userId);
  const current = await db.getUserTwoFactorRecord(userId);
  const now = nowIso();
  if (current) await db.upsertUserTwoFactorRecord({ ...current, enabled: false, recoveryCodeHashes: [], enabledAt: undefined, lastVerifiedAt: undefined, updatedAt: now });
  if (input.createTemporaryHold) {
    await restrictUser(userId, { reason: `Temporary 24h hold after admin 2FA reset: ${input.reason}`, restrictedBy: input.actorId, restrictionType: 'all_payment_actions', expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }, context);
  }
  await audit({ actorId: input.actorId, action: 'user.2fa_admin_reset', userId, reason: input.reason, supportTicketId: input.supportTicketId, evidenceUrl: input.evidenceUrl, ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { userEmail: user.email, previousEnabled: Boolean(current?.enabled), temporaryHoldCreated: input.createTemporaryHold } });
  return { reset: true, twoFactorEnabled: false, temporaryHoldCreated: input.createTemporaryHold };
}

export async function adminRequestNameCorrection(userId: string, input: z.infer<typeof adminNameCorrectionRequestSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const user = await getUserOrThrow(userId);
  requireEvidence(input, 'Verified name correction');
  await audit({ actorId: input.actorId, action: 'user.verified_name_correction_requested', userId, reason: input.reason, supportTicketId: input.supportTicketId, evidenceUrl: input.evidenceUrl, ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { currentFullName: user.fullName, requestedFullName: input.requestedFullName, providerChecked: input.providerChecked, warning: 'Changing Sivan display/legal name does not update provider/KYC records.' } });
  return { requested: true, status: input.providerChecked ? 'pending_provider_review' : 'pending_evidence_review', currentFullName: user.fullName, requestedFullName: input.requestedFullName };
}

export async function adminStartEmailChange(userId: string, input: z.infer<typeof adminEmailChangeRequestSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const user = await getUserOrThrow(userId);
  requireEvidence(input, 'Email change');
  const data = await db.read();
  if (data.users.some((item) => item.email?.toLowerCase() === input.newEmail && item.id !== userId)) throw conflict('A user with this email already exists.');
  await audit({ actorId: input.actorId, action: 'user.email_change_started', userId, reason: input.reason, supportTicketId: input.supportTicketId, evidenceUrl: input.evidenceUrl, severity: 'warning', ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { currentEmail: user.email, newEmail: input.newEmail, emergencyOverride: input.emergencyOverride, status: input.emergencyOverride ? 'maker_checker_required' : 'pending_user_confirmation' } });
  return { started: true, status: input.emergencyOverride ? 'maker_checker_required' : 'pending_user_confirmation', currentEmail: user.email, newEmail: input.newEmail };
}

export async function adminUnlinkWhatsapp(userId: string, input: z.infer<typeof adminUnlinkWhatsappSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const data = await db.read();
  const link = (data.customerIdentityLinks ?? []).find((item) => item.paymentUserId === userId && item.status === 'linked');
  if (!link) return { unlinked: false, message: 'No linked WhatsApp identity.' };
  requireEvidence(input, 'WhatsApp unlink');
  const user = await getUserOrThrow(userId);
  const now = nowIso();
  await db.upsertCustomerIdentityLinkRecord({ ...link, status: 'unlinked', unlinkedAt: now, updatedAt: now });
  await db.updateUserRecord({ ...user, whatsappNumber: undefined, whatsappVerifiedAt: undefined, primaryChannel: user.email ? 'email' : 'whatsapp', updatedAt: now });
  await audit({ actorId: input.actorId, action: 'user.identity_unlinked_by_admin', userId, reason: input.reason, supportTicketId: input.supportTicketId, evidenceUrl: input.evidenceUrl, ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { whatsappNumber: link.whatsappNumber, escrowUserId: link.escrowUserId } });
  return { unlinked: true };
}
