import crypto from 'node:crypto';
import { z } from 'zod';
import { createAuditLog } from '../audit/audit.service.js';
import { env } from '../config/env.js';
import { db } from '../database/json-database.js';
import type { CustomerIdentityLinkRecord, IdentityChannel, IdentityPairingTokenRecord, UserRecord } from '../database/types.js';
import { badRequest, forbidden, notFound } from '../shared/errors.js';
import { id, nowIso } from '../shared/id.js';
import {
  assertPairingAttemptAllowed,
  clearPairingAttempts,
  recordFailedPairingAttempt
} from './pairing-attempts.js';

const TOKEN_PREFIX = 'SVP';

/**
 * Reject a redemption AND count it against the redeemer's attempt budget.
 *
 * Every rejection in both redeem paths goes through here rather than throwing
 * badRequest directly, because an uncounted rejection is a free guess. The
 * `never` return type lets call sites keep reading as plain `throw`-style
 * guards while making it impossible to reject without recording.
 */
function rejectPairing(channel: IdentityChannel, identity: string, message: string): never {
  recordFailedPairingAttempt(channel, identity);
  throw badRequest(message);
}


export const redeemIdentityLinkSchema = z.object({
  token: z.string().min(6).max(32),
  whatsappNumber: z.string().min(8).max(32),
  escrowUserId: z.string().min(2).max(120).optional(),
});

/**
 * Telegram redemption. Deliberately NOT the same schema as WhatsApp.
 *
 * The identity here is `telegramUserId`, taken from `message.from.id`, which
 * Telegram authenticates on every update and a client cannot forge. It is a
 * stronger binding than a phone number, which arrives via a contact card the
 * sender chooses - and Telegram lets you forward ANYONE's contact card.
 *
 * No phone is accepted at all. A Telegram user's phone is not needed to
 * identify them once the code proves which dashboard session they came from.
 */
export const redeemTelegramLinkSchema = z.object({
  token: z.string().min(6).max(32),
  telegramUserId: z.string().min(1).max(32),
  telegramUsername: z.string().min(1).max(64).optional(),
  escrowUserId: z.string().min(2).max(120).optional(),
});

/**
 * Rows written before migration 044 have no `channel`. The column default
 * backfills them to 'whatsapp', so the code must read them the same way or a
 * legacy link would match no channel at all and appear unlinked.
 */
const linkChannel = (link: Pick<CustomerIdentityLinkRecord, 'channel'>): IdentityChannel => link.channel ?? 'whatsapp';
const tokenChannel = (token: Pick<IdentityPairingTokenRecord, 'channel'>): IdentityChannel => token.channel ?? 'whatsapp';

const normalizeEmail = (value: string) => value.trim().toLowerCase();

export const normalizeWhatsappNumber = (value: string) => {
  const trimmed = value.trim();
  if (trimmed.startsWith('whatsapp:')) return `whatsapp:+${trimmed.replace(/^whatsapp:\+?/, '').replace(/\D/g, '')}`;
  return `whatsapp:+${trimmed.replace(/^\+?/, '').replace(/\D/g, '')}`;
};

function tokenHash(token: string) {
  return crypto.createHash('sha256').update(token.toUpperCase().trim()).digest('hex');
}

function legacyTokenHash(token: string) {
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
    channel: linkChannel(link),
    paymentUserId: link.paymentUserId,
    escrowUserId: link.escrowUserId,
    email: link.email,
    whatsappNumber: link.whatsappNumber,
    telegramUserId: link.telegramUserId,
    telegramUsername: link.telegramUsername,
    linkedAt: link.linkedAt,
  };
}

function publicToken(token: IdentityPairingTokenRecord | undefined) {
  if (!token || token.status !== 'pending') return null;
  return {
    id: token.id,
    status: token.status,
    channel: tokenChannel(token),
    expiresAt: token.expiresAt,
    createdAt: token.createdAt,
  };
}

/**
 * Scoped to a channel, mirroring the (payment_user_id, channel) unique index
 * from migration 044. Before that migration this was one link per user; a
 * lookup that ignored channel would now return whichever row happened to sort
 * first and could report a Telegram link when asked about WhatsApp.
 */
async function activeLinkForPaymentUser(userId: string, channel: IdentityChannel) {
  const links = await db.listCustomerIdentityLinks();
  return links.find((item) => item.paymentUserId === userId && item.status === 'linked' && linkChannel(item) === channel);
}

async function activeLinksForPaymentUser(userId: string) {
  const links = await db.listCustomerIdentityLinks();
  return links.filter((item) => item.paymentUserId === userId && item.status === 'linked');
}

