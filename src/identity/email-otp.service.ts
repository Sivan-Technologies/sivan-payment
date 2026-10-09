import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../database/json-database.js';
import { badRequest } from '../shared/errors.js';
import { id, nowIso } from '../shared/id.js';
import { buildOtpEmail, sendEmail } from '../notifications/email.service.js';
import { createAuditLog } from '../audit/audit.service.js';
import type { UserRecord } from '../database/types.js';
import { activeLinkForTelegram, activeLinkForWhatsapp } from './identity.service.js';
import { hasWithdrawalPin } from './withdrawal-pin.service.js';

export const startChatEmailOtpSchema = z.object({
  email: z.string().email().transform((val) => val.toLowerCase().trim()),
  channel: z.enum(['telegram', 'whatsapp']),
  identifier: z.string().min(1).max(128).trim(),
});

export const verifyChatEmailOtpSchema = z.object({
  email: z.string().email().transform((val) => val.toLowerCase().trim()),
  code: z.string().min(4).max(12).trim(),
  channel: z.enum(['telegram', 'whatsapp']),
  identifier: z.string().min(1).max(128).trim(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
});

function hashCode(email: string, code: string) {
  return crypto.createHash('sha256').update(`${email}:${code}:${env.USER_JWT_SECRET}`).digest('hex');
}

function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

export function maskEmail(email: string): string {
  const parts = email.split('@');
  if (parts.length !== 2) return email;
  const [local, domain] = parts;
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local.slice(0, 2)}***${local.slice(-1)}@${domain}`;
}

export async function startChatEmailOtp(
  input: z.infer<typeof startChatEmailOtpSchema>,
  context: { ipAddress?: string; userAgent?: string } = {}
) {
  const email = input.email;
  const cleanId = input.identifier;

  // Check if an existing account is already registered with this email (e.g. from Web App)
  const existingUserWithEmail = await db.findUserByEmail(email);

  // Check if current chat user exists
  let currentChatUser: UserRecord | undefined;
  if (input.channel === 'telegram') {
    currentChatUser = await db.findUserByTelegramUserId(cleanId);
    if (!currentChatUser) {
      const link = await activeLinkForTelegram(cleanId);
      if (link) currentChatUser = await db.findUserById(link.paymentUserId);
    }
  } else {
    currentChatUser = await db.findUserByWhatsappNumber(cleanId);
    if (!currentChatUser) {
      const link = await activeLinkForWhatsapp(cleanId);
      if (link) currentChatUser = await db.findUserById(link.paymentUserId);
    }
  }

  const isExistingAccount = Boolean(
    existingUserWithEmail && (!currentChatUser || existingUserWithEmail.id !== currentChatUser.id)
  );

  // Cooldown check against abuse
  const lastChallenge = await db.latestAuthChallengeForEmail(email);
  if (lastChallenge) {
    const elapsedMs = Date.now() - Date.parse(lastChallenge.createdAt);
    const cooldownMs = (env.AUTH_OTP_RESEND_COOLDOWN_SECONDS || 60) * 1000;
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < cooldownMs) {
      const waitSeconds = Math.ceil((cooldownMs - elapsedMs) / 1000);
      throw badRequest(
        `A verification code was just sent to that address. Check your inbox, or request another in ${waitSeconds} second${waitSeconds === 1 ? '' : 's'}.`
      );
    }
  }

  const code = generateCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (env.AUTH_OTP_EXPIRES_MINUTES || 10) * 60 * 1000).toISOString();
  const challenge = {
    id: id('auth'),
    email,
    codeHash: hashCode(email, code),
    intent: isExistingAccount ? ('signin' as const) : ('signup' as const),
    expiresAt,
    createdAt: now.toISOString(),
  };

  await db.insertAuthChallengeRecord(challenge);

  const emailPayload = buildOtpEmail({
    code,
    expiresInMinutes: env.AUTH_OTP_EXPIRES_MINUTES || 10,
    intent: isExistingAccount ? 'signin' : 'signup',
  });

  const subject = isExistingAccount
    ? 'Link your Telegram to your Sivan account'
    : 'Verify your Sivan account email';

  const delivery = await sendEmail({
    to: email,
    subject,
    text: `${emailPayload.text}\n\n${
      isExistingAccount
        ? 'Enter this verification code in chat to link your Sivan account and sync your balance and wallet.'
        : 'Enter this verification code in chat to complete your email verification.'
    }`,
    html: emailPayload.html,
  });

  await createAuditLog({
    actorType: 'system',
    action: 'identity.chat_email_otp_sent',
    resourceType: 'auth_challenge',
    resourceId: challenge.id,
    metadata: {
      email,
      channel: input.channel,
      identifier: cleanId,
      isExistingAccount,
      provider: delivery.provider,
    },
  });

  return {
    message: 'Verification code sent',
    expiresAt,
    isExistingAccount,
    maskedEmail: maskEmail(email),
    deliveryProvider: delivery.provider,
    devCode: env.AUTH_DEV_SHOW_OTP ? code : undefined,
  };
}

export async function verifyChatEmailOtp(
  input: z.infer<typeof verifyChatEmailOtpSchema>,
  context: { ipAddress?: string; userAgent?: string } = {}
) {
  const { email, code, channel, identifier, firstName, lastName } = input;
  const now = nowIso();
  const expectedHash = hashCode(email, code);

  const challenge = (await db.activeAuthChallengesForEmail(email)).find((item) => item.codeHash === expectedHash);
  if (!challenge) {
    throw badRequest('Invalid or expired verification code', { code: 'INVALID_CODE' });
  }

  // Look up existing user registered with this email
  const existingWebUser = await db.findUserByEmail(email);

  // Look up current chat user
  let chatUser: UserRecord | undefined;
  if (channel === 'telegram') {
    chatUser = await db.findUserByTelegramUserId(identifier);
    if (!chatUser) {
      const link = await activeLinkForTelegram(identifier);
      if (link) chatUser = await db.findUserById(link.paymentUserId);
    }
  } else {
    chatUser = await db.findUserByWhatsappNumber(identifier);
    if (!chatUser) {
      const link = await activeLinkForWhatsapp(identifier);
      if (link) chatUser = await db.findUserById(link.paymentUserId);
    }
  }

  let canonicalUser: UserRecord;
  const isExistingAccount = Boolean(existingWebUser);

  if (existingWebUser) {
    // ── RACE CONDITION RESOLUTION / ACCOUNT LINK FLOW ─────────────────────────
    canonicalUser = existingWebUser;

    // Attach channel credentials to canonical user
    const updatedCanonical: UserRecord = {
      ...canonicalUser,
      telegramUserId: channel === 'telegram' ? identifier : canonicalUser.telegramUserId,
      whatsappNumber: channel === 'whatsapp' ? identifier : (canonicalUser.whatsappNumber || chatUser?.whatsappNumber),
      emailVerifiedAt: canonicalUser.emailVerifiedAt || now,
      fullName:
        canonicalUser.fullName && canonicalUser.fullName !== 'Sivan User'
          ? canonicalUser.fullName
          : (chatUser?.fullName || (firstName ? `${firstName} ${lastName || ''}`.trim() : canonicalUser.fullName)),
      updatedAt: now,
    };
    await db.updateUserRecord(updatedCanonical);

    // If chat had a separate user record created before linking, merge identity link and PIN
    if (chatUser && chatUser.id !== canonicalUser.id) {
      // Re-link customer identity records to canonical user
      const links = await db.listCustomerIdentityLinks();
      for (const l of links) {
        if (
          l.paymentUserId === chatUser.id ||
          (channel === 'telegram' && l.telegramUserId === identifier) ||
          (channel === 'whatsapp' && l.whatsappNumber === identifier)
        ) {
          await db.upsertCustomerIdentityLinkRecord({
            ...l,
            paymentUserId: canonicalUser.id,
            email: canonicalUser.email,
            status: 'linked',
            linkedAt: l.linkedAt || now,
            updatedAt: now,
          });
        }
      }

      // Re-point PIN if chat had one and canonical user does not
      const chatHasPin = await hasWithdrawalPin(chatUser.id);
      const canonicalHasPin = await hasWithdrawalPin(canonicalUser.id);
      if (chatHasPin && !canonicalHasPin) {
        const pins = await db.listWithdrawalPins();
        const chatPin = pins.find((p) => p.userId === chatUser.id);
        if (chatPin) {
          await db.upsertWithdrawalPinRecord({
            ...chatPin,
            userId: canonicalUser.id,
            updatedAt: now,
          });
        }
      }

      // Free the placeholder email on chatUser to prevent any unique constraint conflict
      await db.updateUserRecord({
        ...chatUser,
        email: `merged_${chatUser.id}_${Date.now()}@sivantech.online`,
        telegramUserId: channel === 'telegram' ? undefined : chatUser.telegramUserId,
        whatsappNumber: channel === 'whatsapp' ? undefined : chatUser.whatsappNumber,
        updatedAt: now,
      });
    }

    // Ensure customer identity link exists for canonical user
    const existingLinks = await db.listCustomerIdentityLinks();
    const existingLink = existingLinks.find(
      (l) => l.paymentUserId === canonicalUser.id && l.channel === channel
    );
    await db.upsertCustomerIdentityLinkRecord({
      id: existingLink?.id || id('identity'),
      paymentUserId: canonicalUser.id,
      email: canonicalUser.email,
      channel,
      telegramUserId: channel === 'telegram' ? identifier : undefined,
      whatsappNumber: channel === 'whatsapp' ? identifier : undefined,
      status: 'linked',
      linkedAt: existingLink?.linkedAt || now,
      createdAt: existingLink?.createdAt || now,
      updatedAt: now,
    });
  } else {
    // ── NEW EMAIL ASSOCIATION FLOW ───────────────────────────────────────────
    if (chatUser) {
      canonicalUser = {
        ...chatUser,
        email,
        emailVerifiedAt: now,
        telegramUserId: channel === 'telegram' ? identifier : chatUser.telegramUserId,
        whatsappNumber: channel === 'whatsapp' ? identifier : chatUser.whatsappNumber,
        fullName:
          chatUser.fullName && chatUser.fullName !== 'Sivan User'
            ? chatUser.fullName
            : (firstName ? `${firstName} ${lastName || ''}`.trim() : chatUser.fullName),
        updatedAt: now,
      };
      await db.updateUserRecord(canonicalUser);
    } else {
      canonicalUser = await db.insertUserRecord({
        id: id('usr'),
        email,
        emailVerifiedAt: now,
        fullName: firstName ? `${firstName} ${lastName || ''}`.trim() : 'Sivan User',
        telegramUserId: channel === 'telegram' ? identifier : undefined,
        whatsappNumber: channel === 'whatsapp' ? identifier : undefined,
        createdAt: now,
        updatedAt: now,
      });
    }

    const links = await db.listCustomerIdentityLinks();
    const existingLink = links.find(
      (l) => l.paymentUserId === canonicalUser.id && l.channel === channel
    );
    await db.upsertCustomerIdentityLinkRecord({
      id: existingLink?.id || id('identity'),
      paymentUserId: canonicalUser.id,
      email: canonicalUser.email,
      channel,
      telegramUserId: channel === 'telegram' ? identifier : undefined,
      whatsappNumber: channel === 'whatsapp' ? identifier : undefined,
      status: 'linked',
      linkedAt: existingLink?.linkedAt || now,
      createdAt: existingLink?.createdAt || now,
      updatedAt: now,
    });
  }

  // Consume the challenge
  await db.consumeAuthChallengeAndMarkUserEmail(challenge.id, canonicalUser.id, now);

  await createAuditLog({
    actorType: 'user',
    actorId: canonicalUser.id,
    action: isExistingAccount ? 'identity.chat_account_linked' : 'identity.chat_email_verified',
    resourceType: 'customer_identity',
    resourceId: canonicalUser.id,
    metadata: {
      email,
      channel,
      identifier,
      isExistingAccount,
      paymentUserId: canonicalUser.id,
    },
  });

  return {
    verified: true,
    linked: true,
    isExistingAccount,
    paymentUserId: canonicalUser.id,
    email: canonicalUser.email,
    fullName: canonicalUser.fullName,
    message: isExistingAccount
      ? 'Account linked to existing profile successfully.'
      : 'Email verified and connected successfully.',
  };
}
