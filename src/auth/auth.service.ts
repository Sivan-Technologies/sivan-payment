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
import { getAdminPlatformSettings } from '../admin/admin-settings.service.js';
import { maybeCreateTwoFactorChallenge } from './two-factor.service.js';

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
  const platformSettings = await getAdminPlatformSettings();
  if (input.intent === 'signup' && !existingUser && !platformSettings.newUserSignups) {
    throw badRequest('New user signups are temporarily disabled');
  }
  if (input.intent === 'signup' && !existingUser && !input.fullName) {
    throw badRequest('fullName is required to create an account');
  }
  if (input.intent === 'signup' && !input.legalAcceptance?.accepted) {
    throw badRequest('You must accept the Terms, Privacy Policy, and Risk Disclosure to create an account');
  }

  // RESEND COOLDOWN. THE RATE LIMIT PROTECTS THE ENDPOINT; THIS PROTECTS THE
  // EMAIL QUOTA, AND THEY ARE NOT THE SAME THING.
  //
  // The IP+email limiter allows 5 starts per 15 minutes. That is correct as an
  // abuse control, and useless as a budget control: 5 x 4 windows x 24h is 480
  // emails a day from ONE address, and the Resend free tier is 100 a day. One
  // bored person with the login page open exhausts the whole platform's email
  // for everybody, including OTPs for real users trying to sign in.
  //
  // The 60-second cooldown the UI shows was CLIENT-SIDE ONLY - React state in
  // `resendAvailableAt`. Anything not using our frontend ignored it entirely.
  //
  // A legitimate user needs one code, plus perhaps one resend if it lands in
  // spam. Sixty seconds between sends costs them nothing and caps the worst
  // case at a rate the free tier survives.
  //
  // Deliberately NOT an error the caller can distinguish from success in a
  // useful way beyond the wait: replying "no such account" or "code already
  // sent" to an arbitrary address would leak whether an account exists.
  const lastChallenge = await db.latestAuthChallengeForEmail(input.email);
  if (lastChallenge) {
    const elapsedMs = Date.now() - Date.parse(lastChallenge.createdAt);
    const cooldownMs = env.AUTH_OTP_RESEND_COOLDOWN_SECONDS * 1000;
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < cooldownMs) {
      const waitSeconds = Math.ceil((cooldownMs - elapsedMs) / 1000);
      throw badRequest(
        `A code was just sent to that address. Check your inbox and spam folder, or ask for another in ${waitSeconds} second${waitSeconds === 1 ? '' : 's'}.`
      );
    }
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
  /**
   * ONE INDEXED LOOKUP, NOT THE WHOLE DATABASE.
   *
   * This was db.read() - 47 sequential `select *` queries, every table,
   * including the entire unbounded audit history - to check one OTP. It sits
   * on the signup path, so it was the slowest thing a brand new user ever did:
   * 4.0-4.9s measured on api-test against a 30ms health check.
   *
   * The email/consumed/expiry filters now run in SQL. The HASH comparison
   * deliberately stays here: it is a constant-time-ish equality on a short
   * candidate list, and pushing a secret-derived value into a WHERE clause
   * makes it a query parameter that lands in slow-query logs.
   */
  const challenge = (await db.activeAuthChallengesForEmail(input.email))
    .find((item) => item.codeHash === expectedHash);

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

  const twoFactor = await maybeCreateTwoFactorChallenge(freshUser);
  if (twoFactor) return twoFactor;

  return {
    token: signUserJwt({ userId: freshUser.id, email: freshUser.email }),
    expiresInMinutes: env.USER_JWT_EXPIRES_MINUTES,
    user: freshUser
  };
}