async function activeLinkForWhatsapp(whatsappNumber: string) {
  const links = await db.listCustomerIdentityLinks();
  return links.find((item) => item.whatsappNumber === whatsappNumber && item.status === 'linked' && linkChannel(item) === 'whatsapp');
}

export async function activeLinkForTelegram(telegramUserId: string) {
  const links = await db.listCustomerIdentityLinks();
  return links.find((item) => item.telegramUserId === telegramUserId && item.status === 'linked' && linkChannel(item) === 'telegram');
}

async function pendingTokenForPaymentUser(userId: string, channel: IdentityChannel) {
  const now = nowIso();
  const tokens = await db.listIdentityPairingTokens();
  return tokens
    .filter((item) => item.paymentUserId === userId && item.status === 'pending' && item.expiresAt > now && tokenChannel(item) === channel)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/**
 * 'both' means email + at least one messaging channel, which is what the
 * notification router keys off. It deliberately does not try to encode WHICH
 * messaging channels are live - that is what customer_identity_links is for,
 * and duplicating it here would give two sources of truth that drift.
 */
function inferChannel(user: UserRecord): UserRecord['primaryChannel'] {
  const hasMessaging = Boolean(user.whatsappNumber || user.telegramUserId);
  if (user.email && hasMessaging) return 'both';
  if (user.whatsappNumber) return 'whatsapp';
  if (user.telegramUserId) return 'telegram';
  return 'email';
}

/**
 * Both channels, always. A caller that only wants one still gets a stable
 * shape, and the UI can render two cards without a second round trip.
 */
export async function getIdentityStatus(userId: string) {
  const user = await db.findUserById(userId);
  if (!user) throw notFound('User');
  const links = await activeLinksForPaymentUser(userId);
  const whatsappLink = links.find((item) => linkChannel(item) === 'whatsapp');
  const telegramLink = links.find((item) => linkChannel(item) === 'telegram');
  const whatsappPending = await pendingTokenForPaymentUser(userId, 'whatsapp');
  const telegramPending = await pendingTokenForPaymentUser(userId, 'telegram');

  return {
    // Kept for existing callers: true when ANY channel is linked.
    linked: links.length > 0,
    link: publicLink(whatsappLink),
    pendingPairing: publicToken(whatsappPending),
    channels: {
      whatsapp: { linked: Boolean(whatsappLink), link: publicLink(whatsappLink), pendingPairing: publicToken(whatsappPending) },
      telegram: { linked: Boolean(telegramLink), link: publicLink(telegramLink), pendingPairing: publicToken(telegramPending) },
    },
  };
}

const CHANNEL_LABEL: Record<IdentityChannel, string> = { whatsapp: 'WhatsApp', telegram: 'Telegram' };

export async function startChannelLink(userId: string, channel: IdentityChannel, context: { ipAddress?: string; userAgent?: string } = {}) {
  const user = await db.findUserById(userId);
  if (!user) throw notFound('User');
  if (!user.emailVerifiedAt) throw forbidden(`Verify your email before linking ${CHANNEL_LABEL[channel]}.`);

  const existingLink = await activeLinkForPaymentUser(userId, channel);
  if (existingLink) {
    return { linked: true, link: publicLink(existingLink), token: null };
  }

  const existingPending = await pendingTokenForPaymentUser(userId, channel);
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
    channel,
    status: 'pending',
    expiresAt,
    createdAt: now,
    updatedAt: now,
  };
  await db.upsertIdentityPairingTokenRecord(record);
  await createAuditLog({
    actorType: 'user',
    actorId: userId,
    action: `identity.${channel}_pairing_started`,
    resourceType: 'customer_identity',
    resourceId: userId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { expiresAt, channel },
  });
  const instructions = channel === 'telegram'
    ? 'Open Sivan on Telegram and send this code to link your account.'
    : 'Send this code to Sivan on WhatsApp to link your Escrow account.';
  return { linked: false, token, expiresAt, channel, instructions };
}

export async function cancelChannelLink(userId: string, channel: IdentityChannel, context: { ipAddress?: string; userAgent?: string } = {}) {
  const pending = await pendingTokenForPaymentUser(userId, channel);
  if (!pending) return { canceled: false, message: 'No active pairing code.' };
  const now = nowIso();
  await db.upsertIdentityPairingTokenRecord({ ...pending, status: 'canceled', canceledAt: now, updatedAt: now });
  await createAuditLog({ actorType: 'user', actorId: userId, action: `identity.${channel}_pairing_canceled`, resourceType: 'customer_identity', resourceId: userId, ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { channel } });
  return { canceled: true };
}

