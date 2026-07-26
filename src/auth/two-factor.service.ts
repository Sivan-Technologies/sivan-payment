import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../database/json-database.js';
import type { UserRecord, UserTwoFactorRecord, UserTwoFactorRecoveryQuestionRecord } from '../database/types.js';
import { createAuditLog } from '../audit/audit.service.js';
import { badRequest, forbidden, notFound } from '../shared/errors.js';
import { nowIso } from '../shared/id.js';
import { getUser } from '../users/users.service.js';
import { signUserJwt } from './jwt.js';

const issuer = 'Sivan';
const stepSeconds = 30;
const digits = 6;
const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const twoFactorVerifySchema = z.object({ code: z.string().min(6).max(32) });
export const twoFactorLoginVerifySchema = z.object({ twoFactorToken: z.string().min(20), code: z.string().min(6).max(32) });

export const recoveryQuestionCatalog = [
  { id: 'private_phrase', question: 'What is a private phrase only you would remember?' },
  { id: 'childhood_friend_nickname', question: 'What was the nickname of your childhood best friend?' },
  { id: 'first_personal_project', question: 'What was the name of your first personal project?' },
  { id: 'first_paid_event', question: 'What was the first concert or event you paid for yourself?' },
  { id: 'memorable_childhood_street', question: 'What is a memorable street name from your childhood?' },
  { id: 'first_app_or_website_account', question: 'What was the first app or website you created an account on?' },
  { id: 'first_non_school_email_username', question: 'What was your first non-school email username?' },
  { id: 'memorable_family_phrase', question: 'What is a memorable family phrase?' },
  { id: 'mentor_name', question: 'What was the name of a teacher or mentor who changed your life?' },
  { id: 'first_job_word', question: 'What is a word you associate with your first job?' }
] as const;

const recoveryAnswerSchema = z.object({ questionId: z.string().min(3).max(80), answer: z.string().min(3).max(200) });
export const setRecoveryQuestionsSchema = z.object({ answers: z.array(recoveryAnswerSchema).length(2) });
export const twoFactorRecoveryQuestionsChallengeSchema = z.object({ twoFactorToken: z.string().min(20) });
export const verifyRecoveryQuestionsSchema = z.object({ twoFactorToken: z.string().min(20), answers: z.array(recoveryAnswerSchema).length(2), supportTicketId: z.string().min(2).max(120).optional() });

function base32Encode(buffer: Buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let output = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    output += base32Alphabet[parseInt(chunk, 2)];
  }
  return output;
}

