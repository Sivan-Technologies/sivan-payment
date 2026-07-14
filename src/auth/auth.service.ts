import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../database/json-database.js';
import { badRequest, notFound } from '../shared/errors.js';
import { id, nowIso } from '../shared/id.js';
import { createUser, getUserByEmail } from '../users/users.service.js';
import { signUserJwt } from './jwt.js';
import { createAuditLog } from '../audit/audit.service.js';
import { buildOtpEmail, sendEmail } from '../notifications/email.service.js';
import { buildChallengeLegalAcceptance, legalAcceptancePayloadSchema, recordSignupLegalAcceptance } from '../legal/legal-acceptance.service.js';

export const startEmailAuthSchema = z.object({
  email: z.string().email().transform((value) => value.toLowerCase()),
  fullName: z.string().min(2).optional(),
  intent: z.enum(['signup', 'signin']).default('signin'),
  legalAcceptance: legalAcceptancePayloadSchema.optional()
});

export const verifyEmailAuthSchema = z.object({
  email: z.string().email().transform((value) => value.toLowerCase()),
  code: z.string().min(4).max(12)
});

function hashCode(email: string, code: string) {
  return crypto.createHash('sha256').update(`${email}:${code}:${env.USER_JWT_SECRET}`).digest('hex');
}

function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

export async function startEmailAuth(input: z.infer<typeof startEmailAuthSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const existingUser = await getUserByEmail(input.email);
  if (input.intent === 'signin' && !existingUser) {
    throw notFound('Account');
  }
  if (input.intent === 'signup' && !existingUser && !input.fullName) {
    throw badRequest('fullName is required to create an account');
  }
  if (input.intent === 'signup' && !input.legalAcceptance?.accepted) {
    throw badRequest('You must accept the Terms, Privacy Policy, and Risk Disclosure to create an account');
  }

  const code = generateCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.AUTH_OTP_EXPIRES_MINUTES * 60 * 1000).toISOString();
  const challenge = {
    id: id('auth'),
    email: input.email,
    codeHash: hashCode(input.email, code),
    intent: input.intent,
    fullName: input.fullName,
    ...buildChallengeLegalAcceptance({
      legalAcceptance: input.intent === 'signup' ? input.legalAcceptance : undefined,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      acceptedAt: now.toISOString()
    }),
    expiresAt,
    createdAt: now.toISOString()
  };

  await db.insertAuthChallengeRecord(challenge);

  const email = buildOtpEmail({
    code,
    expiresInMinutes: env.AUTH_OTP_EXPIRES_MINUTES,
    intent: input.intent
  });
  const delivery = await sendEmail({
    to: input.email,
    subject: email.subject,
    text: email.text,
    html: email.html
  });

  await createAuditLog({
    actorType: 'system',
    action: 'auth.otp_sent',
    resourceType: 'auth_challenge',
    resourceId: challenge.id,
    metadata: { email: input.email, intent: input.intent, provider: delivery.provider, deliveryId: delivery.id }
  });

  return {
    message: 'Verification code sent',
    expiresAt,
    deliveryProvider: delivery.provider,
    devCode: env.AUTH_DEV_SHOW_OTP ? code : undefined
  };
}

export async function verifyEmailAuth(input: z.infer<typeof verifyEmailAuthSchema>) {
  const now = nowIso();
  const expectedHash = hashCode(input.email, input.code);
  const data = await db.read();
  const challenge = (data.authChallenges ?? [])
    .filter((item) => item.email === input.email && !item.consumedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .find((item) => item.codeHash === expectedHash && new Date(item.expiresAt).getTime() > Date.now());

  if (!challenge) throw badRequest('Invalid or expired verification code');

  let user = await getUserByEmail(input.email);
  if (!user) {
    if (challenge.intent !== 'signup' || !challenge.fullName) throw notFound('Account');
    user = await createUser({ email: input.email, fullName: challenge.fullName, primaryChannel: 'email' });
  }

  await db.consumeAuthChallengeAndMarkUserEmail(challenge.id, user.id, now);

  const freshUser = await getUserByEmail(input.email);
  if (!freshUser) throw notFound('Account');

  if (challenge.intent === 'signup' && challenge.legalTermsVersion && challenge.legalPrivacyVersion && challenge.legalRiskDisclosureVersion) {
    await recordSignupLegalAcceptance({
      userId: freshUser.id,
      email: freshUser.email,
      termsVersion: challenge.legalTermsVersion,
      privacyVersion: challenge.legalPrivacyVersion,
      riskDisclosureVersion: challenge.legalRiskDisclosureVersion,
      acceptedAt: challenge.legalAcceptedAt,
      ipAddress: challenge.legalAcceptanceIpAddress,
      userAgent: challenge.legalAcceptanceUserAgent
    });
  }

  await createAuditLog({
    actorType: 'user',
    actorId: freshUser.id,
    action: challenge.intent === 'signup' ? 'auth.signup_verified' : 'auth.signin_verified',
    resourceType: 'user',
    resourceId: freshUser.id,
    metadata: { email: input.email }
  });

  return {
    token: signUserJwt({ userId: freshUser.id, email: freshUser.email }),
    expiresInMinutes: env.USER_JWT_EXPIRES_MINUTES,
    user: freshUser
  };
}