export async function unlinkChannelIdentity(userId: string, channel: IdentityChannel, context: { ipAddress?: string; userAgent?: string } = {}) {
  const link = await activeLinkForPaymentUser(userId, channel);
  if (!link) return { unlinked: false, message: `No linked ${CHANNEL_LABEL[channel]} identity.` };
  const user = await db.findUserById(userId);
  const now = nowIso();
  await db.upsertCustomerIdentityLinkRecord({ ...link, status: 'unlinked', unlinkedAt: now, updatedAt: now });
  if (user) {
    // Clear only the channel being unlinked. Wiping both would silently
    // disconnect WhatsApp when a user detaches Telegram.
    const cleared: UserRecord = channel === 'whatsapp'
      ? { ...user, whatsappNumber: undefined, whatsappVerifiedAt: undefined }
      : { ...user, telegramUserId: undefined, telegramUsername: undefined, telegramVerifiedAt: undefined };
    await db.updateUserRecord({ ...cleared, primaryChannel: inferChannel(cleared), updatedAt: now });
  }
  await createAuditLog({ actorType: 'user', actorId: userId, action: `identity.${channel}_unlinked`, resourceType: 'customer_identity', resourceId: link.id, ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { channel, whatsappNumber: link.whatsappNumber, telegramUserId: link.telegramUserId, escrowUserId: link.escrowUserId } });
  return { unlinked: true };
}

// WhatsApp-named wrappers. whatsapp-bot and ace-whatsapp.service.ts import
// these by name; keeping them means the Telegram work touches no WhatsApp code.
export const startWhatsappLink = (userId: string, context: { ipAddress?: string; userAgent?: string } = {}) => startChannelLink(userId, 'whatsapp', context);
export const cancelWhatsappLink = (userId: string, context: { ipAddress?: string; userAgent?: string } = {}) => cancelChannelLink(userId, 'whatsapp', context);
export const unlinkWhatsappIdentity = (userId: string, context: { ipAddress?: string; userAgent?: string } = {}) => unlinkChannelIdentity(userId, 'whatsapp', context);

export const startTelegramLink = (userId: string, context: { ipAddress?: string; userAgent?: string } = {}) => startChannelLink(userId, 'telegram', context);
export const cancelTelegramLink = (userId: string, context: { ipAddress?: string; userAgent?: string } = {}) => cancelChannelLink(userId, 'telegram', context);
export const unlinkTelegramIdentity = (userId: string, context: { ipAddress?: string; userAgent?: string } = {}) => unlinkChannelIdentity(userId, 'telegram', context);

