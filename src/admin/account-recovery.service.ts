import crypto from 'node:crypto';
import { z } from 'zod';
import { createAuditLog } from '../audit/audit.service.js';
import { db } from '../database/json-database.js';
import type { UserRecord } from '../database/types.js';
import { badRequest, conflict, notFound } from '../shared/errors.js';
import { nowIso } from '../shared/id.js';
import { sendEmail } from '../notifications/email.service.js';
import { env } from '../config/env.js';
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
export const userEmailChangeConfirmSchema = z.object({ requestId: z.string().min(6), code: z.string().min(4).max(12) });

function requireEvidence(input: { supportTicketId?: string; evidenceUrl?: string }, action: string) {
  if (!input.supportTicketId && !input.evidenceUrl) throw badRequest(`${action} requires a support ticket ID or evidence URL.`);
}

function recoveryId(prefix = 'ar') { return `${prefix}_${crypto.randomUUID()}`; }
function generateCode() { return String(crypto.randomInt(100000, 1000000)); }
function hashEmailChangeCode(userId: string, newEmail: string, code: string) { return crypto.createHash('sha256').update(`${userId}:${newEmail}:${code}:${env.USER_JWT_SECRET}`).digest('hex'); }
function customerAppUrl() {
  const firstCorsOrigin = env.CORS_ORIGIN.split(',').map((item) => item.trim()).find((item) => item && item !== '*');
  return (env.CUSTOMER_APP_URL || firstCorsOrigin || env.APP_URL).replace(/\/$/, '');
}
function emailChangeConfirmationUrl(userId: string, requestId: string) {
  const url = new URL('/email-recovery/confirm', customerAppUrl());
  url.searchParams.set('userId', userId);
  url.searchParams.set('requestId', requestId);
  return url.toString();
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
  const requestId = recoveryId('email');
  const code = generateCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const confirmationUrl = emailChangeConfirmationUrl(userId, requestId);
  if (!input.emergencyOverride) {
    await sendEmail({
      to: input.newEmail,
      subject: 'Confirm your Sivan email change',
      text: `Sivan Support started an email change for your account. Your confirmation code is ${code}. It expires in 15 minutes. Recovery reference: ${requestId}. Confirm here: ${confirmationUrl}. If you did not request this, contact Sivan Support immediately.`,
      html: `<div style="font-family: Inter, Arial, sans-serif; background:#07090d; color:#eef3f7; padding:32px;"><div style="max-width:560px; margin:0 auto; background:#0e141b; border:1px solid rgba(154,179,202,.18); border-radius:16px; padding:28px;"><p style="color:#74ddbe; text-transform:uppercase; letter-spacing:.12em; font-size:12px; font-weight:800; margin:0 0 12px;">Sivan Payments</p><h1 style="margin:0 0 12px; font-size:26px; line-height:1.15;">Confirm your email change</h1><p style="color:#a9b8c7; line-height:1.6;">Sivan Support started an email recovery request for your account. Use this code to confirm the new email address.</p><div style="font-size:34px; letter-spacing:.24em; font-weight:900; color:#74ddbe; background:rgba(116,221,190,.08); border:1px solid rgba(116,221,190,.28); border-radius:12px; padding:18px 20px; text-align:center; margin:24px 0;">${code}</div><p style="color:#a9b8c7;">Recovery reference: <strong>${requestId}</strong></p><p style="color:#a9b8c7;">This code expires in 15 minutes.</p><p><a href="${confirmationUrl}" style="display:inline-block; color:#06110f; background:#74ddbe; padding:12px 18px; border-radius:999px; text-decoration:none; font-weight:800;">Confirm email change</a></p><p style="color:#71809c; font-size:13px; line-height:1.6;">If you did not request this, do not share the code. Contact Sivan Support immediately.</p></div></div>`
    });
  }
  await audit({ actorId: input.actorId, action: 'user.email_change_started', userId, reason: input.reason, supportTicketId: input.supportTicketId, evidenceUrl: input.evidenceUrl, severity: 'warning', ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { requestId, currentEmail: user.email, newEmail: input.newEmail, emergencyOverride: input.emergencyOverride, status: input.emergencyOverride ? 'maker_checker_required' : 'pending_user_confirmation', codeHash: input.emergencyOverride ? undefined : hashEmailChangeCode(userId, input.newEmail, code), expiresAt, confirmationUrl } });
  return { started: true, requestId, status: input.emergencyOverride ? 'maker_checker_required' : 'pending_user_confirmation', currentEmail: user.email, newEmail: input.newEmail, expiresAt, confirmationUrl, devCode: env.AUTH_DEV_SHOW_OTP && !input.emergencyOverride ? code : undefined };
}

export async function confirmUserEmailChange(userId: string, input: z.infer<typeof userEmailChangeConfirmSchema>) {
  const user = await getUserOrThrow(userId);
  const data = await db.read();
  const started = (data.auditLogs ?? []).filter((log) => log.action === 'user.email_change_started' && log.resourceId === userId && (log.metadata as any)?.requestId === input.requestId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!started) throw notFound('Email change request');
  const metadata = started.metadata as any;
  if (metadata.status !== 'pending_user_confirmation') throw badRequest('Email change request is not waiting for user confirmation.');
  if (new Date(metadata.expiresAt).getTime() < Date.now()) throw badRequest('Email change code has expired. Ask support to start again.');
  if (hashEmailChangeCode(userId, metadata.newEmail, input.code) !== metadata.codeHash) throw badRequest('Invalid email change code.');
  if (data.users.some((item) => item.email?.toLowerCase() === String(metadata.newEmail).toLowerCase() && item.id !== userId)) throw conflict('Another Sivan user already uses this email.');
  const now = nowIso();
  const updated = { ...user, email: metadata.newEmail, emailVerifiedAt: now, updatedAt: now };
  await db.updateUserRecord(updated);
  await createAuditLog({ actorType: 'user', actorId: userId, action: 'user.email_change_confirmed', resourceType: 'account_recovery', resourceId: userId, severity: 'warning', metadata: { requestId: input.requestId, oldEmail: metadata.currentEmail, newEmail: metadata.newEmail } });
  await createAuditLog({ actorType: 'admin', actorId: started.actorId, action: 'user.email_admin_changed', resourceType: 'account_recovery', resourceId: userId, severity: 'warning', metadata: { requestId: input.requestId, oldEmail: metadata.currentEmail, newEmail: metadata.newEmail, confirmationMethod: 'new_email_otp' } });
  if (metadata.currentEmail) {
    void sendEmail({
      to: metadata.currentEmail,
      subject: 'Sivan account email changed',
      text: `The email on your Sivan account was changed to ${metadata.newEmail}. If this was not you, contact Sivan Support immediately. Recovery reference: ${input.requestId}.`,
      html: `<p>The email on your Sivan account was changed to <strong>${metadata.newEmail}</strong>.</p><p>If this was not you, contact Sivan Support immediately.</p><p>Recovery reference: <strong>${input.requestId}</strong></p>`
    }).catch((error) => console.warn('Failed to send old-email change alert', error));
  }
  return updated;
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
