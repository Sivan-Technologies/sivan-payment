import crypto from 'node:crypto';
import { z } from 'zod';
import { createAuditLog } from '../audit/audit.service.js';
import { env } from '../config/env.js';
import { db } from '../database/json-database.js';
import type { CustomerIdentityLinkRecord, IdentityPairingTokenRecord, UserRecord } from '../database/types.js';
import { badRequest, forbidden, notFound } from '../shared/errors.js';
import { id, nowIso } from '../shared/id.js';

const TOKEN_PREFIX = 'SVP';

export const redeemIdentityLinkSchema = z.object({
  token: z.string().min(6).max(32),
  whatsappNumber: z.string().min(8).max(32),
  escrowUserId: z.string().min(2).max(120).optional(),
});

const normalizeEmail = (value: string) => value.trim().toLowerCase();

export const normalizeWhatsappNumber = (value: string) => {
  const trimmed = value.trim();
  if (trimmed.startsWith('whatsapp:')) return `whatsapp:+${trimmed.replace(/^whatsapp:\+?/, '').replace(/\D/g, '')}`;
  return `whatsapp:+${trimmed.replace(/^\+?/, '').replace(/\D/g, '')}`;
};

function tokenHash(token: string) {
  return crypto.createHash('sha256').update(`${token.toUpperCase().trim()}:${env.USER_JWT_SECRET}`).digest('hex');
}

function generatePairingToken() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  let left = '';
  let right = '';
  for (let i = 0; i < 4; i += 1) left += letters[crypto.randomInt(0, letters.length)];
  for (let i = 0; i < 2; i += 1) right += digits[crypto.randomInt(0, digits.length)];
  return `${TOKEN_PREFIX}-${left}-${right}`;
}

function publicLink(link: CustomerIdentityLinkRecord | undefined) {
  if (!link || link.status !== 'linked') return null;
  return {
    id: link.id,
    status: link.status,
    paymentUserId: link.paymentUserId,
    escrowUserId: link.escrowUserId,
    email: link.email,
    whatsappNumber: link.whatsappNumber,
    linkedAt: link.linkedAt,
  };
}

function publicToken(token: IdentityPairingTokenRecord | undefined) {
  if (!token || token.status !== 'pending') return null;
  return {
    id: token.id,
    status: token.status,
    expiresAt: token.expiresAt,
    createdAt: token.createdAt,
  };
}

async function activeLinkForPaymentUser(userId: string) {
  const links = await db.listCustomerIdentityLinks();
  return links.find((item) => item.paymentUserId === userId && item.status === 'linked');
}

async function activeLinkForWhatsapp(whatsappNumber: string) {
  const links = await db.listCustomerIdentityLinks();
  return links.find((item) => item.whatsappNumber === whatsappNumber && item.status === 'linked');
}

async function pendingTokenForPaymentUser(userId: string) {
  const now = nowIso();
  const tokens = await db.listIdentityPairingTokens();
  return tokens
    .filter((item) => item.paymentUserId === userId && item.status === 'pending' && item.expiresAt > now)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function inferChannel(user: UserRecord): UserRecord['primaryChannel'] {
  if (user.email && user.whatsappNumber) return 'both';
  if (user.whatsappNumber) return 'whatsapp';
  return 'email';
}

export async function getIdentityStatus(userId: string) {
  const user = await db.findUserById(userId);
  if (!user) throw notFound('User');
  const link = await activeLinkForPaymentUser(userId);
  const token = await pendingTokenForPaymentUser(userId);
  return {
    linked: Boolean(link),
    link: publicLink(link),
    pendingPairing: publicToken(token),
  };
}

export async function startWhatsappLink(userId: string, context: { ipAddress?: string; userAgent?: string } = {}) {
  const user = await db.findUserById(userId);
  if (!user) throw notFound('User');
  if (!user.emailVerifiedAt) throw forbidden('Verify your email before linking WhatsApp.');

  const existingLink = await activeLinkForPaymentUser(userId);
  if (existingLink) {
    return { linked: true, link: publicLink(existingLink), token: null };
  }

  const existingPending = await pendingTokenForPaymentUser(userId);
  if (existingPending) {
    return { linked: false, token: publicToken(existingPending), message: 'A valid pairing code already exists. Cancel it before generating a new one.' };
  }

  const token = generatePairingToken();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + env.IDENTITY_PAIRING_TOKEN_EXPIRES_MINUTES * 60 * 1000).toISOString();
  const record: IdentityPairingTokenRecord = {
    id: id('idpair'),
    paymentUserId: userId,
    tokenHash: tokenHash(token),
    status: 'pending',
    expiresAt,
    createdAt: now,
    updatedAt: now,
  };
  await db.upsertIdentityPairingTokenRecord(record);
  await createAuditLog({
    actorType: 'user',
    actorId: userId,
    action: 'identity.whatsapp_pairing_started',
    resourceType: 'customer_identity',
    resourceId: userId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { expiresAt },
  });
  return { linked: false, token, expiresAt, instructions: 'Send this code to Sivan on WhatsApp to link your Escrow account.' };
}