export async function redeemWhatsappLink(input: z.infer<typeof redeemIdentityLinkSchema>, context: { source?: string; ipAddress?: string; userAgent?: string } = {}) {
  const parsed = redeemIdentityLinkSchema.parse(input);
  const tokenClean = parsed.token.toUpperCase().trim();
  const whatsappNumber = normalizeWhatsappNumber(parsed.whatsappNumber);
  const now = nowIso();

  // See the matching call in redeemTelegramLink: before the lookup, so a
  // locked-out caller cannot tell a real code from a wrong one.
  assertPairingAttemptAllowed('whatsapp', whatsappNumber);

  const tokens = await db.listIdentityPairingTokens();
  const cleanHash = tokenHash(tokenClean);
  const legacyHash = legacyTokenHash(tokenClean);
  const token = tokens.find((item) => item.tokenHash === cleanHash || item.tokenHash === legacyHash);
  if (!token || token.status !== 'pending') rejectPairing('whatsapp', whatsappNumber, 'Invalid or expired pairing code.');

  // The token must have been ISSUED for WhatsApp. This mirrors the identical
  // check in redeemTelegramLink and must not be removed from either side:
  // without it, a code generated for one channel can be consumed by the other,
  // so whoever reaches the opposite bot first binds THEIR account to this user.
  // Legacy tokens predating migration 044 have no channel and read as
  // 'whatsapp', which is correct - they could only ever have been WhatsApp.
  if (tokenChannel(token) !== 'whatsapp') rejectPairing('whatsapp', whatsappNumber, 'That code was not issued for WhatsApp. Generate a WhatsApp code from your Sivan dashboard.');
  if (token.expiresAt <= now) {
    await db.upsertIdentityPairingTokenRecord({ ...token, status: 'expired', updatedAt: now });
    rejectPairing('whatsapp', whatsappNumber, 'Pairing code has expired. Generate a new code from your Sivan web dashboard.');
  }

  const user = await db.findUserById(token.paymentUserId);
  if (!user) throw notFound('Payment user');

  const linkForWhatsapp = await activeLinkForWhatsapp(whatsappNumber);
  if (linkForWhatsapp && linkForWhatsapp.paymentUserId !== user.id) rejectPairing('whatsapp', whatsappNumber, 'This WhatsApp number is already linked to another Sivan payment account.');
  const linkForUser = await activeLinkForPaymentUser(user.id, 'whatsapp');
  if (linkForUser && linkForUser.whatsappNumber !== whatsappNumber) rejectPairing('whatsapp', whatsappNumber, 'This Sivan payment account is already linked to another WhatsApp number.');

  const existingUserWithWhatsapp = await db.findUserByWhatsappNumber(whatsappNumber);
  if (existingUserWithWhatsapp && existingUserWithWhatsapp.id !== user.id) {
    rejectPairing('whatsapp', whatsappNumber, 'This WhatsApp number is already linked to another Sivan payment account.');
  }


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
    channel: 'whatsapp',
    whatsappNumber,
    status: 'linked',
    createdAt: now,
    updatedAt: now,
  };
  const savedLink: CustomerIdentityLinkRecord = {
    ...link,
    escrowUserId: parsed.escrowUserId ?? link.escrowUserId,
    email: normalizeEmail(user.email),
    channel: 'whatsapp',
    whatsappNumber,
    status: 'linked',
    linkedAt: link.linkedAt ?? now,
    updatedAt: now,
    metadata: { ...(typeof link.metadata === 'object' && link.metadata ? link.metadata as Record<string, unknown> : {}), source: context.source ?? 'whatsapp', redeemedAt: now },
  };
  await db.upsertCustomerIdentityLinkRecord(savedLink);
  await db.upsertIdentityPairingTokenRecord({ ...token, status: 'redeemed', redeemedAt: now, whatsappNumber, escrowUserId: parsed.escrowUserId, updatedAt: now });
  await createAuditLog({ actorType: 'system', actorId: 'identity_link_service', action: 'identity.whatsapp_linked', resourceType: 'customer_identity', resourceId: savedLink.id, ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { paymentUserId: user.id, escrowUserId: parsed.escrowUserId, whatsappNumber } });

  // Only unbroken runs of failure count. A user who mistyped twice before
  // getting it right starts clean next time.
  clearPairingAttempts('whatsapp', whatsappNumber);

  return {
    linked: true,

    link: publicLink(savedLink),
    paymentUser: { id: updatedUser.id, email: updatedUser.email, fullName: updatedUser.fullName, whatsappNumber: updatedUser.whatsappNumber },
  };
}

/**
 * Redeem a pairing code from Telegram.
 *
 * Structurally the WhatsApp twin, with two deliberate differences:
 *
 *   - The token must have been ISSUED for Telegram. Without that check either
 *     bot could redeem any pending code, so a user generating a WhatsApp code
 *     could have it consumed by whoever reached the Telegram bot first.
 *
 *   - No phone number is involved. The account keeps whatever phone it already
 *     had, which is what lets a user run WhatsApp on one number and Telegram on
 *     another and still be one Sivan account.
 */