function base32Decode(value: string) {
  const clean = value.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = '';
  for (const char of clean) {
    const index = base32Alphabet.indexOf(char);
    if (index < 0) throw badRequest('Invalid authenticator secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret: string, counter = Math.floor(Date.now() / 1000 / stepSeconds)) {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

function verifyTotp(secret: string, code: string) {
  const clean = code.replace(/\s|-/g, '');
  const current = Math.floor(Date.now() / 1000 / stepSeconds);
  return [-1, 0, 1].some((offset) => secureEqual(totp(secret, current + offset), clean));
}

function secureEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cryptoKey() {
  return crypto.createHash('sha256').update(env.USER_JWT_SECRET).digest();
}

function encryptSecret(secret: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cryptoKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decryptSecret(encrypted: string) {
  const [ivRaw, tagRaw, ciphertextRaw] = encrypted.split('.');
  if (!ivRaw || !tagRaw || !ciphertextRaw) throw new Error('Invalid encrypted secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', cryptoKey(), Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, 'base64url')), decipher.final()]).toString('utf8');
}

function recoveryCode() {
  return `${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function hashRecoveryCode(userId: string, code: string) {
  return crypto.createHash('sha256').update(`${userId}:${code.replace(/\s|-/g, '').toUpperCase()}:${env.USER_JWT_SECRET}`).digest('hex');
}

function recoveryQuestionId() { return `rq_${crypto.randomUUID()}`; }
function recoveryVerificationId() { return `rqv_${crypto.randomUUID()}`; }
function normalizeRecoveryAnswer(value: string) { return value.trim().toLowerCase().replace(/\s+/g, ' '); }
function recoveryQuestionById(questionId: string) { return recoveryQuestionCatalog.find((item) => item.id === questionId); }
function hashRecoveryAnswer(userId: string, questionId: string, answer: string, salt = crypto.randomBytes(16).toString('base64url')) {
  const normalized = normalizeRecoveryAnswer(answer);
  const peppered = `${userId}:${questionId}:${normalized}:${env.USER_JWT_SECRET}`;
  const answerHash = crypto.scryptSync(peppered, salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64url');
  return { answerHash, answerSalt: salt, algorithm: 'scrypt-sha256-v1' as const };
}
function verifyRecoveryAnswer(userId: string, record: UserTwoFactorRecoveryQuestionRecord, answer: string) {
  const hashed = hashRecoveryAnswer(userId, record.questionId, answer, record.answerSalt);
  return secureEqual(hashed.answerHash, record.answerHash);
}
function safeRecoveryQuestions(records: UserTwoFactorRecoveryQuestionRecord[]) {
  return records.map((item) => ({ id: item.id, questionId: item.questionId, questionText: item.questionText, createdAt: item.createdAt, updatedAt: item.updatedAt }));
}

function otpauthUrl(user: UserRecord, secret: string) {
  const label = encodeURIComponent(`${issuer}:${user.email || user.id}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(digits), period: String(stepSeconds) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function signTwoFactorToken(input: { userId: string; email?: string }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: input.userId, email: input.email, typ: 'user_2fa', iat: now, exp: now + 10 * 60, iss: 'sivan-payments-api', aud: 'sivan-payments-user' };
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', env.USER_JWT_SECRET).update(`${encodedHeader}.${encodedPayload}`).digest('base64url');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function verifyTwoFactorToken(token: string) {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw badRequest('Invalid two-factor session');
  const expected = crypto.createHmac('sha256', env.USER_JWT_SECRET).update(`${h}.${p}`).digest('base64url');
  if (!secureEqual(expected, s)) throw badRequest('Invalid two-factor session');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as { sub: string; email?: string; typ: string; exp: number };
  if (payload.typ !== 'user_2fa' || payload.exp <= Math.floor(Date.now() / 1000)) throw badRequest('Expired two-factor session');
  return payload;
}

export async function getTwoFactorStatus(userId: string) {
  await getUser(userId).catch(() => { throw notFound('User'); });
  const record = await db.getUserTwoFactorRecord(userId);
  const questions = await db.listUserTwoFactorRecoveryQuestionRecords(userId);
  return {
    userId,
    enabled: Boolean(record?.enabled),
    enabledAt: record?.enabledAt,
    lastVerifiedAt: record?.lastVerifiedAt,
    recoveryCodesRemaining: record?.recoveryCodeHashes?.length ?? 0,
    recoveryQuestionsConfigured: questions.length >= 2,
    recoveryQuestionsCount: questions.length
  };
}

export async function startTwoFactorSetup(userId: string) {
  const user = await getUser(userId);
  const secret = base32Encode(crypto.randomBytes(20));
  const now = nowIso();
  const current = await db.getUserTwoFactorRecord(userId);
  const record: UserTwoFactorRecord = {
    userId,
    enabled: false,
    secretEncrypted: encryptSecret(secret),
    recoveryCodeHashes: current?.recoveryCodeHashes ?? [],
    createdAt: current?.createdAt ?? now,
    updatedAt: now
  };
  await db.upsertUserTwoFactorRecord(record);
  await createAuditLog({ actorType: 'user', actorId: userId, action: 'auth.2fa_setup_started', resourceType: 'payments_user_two_factor', resourceId: userId, severity: 'warning' });
  return { manualEntryKey: secret, otpauthUrl: otpauthUrl(user, secret), issuer, accountName: user.email || user.id, stepSeconds, digits };
}

export async function enableTwoFactor(userId: string, code: string) {
  const record = await db.getUserTwoFactorRecord(userId);
  if (!record?.secretEncrypted) throw badRequest('Start two-factor setup first');
  const secret = decryptSecret(record.secretEncrypted);
  if (!verifyTotp(secret, code)) throw badRequest('Invalid authenticator code');
  const recoveryCodes = Array.from({ length: 10 }, recoveryCode);
  const now = nowIso();
  const next: UserTwoFactorRecord = { ...record, enabled: true, enabledAt: record.enabledAt ?? now, lastVerifiedAt: now, recoveryCodeHashes: recoveryCodes.map((item) => hashRecoveryCode(userId, item)), updatedAt: now };
  await db.upsertUserTwoFactorRecord(next);
  await createAuditLog({ actorType: 'user', actorId: userId, action: 'auth.2fa_enabled', resourceType: 'payments_user_two_factor', resourceId: userId, severity: 'warning' });
  return { enabled: true, recoveryCodes, recoveryQuestionsRequired: true, recoveryQuestionCatalog };
}

export function getRecoveryQuestionCatalog() {
  return recoveryQuestionCatalog;
}

export async function listUserRecoveryQuestions(userId: string) {
  await getUser(userId).catch(() => { throw notFound('User'); });
  const records = await db.listUserTwoFactorRecoveryQuestionRecords(userId);
  return { configured: records.length >= 2, count: records.length, questions: safeRecoveryQuestions(records), catalog: recoveryQuestionCatalog };
}

export async function setUserRecoveryQuestions(userId: string, input: z.infer<typeof setRecoveryQuestionsSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  await getUser(userId).catch(() => { throw notFound('User'); });
  const twoFactor = await db.getUserTwoFactorRecord(userId);
  if (!twoFactor?.enabled) throw badRequest('Enable authenticator 2FA before setting recovery questions.');
  const uniqueQuestionIds = new Set(input.answers.map((item) => item.questionId));
  if (uniqueQuestionIds.size !== input.answers.length) throw badRequest('Choose two different recovery questions.');
  const now = nowIso();
  const records = input.answers.map((item) => {
    const question = recoveryQuestionById(item.questionId);
    if (!question) throw badRequest('Choose a supported recovery question.');
    const hashed = hashRecoveryAnswer(userId, item.questionId, item.answer);
    return {
      id: recoveryQuestionId(),
      userId,
      questionId: item.questionId,
      questionText: question.question,
      answerHash: hashed.answerHash,
      answerSalt: hashed.answerSalt,
      algorithm: hashed.algorithm,
      createdAt: now,
      updatedAt: now
    } satisfies UserTwoFactorRecoveryQuestionRecord;
  });
  await db.replaceUserTwoFactorRecoveryQuestionRecords(userId, records);
  await createAuditLog({ actorType: 'user', actorId: userId, action: 'auth.2fa_recovery_questions_set', resourceType: 'payments_user_two_factor_recovery_questions', resourceId: userId, severity: 'warning', ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { questionIds: records.map((item) => item.questionId), count: records.length } });
  return { configured: true, count: records.length, questions: safeRecoveryQuestions(records) };
}

export async function getTwoFactorRecoveryChallengeQuestions(input: z.infer<typeof twoFactorRecoveryQuestionsChallengeSchema>) {
  const payload = verifyTwoFactorToken(input.twoFactorToken);
  const user = await getUser(payload.sub);
  const twoFactor = await db.getUserTwoFactorRecord(user.id);
  if (!twoFactor?.enabled) throw forbidden('Two-factor authentication is not enabled for this account');
  const records = await db.listUserTwoFactorRecoveryQuestionRecords(user.id);
  if (records.length < 2) throw badRequest('Recovery questions are not configured for this account. Contact Sivan Support.');
  return { email: user.email, questions: safeRecoveryQuestions(records) };
}

export async function verifyTwoFactorRecoveryQuestions(input: z.infer<typeof verifyRecoveryQuestionsSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const payload = verifyTwoFactorToken(input.twoFactorToken);
  const user = await getUser(payload.sub);
  const twoFactor = await db.getUserTwoFactorRecord(user.id);
  if (!twoFactor?.enabled) throw forbidden('Two-factor authentication is not enabled for this account');
  const records = await db.listUserTwoFactorRecoveryQuestionRecords(user.id);
  if (records.length < 2) throw badRequest('Recovery questions are not configured for this account. Contact Sivan Support.');
  const answerByQuestion = new Map(input.answers.map((item) => [item.questionId, item.answer]));
  const passedQuestionIds = records.filter((record) => {
    const answer = answerByQuestion.get(record.questionId);
    return answer ? verifyRecoveryAnswer(user.id, record, answer) : false;
  }).map((record) => record.questionId);
  const verified = passedQuestionIds.length >= Math.min(2, records.length);
  const verificationId = verified ? recoveryVerificationId() : undefined;
  await createAuditLog({ actorType: 'user', actorId: user.id, action: verified ? 'auth.2fa_recovery_questions_verified' : 'auth.2fa_recovery_questions_failed', resourceType: 'payments_user_two_factor_recovery_questions', resourceId: user.id, severity: verified ? 'warning' : 'error', ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { verificationId, supportTicketId: input.supportTicketId, passedCount: passedQuestionIds.length, requiredCount: 2, questionIds: records.map((item) => item.questionId) } });
  if (!verified) throw badRequest('Recovery answers could not be verified. Contact Sivan Support.');
  return { verified: true, recoveryVerificationId: verificationId, message: 'Recovery questions verified. Sivan Support can now review your 2FA reset request. This does not automatically disable 2FA.' };
}

export async function disableTwoFactor(userId: string, code: string) {
  const record = await db.getUserTwoFactorRecord(userId);
  if (!record?.enabled) throw badRequest('Two-factor authentication is not enabled');
  const verified = verifyTwoFactorCodeForRecord(userId, record, code);
  if (!verified.ok) throw badRequest('Invalid authenticator or recovery code');
  const now = nowIso();
  await db.upsertUserTwoFactorRecord({ ...record, enabled: false, recoveryCodeHashes: [], enabledAt: undefined, lastVerifiedAt: now, updatedAt: now });
  await createAuditLog({ actorType: 'user', actorId: userId, action: 'auth.2fa_disabled', resourceType: 'payments_user_two_factor', resourceId: userId, severity: 'warning' });
  return { enabled: false };
}

function verifyTwoFactorCodeForRecord(userId: string, record: UserTwoFactorRecord, code: string): { ok: boolean; recoveryUsed?: boolean; nextRecoveryHashes?: string[] } {
  const clean = code.replace(/\s/g, '');
  const secret = decryptSecret(record.secretEncrypted);
  if (/^\d{6}$/.test(clean) && verifyTotp(secret, clean)) return { ok: true };
  const hash = hashRecoveryCode(userId, clean);
  if (record.recoveryCodeHashes.includes(hash)) return { ok: true, recoveryUsed: true, nextRecoveryHashes: record.recoveryCodeHashes.filter((item) => item !== hash) };
  return { ok: false };
}

export async function maybeCreateTwoFactorChallenge(user: UserRecord) {
  const record = await db.getUserTwoFactorRecord(user.id);
  if (!record?.enabled) return null;
  return { requiresTwoFactor: true, twoFactorToken: signTwoFactorToken({ userId: user.id, email: user.email }), email: user.email, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
}

export async function verifyTwoFactorLogin(input: z.infer<typeof twoFactorLoginVerifySchema>) {
  const payload = verifyTwoFactorToken(input.twoFactorToken);
  const user = await getUser(payload.sub);
  const record = await db.getUserTwoFactorRecord(user.id);
  if (!record?.enabled) throw forbidden('Two-factor authentication is not enabled for this account');
  const verified = verifyTwoFactorCodeForRecord(user.id, record, input.code);
  if (!verified.ok) throw badRequest('Invalid authenticator or recovery code');
  const now = nowIso();
  await db.upsertUserTwoFactorRecord({ ...record, recoveryCodeHashes: verified.nextRecoveryHashes ?? record.recoveryCodeHashes, lastVerifiedAt: now, updatedAt: now });
  await createAuditLog({ actorType: 'user', actorId: user.id, action: verified.recoveryUsed ? 'auth.2fa_recovery_verified' : 'auth.2fa_verified', resourceType: 'payments_user_two_factor', resourceId: user.id, severity: 'info' });
  return { token: signUserJwt({ userId: user.id, email: user.email }), expiresInMinutes: env.USER_JWT_EXPIRES_MINUTES, user };
}
