import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../database/json-database.js';
import { badRequest, notFound } from '../shared/errors.js';
import { id, nowIso } from '../shared/id.js';
import { createUser, getUserByEmail } from '../users/users.service.js';
import { signUserJwt } from './jwt.js';

export const startEmailAuthSchema = z.object({
  email: z.string().email().transform((value) => value.toLowerCase()),
  fullName: z.string().min(2).optional(),
  intent: z.enum(['signup', 'signin']).default('signin')
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

export async function startEmailAuth(input: z.infer<typeof startEmailAuthSchema>) {
  const existingUser = await getUserByEmail(input.email);
  if (input.intent === 'signin' && !existingUser) {
    throw notFound('Account');
  }
  if (input.intent === 'signup' && !existingUser && !input.fullName) {
    throw badRequest('fullName is required to create an account');
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
    expiresAt,
    createdAt: now.toISOString()
  };

  await db.mutate((data) => {
    data.authChallenges = data.authChallenges ?? [];
    data.authChallenges.push(challenge);
    return challenge;
  });

  // Email provider integration goes here. For now, test/staging returns the OTP if enabled.
  return {
    message: 'Verification code sent',
    expiresAt,
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

  await db.mutate((mutable) => {
    const record = (mutable.authChallenges ?? []).find((item) => item.id === challenge.id);
    if (record) record.consumedAt = now;
    const userRecord = mutable.users.find((item) => item.id === user.id);
    if (userRecord && !userRecord.emailVerifiedAt) {
      userRecord.emailVerifiedAt = now;
      userRecord.updatedAt = now;
    }
    return record;
  });

  const freshUser = await getUserByEmail(input.email);
  if (!freshUser) throw notFound('Account');
  return {
    token: signUserJwt({ userId: freshUser.id, email: freshUser.email }),
    expiresInMinutes: env.USER_JWT_EXPIRES_MINUTES,
    user: freshUser
  };
}