export async function redeemTelegramLink(input: z.infer<typeof redeemTelegramLinkSchema>, context: { source?: string; ipAddress?: string; userAgent?: string } = {}) {
  const parsed = redeemTelegramLinkSchema.parse(input);
  const tokenClean = parsed.token.toUpperCase().trim();
  const telegramUserId = parsed.telegramUserId.trim();
  const now = nowIso();

  // Before the token lookup, so a locked-out caller learns nothing about
  // whether their guess was real. See pairing-attempts.ts.
  assertPairingAttemptAllowed('telegram', telegramUserId);

  const tokens = await db.listIdentityPairingTokens();
  const cleanHash = tokenHash(tokenClean);
  const legacyHash = legacyTokenHash(tokenClean);
  const token = tokens.find((item) => item.tokenHash === cleanHash || item.tokenHash === legacyHash);
  if (!token || token.status !== 'pending') rejectPairing('telegram', telegramUserId, 'Invalid or expired pairing code.');
  if (tokenChannel(token) !== 'telegram') rejectPairing('telegram', telegramUserId, 'That code was not issued for Telegram. Generate a Telegram code from your Sivan dashboard.');
  if (token.expiresAt <= now) {
    await db.upsertIdentityPairingTokenRecord({ ...token, status: 'expired', updatedAt: now });
    rejectPairing('telegram', telegramUserId, 'Pairing code has expired. Generate a new code from your Sivan web dashboard.');
  }

  const user = await db.findUserById(token.paymentUserId);
  if (!user) throw notFound('Payment user');

  const linkForTelegram = await activeLinkForTelegram(telegramUserId);
  if (linkForTelegram && linkForTelegram.paymentUserId !== user.id) rejectPairing('telegram', telegramUserId, 'This Telegram account is already linked to another Sivan payment account.');
  const linkForUser = await activeLinkForPaymentUser(user.id, 'telegram');
  if (linkForUser && linkForUser.telegramUserId !== telegramUserId) rejectPairing('telegram', telegramUserId, 'This Sivan payment account is already linked to another Telegram account.');


  const updatedUser: UserRecord = {
    ...user,
    telegramUserId,
    telegramUsername: parsed.telegramUsername ?? user.telegramUsername,
    telegramVerifiedAt: now,
    updatedAt: now,
  };
  await db.updateUserRecord({ ...updatedUser, primaryChannel: inferChannel(updatedUser) });

  const link: CustomerIdentityLinkRecord = linkForUser ?? {
    id: id('identity'),
    paymentUserId: user.id,
    email: normalizeEmail(user.email),
    channel: 'telegram',
    telegramUserId,
    status: 'linked',
    createdAt: now,
    updatedAt: now,
  };
  const savedLink: CustomerIdentityLinkRecord = {
    ...link,
    escrowUserId: parsed.escrowUserId ?? link.escrowUserId,
    email: normalizeEmail(user.email),
    channel: 'telegram',
    telegramUserId,
    telegramUsername: parsed.telegramUsername ?? link.telegramUsername,
    status: 'linked',
    linkedAt: link.linkedAt ?? now,
    updatedAt: now,
    metadata: { ...(typeof link.metadata === 'object' && link.metadata ? link.metadata as Record<string, unknown> : {}), source: context.source ?? 'telegram', redeemedAt: now },
  };
  await db.upsertCustomerIdentityLinkRecord(savedLink);
  await db.upsertIdentityPairingTokenRecord({ ...token, status: 'redeemed', redeemedAt: now, telegramUserId, escrowUserId: parsed.escrowUserId, updatedAt: now });
  await createAuditLog({ actorType: 'system', actorId: 'identity_link_service', action: 'identity.telegram_linked', resourceType: 'customer_identity', resourceId: savedLink.id, ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { paymentUserId: user.id, escrowUserId: parsed.escrowUserId, telegramUserId } });

  // See the WhatsApp twin: success ends the run of failures.
  clearPairingAttempts('telegram', telegramUserId);

  return {
    linked: true,

    link: publicLink(savedLink),
    paymentUser: {
      id: updatedUser.id,
      email: updatedUser.email,
      fullName: updatedUser.fullName,
      // The phone from the WhatsApp link, if there is one. The Telegram layer
      // needs it because the escrow API is addressed by phone; absent means
      // this user can pair and see balances but cannot yet create agreements.
      whatsappNumber: updatedUser.whatsappNumber,
      telegramUserId: updatedUser.telegramUserId,
    },
  };
}

/**
 * Resolve a Telegram account to its Sivan identity.
 *
 * The Telegram layer calls this on every action rather than caching, because
 * its session store is in-memory and a restart would otherwise appear to
 * un-link everyone.
 */
export async function lookupTelegramIdentity(telegramUserId: string) {
  const cleanId = telegramUserId.trim();
  const link = await activeLinkForTelegram(cleanId);
  if (link) {
    const user = await db.findUserById(link.paymentUserId);
    if (user) {
      const whatsappLink = await activeLinkForPaymentUser(user.id, 'whatsapp');
      const whatsappNumber = user.whatsappNumber || whatsappLink?.whatsappNumber || undefined;

      if (whatsappNumber && !user.whatsappNumber) {
        await db.updateUserRecord({ ...user, whatsappNumber, updatedAt: nowIso() }).catch(() => undefined);
      }

      return {
        linked: true as const,
        paymentUserId: user.id,
        escrowUserId: link.escrowUserId,
        email: user.email,
        fullName: user.fullName,
        whatsappNumber,
        canTransact: true,
      };
    }
  }

  const user = await db.findUserByTelegramUserId(cleanId);
  if (user) {
    const whatsappLink = await activeLinkForPaymentUser(user.id, 'whatsapp');
    const whatsappNumber = user.whatsappNumber || whatsappLink?.whatsappNumber || undefined;

    if (whatsappNumber && !user.whatsappNumber) {
      await db.updateUserRecord({ ...user, whatsappNumber, updatedAt: nowIso() }).catch(() => undefined);
    }

    return {
      linked: true as const,
      paymentUserId: user.id,
      escrowUserId: user.id,
      email: user.email,
      fullName: user.fullName,
      whatsappNumber,
      canTransact: true,
    };
  }

  return { linked: false as const };
}