export async function cancelWhatsappLink(userId: string, context: { ipAddress?: string; userAgent?: string } = {}) {
  const pending = await pendingTokenForPaymentUser(userId);
  if (!pending) return { canceled: false, message: 'No active pairing code.' };
  const now = nowIso();
  await db.upsertIdentityPairingTokenRecord({ ...pending, status: 'canceled', canceledAt: now, updatedAt: now });
  await createAuditLog({ actorType: 'user', actorId: userId, action: 'identity.whatsapp_pairing_canceled', resourceType: 'customer_identity', resourceId: userId, ipAddress: context.ipAddress, userAgent: context.userAgent });
  return { canceled: true };
}

export async function unlinkWhatsappIdentity(userId: string, context: { ipAddress?: string; userAgent?: string } = {}) {
  const link = await activeLinkForPaymentUser(userId);
  if (!link) return { unlinked: false, message: 'No linked WhatsApp identity.' };
  const user = await db.findUserById(userId);
  const now = nowIso();
  await db.upsertCustomerIdentityLinkRecord({ ...link, status: 'unlinked', unlinkedAt: now, updatedAt: now });
  if (user) {
    const updated: UserRecord = { ...user, whatsappNumber: undefined, whatsappVerifiedAt: undefined, primaryChannel: inferChannel({ ...user, whatsappNumber: undefined }), updatedAt: now };
    await db.updateUserRecord(updated);
  }
  await createAuditLog({ actorType: 'user', actorId: userId, action: 'identity.whatsapp_unlinked', resourceType: 'customer_identity', resourceId: link.id, ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { whatsappNumber: link.whatsappNumber, escrowUserId: link.escrowUserId } });
  return { unlinked: true };
}

export async function redeemWhatsappLink(input: z.infer<typeof redeemIdentityLinkSchema>, context: { source?: string; ipAddress?: string; userAgent?: string } = {}) {
  const parsed = redeemIdentityLinkSchema.parse(input);
  const tokenClean = parsed.token.toUpperCase().trim();
  const whatsappNumber = normalizeWhatsappNumber(parsed.whatsappNumber);
  const now = nowIso();
  const tokens = await db.listIdentityPairingTokens();
  const token = tokens.find((item) => item.tokenHash === tokenHash(tokenClean));
  if (!token || token.status !== 'pending') throw badRequest('Invalid or expired pairing code.');
  if (token.expiresAt <= now) {
    await db.upsertIdentityPairingTokenRecord({ ...token, status: 'expired', updatedAt: now });
    throw badRequest('Pairing code has expired. Generate a new code from your Sivan web dashboard.');
  }

  const user = await db.findUserById(token.paymentUserId);
  if (!user) throw notFound('Payment user');

  const linkForWhatsapp = await activeLinkForWhatsapp(whatsappNumber);
  if (linkForWhatsapp && linkForWhatsapp.paymentUserId !== user.id) throw badRequest('This WhatsApp number is already linked to another Sivan payment account.');
  const linkForUser = await activeLinkForPaymentUser(user.id);
  if (linkForUser && linkForUser.whatsappNumber !== whatsappNumber) throw badRequest('This Sivan payment account is already linked to another WhatsApp number.');

  const updatedUser: UserRecord = {
    ...user,
    whatsappNumber,
    whatsappVerifiedAt: now,
    primaryChannel: 'both',
    updatedAt: now,
  };
  await db.updateUserRecord(updatedUser);

  const link: CustomerIdentityLinkRecord = linkForUser ?? {
    id: id('identity'),
    paymentUserId: user.id,
    email: normalizeEmail(user.email),
    whatsappNumber,
    status: 'linked',
    createdAt: now,
    updatedAt: now,
  };
  const savedLink: CustomerIdentityLinkRecord = {
    ...link,
    escrowUserId: parsed.escrowUserId ?? link.escrowUserId,
    email: normalizeEmail(user.email),
    whatsappNumber,
    status: 'linked',
    linkedAt: link.linkedAt ?? now,
    updatedAt: now,
    metadata: { ...(typeof link.metadata === 'object' && link.metadata ? link.metadata as Record<string, unknown> : {}), source: context.source ?? 'whatsapp', redeemedAt: now },
  };
  await db.upsertCustomerIdentityLinkRecord(savedLink);
  await db.upsertIdentityPairingTokenRecord({ ...token, status: 'redeemed', redeemedAt: now, whatsappNumber, escrowUserId: parsed.escrowUserId, updatedAt: now });
  await createAuditLog({ actorType: 'system', actorId: 'identity_link_service', action: 'identity.whatsapp_linked', resourceType: 'customer_identity', resourceId: savedLink.id, ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { paymentUserId: user.id, escrowUserId: parsed.escrowUserId, whatsappNumber } });

  return {
    linked: true,
    link: publicLink(savedLink),
    paymentUser: { id: updatedUser.id, email: updatedUser.email, fullName: updatedUser.fullName, whatsappNumber: updatedUser.whatsappNumber },
  };
}
