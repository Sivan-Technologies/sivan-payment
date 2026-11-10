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
import { hasWithdrawalPin, verifyPinForUserId } from './withdrawal-pin.service.js';

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
    attachments: emailPayload.attachments,
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

// ─────────────────────────────────────────────────────────────────────────────
// Email Change OTP — PIN-authenticated email address update
// ─────────────────────────────────────────────────────────────────────────────

export const startEmailChangeOtpSchema = z.object({
  currentUserId: z.string().min(1),
  newEmail: z.string().email().transform((val) => val.toLowerCase().trim()),
  pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4-6 numeric digits'),
  channel: z.enum(['whatsapp', 'telegram']),
  identifier: z.string().min(1).max(128).trim(),
});

export const verifyEmailChangeOtpSchema = z.object({
  currentUserId: z.string().min(1),
  newEmail: z.string().email().transform((val) => val.toLowerCase().trim()),
  code: z.string().min(4).max(12).trim(),
  channel: z.enum(['whatsapp', 'telegram']),
  identifier: z.string().min(1).max(128).trim(),
});

/**
 * Start an email change OTP flow for an authenticated chat user.
 *
 * Requires the user's current withdrawal PIN as a second factor so that an
 * attacker who takes over a chat channel cannot silently reroute verification
 * emails to a new address.
 */
export async function startEmailChangeOtp(
  input: z.infer<typeof startEmailChangeOtpSchema>
) {
  const { currentUserId, newEmail, pin, channel, identifier } = input;

  // Validate PIN format (schema already enforces this, but kept explicit)
  if (!/^\d{4,6}$/.test(pin)) {
    throw badRequest('PIN must be 4 to 6 numeric digits.', { code: 'INVALID_PIN_FORMAT' });
  }

  // Look up user by userId
  const user = await db.findUserById(currentUserId);
  if (!user) {
    throw badRequest('User not found.', { code: 'USER_NOT_FOUND' });
  }

  // Verify the user's withdrawal PIN
  await verifyPinForUserId(currentUserId, pin);

  // Check the new email is not already registered to a DIFFERENT user
  const existingUserWithEmail = await db.findUserByEmail(newEmail);
  if (existingUserWithEmail && existingUserWithEmail.id !== currentUserId) {
    throw badRequest('That email address is already registered to another account.', {
      code: 'EMAIL_TAKEN',
    });
  }

  // Enforce 60-second cooldown
  const lastChallenge = await db.latestAuthChallengeForEmail(newEmail);
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

  // Generate 6-digit code and store auth challenge
  const code = generateCode();
  const now = new Date();
  const expiresInMinutes = env.AUTH_OTP_EXPIRES_MINUTES || 10;
  const expiresAt = new Date(now.getTime() + expiresInMinutes * 60 * 1000).toISOString();
  const challenge = {
    id: id('auth'),
    email: newEmail,
    codeHash: hashCode(newEmail, code),
    intent: 'email_change' as const,
    expiresAt,
    createdAt: now.toISOString(),
  };

  await db.insertAuthChallengeRecord(challenge);

  // Send verification email to the new address
  await sendEmail({
    to: newEmail,
    subject: 'Confirm your new Sivan email address',
    text: `Your Sivan email change verification code is: ${code}\n\nThis code expires in ${expiresInMinutes} minutes.\n\nIf you did not request this, please contact support immediately.`,
    html: `<p>Your Sivan email change verification code is: <strong>${code}</strong></p><p>This code expires in ${expiresInMinutes} minutes.</p><p>If you did not request this, please contact support immediately.</p>`,
  });

  await createAuditLog({
    actorType: 'user',
    actorId: currentUserId,
    action: 'identity.email_change_otp_sent',
    resourceType: 'auth_challenge',
    resourceId: challenge.id,
    metadata: {
      newEmail,
      channel,
      identifier,
    },
  });

  return {
    sent: true,
    maskedEmail: maskEmail(newEmail),
    expiresInMinutes,
  };
}

/**
 * Verify the email change OTP code and update the user's email address.
 */
export async function verifyEmailChangeOtp(
  input: z.infer<typeof verifyEmailChangeOtpSchema>
) {
  const { currentUserId, newEmail, code, channel, identifier } = input;
  const now = nowIso();

  // Look up the pending auth challenge for newEmail with intent 'email_change'
  const challenge = await db.latestAuthChallengeForEmail(newEmail);
  if (!challenge || challenge.intent !== 'email_change') {
    throw badRequest('No pending email change request found for that address.', {
      code: 'NO_PENDING_CHALLENGE',
    });
  }

  // Verify not expired
  if (Date.parse(challenge.expiresAt) < Date.now()) {
    throw badRequest('Verification code has expired. Please request a new one.', {
      code: 'CODE_EXPIRED',
    });
  }

  // Verify code hash matches
  const expectedHash = hashCode(newEmail, code);
  if (challenge.codeHash !== expectedHash) {
    throw badRequest('Invalid verification code.', { code: 'INVALID_CODE' });
  }

  // Look up the current user record
  const user = await db.findUserById(currentUserId);
  if (!user) {
    throw badRequest('User not found.', { code: 'USER_NOT_FOUND' });
  }

  const oldEmail = user.email;

  // Update user record: set email = newEmail, emailVerifiedAt = now
  await db.updateUserRecord({
    ...user,
    email: newEmail,
    emailVerifiedAt: now,
    updatedAt: now,
  });

  // Consume the challenge
  await db.consumeAuthChallengeAndMarkUserEmail(challenge.id, currentUserId, now);

  await createAuditLog({
    actorType: 'user',
    actorId: currentUserId,
    action: 'identity.email_changed',
    resourceType: 'user',
    resourceId: currentUserId,
    metadata: {
      oldEmail,
      newEmail,
      channel,
      identifier,
    },
  });

  return {
    changed: true,
    email: newEmail,
  };
}
