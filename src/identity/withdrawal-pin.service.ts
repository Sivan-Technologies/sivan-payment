import crypto from 'node:crypto';
import { z } from 'zod';
import { createAuditLog } from '../audit/audit.service.js';
import { env } from '../config/env.js';
import { db } from '../database/json-database.js';
import type { IdentityChannel, WithdrawalPinRecord, WithdrawalStepUpTokenRecord } from '../database/types.js';
import { badRequest, forbidden } from '../shared/errors.js';
import { nowIso } from '../shared/id.js';

/**
 * The withdrawal PIN: the second factor for money movement initiated from a
 * chat channel.
 *
 * On the web a user is behind email + password + optional TOTP. On WhatsApp or
 * Telegram they are behind possession of a phone number and nothing else, and
 * the identity link never expires - so without this, whoever holds the SIM can
 * move money forever and is never challenged again.
 *
 * ONE PIN PER PAYMENT USER. Every function here keys on `userId`, never on
 * (userId, channel). A person has one PIN and it works identically from
 * WhatsApp, Telegram, and any channel added later.
 */

/** Lockout thresholds. Deliberately strict: a 6-digit PIN has a million
 *  combinations, so an attacker needs volume and this denies them volume. */
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 30;

/** Step-up tokens are minted for one action and die quickly. Two minutes is
 *  long enough to finish a confirmation the user is already looking at, and
 *  short enough that a token captured from a bot log is almost always dead. */
const STEP_UP_TOKEN_TTL_SECONDS = 120;

/** A PIN change starts a hold on chat withdrawals, because changing the PIN is
 *  the first thing an attacker does after taking an account. The legitimate
 *  user loses chat withdrawal for a day; the attacker loses the account. */
const PIN_CHANGE_HOLD_HOURS = 24;

export const setWithdrawalPinSchema = z.object({
  pin: z.string().min(6).max(12),
  currentPin: z.string().min(6).max(12).optional(),
});

export const verifyWithdrawalPinSchema = z.object({
  channel: z.enum(['whatsapp', 'telegram']),
  identity: z.string().min(1).max(64),
  /**
   * 6-12, matching setWithdrawalPinSchema above.
   *
   * This used to accept a minimum of 4. Nothing could ever satisfy it: a PIN
   * can only be created through setWithdrawalPinSchema, which demands 6, so a
   * 4 or 5 digit submission was accepted by the schema and then failed the
   * hash comparison - burning one of the user's limited attempts and moving
   * them toward a lockout for input the API had told them was well-formed.
   */
  pin: z.string().min(6).max(12),

  amount: z.string().min(1).max(40),
  currency: z.string().min(2).max(10),
  destinationRef: z.string().min(1).max(200),
});

/**
 * scrypt, matching `scrypt-sha256-v1` already used for 2FA recovery answers.
 *
 * Deliberately the same scheme rather than a new one: a second hashing scheme
 * is a second thing to get wrong, and the spec is explicit that no second
 * scheme should be introduced. Peppered with USER_JWT_SECRET so that database
 * contents alone are not enough to mount an offline attack - and a 6-digit PIN
 * is small enough that an unpeppered hash would fall in seconds.
 */
function hashPin(userId: string, pin: string, salt = crypto.randomBytes(16).toString('base64url')) {
  const peppered = `${userId}:withdrawal-pin:${pin.trim()}:${env.USER_JWT_SECRET}`;
  const pinHash = crypto.scryptSync(peppered, salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64url');
  return { pinHash, pinSalt: salt, algorithm: 'scrypt-sha256-v1' as const };
}

function secureEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Rejects PINs that an attacker guesses first.
 *
 * 000000, 123456 and 111111 are a meaningful share of real-world choices, so
 * excluding them removes far more risk than their share of the keyspace
 * suggests. The check costs nothing and happens before anything is stored.
 */
export function assertPinIsAcceptable(pin: string) {
  const value = pin.trim();
  if (!/^\d{6,12}$/.test(value)) {
    throw badRequest('Your PIN must be 6 to 12 digits, numbers only.');
  }
  if (/^(\d)\1+$/.test(value)) {
    throw badRequest('That PIN is too easy to guess. Please avoid repeating the same digit.');
  }
  const ascending = value.split('').every((digit, index, all) => index === 0 || Number(digit) === Number(all[index - 1]) + 1);
  const descending = value.split('').every((digit, index, all) => index === 0 || Number(digit) === Number(all[index - 1]) - 1);
  if (ascending || descending) {
    throw badRequest('That PIN is too easy to guess. Please avoid running sequences like 123456.');
  }
}

/**
 * The amount is canonicalised before it is bound into a token, so that "5000",
 * "5000.00" and "5,000" cannot produce three different bindings for the same
 * payout - which would either break legitimate confirmations or, worse, let a
 * token minted for one amount be presented for another.
 */
function canonicalAmount(amount: string) {
  const cleaned = amount.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) throw badRequest('That amount is not a number we can read.');
  const [whole, fraction = ''] = cleaned.split('.');
  const trimmedFraction = fraction.replace(/0+$/, '');
  const trimmedWhole = whole.replace(/^0+(?=\d)/, '');
  return trimmedFraction ? `${trimmedWhole}.${trimmedFraction}` : trimmedWhole;
}

/**
 * What a step-up token authorises, reduced to a single comparable value.
 *
 * The withdrawal endpoint recomputes this from the request it actually
 * received and compares it to the value stored when the PIN was verified. A
 * token minted for a small payout to a known account therefore cannot be
 * replayed against a large payout, or against a different destination.
 */
function bindingHash(input: { userId: string; amount: string; currency: string; destinationRef: string }) {
  const canonical = [
    input.userId,
    input.currency.trim().toUpperCase(),
    canonicalAmount(input.amount),
    input.destinationRef.trim(),
  ].join('|');
  return crypto.createHash('sha256').update(`${canonical}:${env.USER_JWT_SECRET}`).digest('hex');
}

function tokenHash(token: string) {
  return crypto.createHash('sha256').update(`${token}:${env.USER_JWT_SECRET}`).digest('hex');
}

async function pinForUser(userId: string): Promise<WithdrawalPinRecord | undefined> {
  const pins = await db.listWithdrawalPins();
  return pins.find((item) => item.userId === userId);
}

export async function hasWithdrawalPin(userId: string) {
  return Boolean(await pinForUser(userId));
}

/**
 * Set or change the PIN. WEB ONLY - the route that calls this requires a user
 * session, and no chat-facing route may reach it.
 *
 * If the PIN could be set from a chat channel, an attacker holding that channel
 * would simply set it themselves and the PIN would protect nothing. A factor is
 * only a second factor if compromising the first does not yield it.
 */
export async function setWithdrawalPin(
  userId: string,
  input: { pin: string; currentPin?: string },
  context: { ipAddress?: string; userAgent?: string } = {}
) {
  assertPinIsAcceptable(input.pin);
  const existing = await pinForUser(userId);

  // Changing an existing PIN requires the old one. Without this, anyone who
  // reaches an authenticated session - a borrowed laptop, a stolen cookie -
  // could silently replace the withdrawal factor without knowing it.
  if (existing) {
    if (!input.currentPin) throw badRequest('Enter your current PIN to change it.');
    const candidate = hashPin(userId, input.currentPin, existing.pinSalt);
    if (!secureEqual(candidate.pinHash, existing.pinHash)) {
      throw badRequest('That is not your current PIN.');
    }
  }

  const now = nowIso();
  const hashed = hashPin(userId, input.pin);
  const record: WithdrawalPinRecord = {
    userId,
    pinHash: hashed.pinHash,
    pinSalt: hashed.pinSalt,
    algorithm: hashed.algorithm,
    setAt: existing?.setAt ?? now,
    updatedAt: now,
    // A change holds chat withdrawals for a day. A first-time set does not:
    // there is nothing to protect against yet, and holding it would punish
    // every honest new user for the sake of a threat that requires an existing
    // account to have been taken over.
    withdrawalsHeldUntil: existing
      ? new Date(Date.now() + PIN_CHANGE_HOLD_HOURS * 60 * 60 * 1000).toISOString()
      : undefined,
    failedAttempts: 0,
    lockedUntil: undefined,
  };
  await db.upsertWithdrawalPinRecord(record);

  await createAuditLog({
    actorType: 'user',
    actorId: userId,
    action: existing ? 'withdrawal_pin.changed' : 'withdrawal_pin.set',
    resourceType: 'withdrawal_pin',
    resourceId: userId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    // Note what happened, never what was entered.
    metadata: { heldUntil: record.withdrawalsHeldUntil ?? null },
  });

  return {
    set: true,
    changed: Boolean(existing),
    withdrawalsHeldUntil: record.withdrawalsHeldUntil ?? null,
  };
}

/**
 * The four refusals a caller must be able to tell apart.
 *
 * They travel in `details.code`, because badRequest/forbidden take no code
 * argument and the frontend's api() already reads `error.details.code`. The
 * UI's job differs for each - open the set-up form, re-prompt, show a clear
 * time, or explain a hold - and a single generic 400 collapses all four into
 * "something went wrong", leaving the user unable to tell "you typed it wrong"
 * from "you must wait a day".
 */
export type WithdrawalPinFailureCode = 'PIN_NOT_SET' | 'PIN_INVALID' | 'PIN_LOCKED' | 'PIN_HELD';

/**
 * Verify a PIN for a user we have ALREADY authenticated - the web path.
 *
 * verifyWithdrawalPin below resolves the user from (channel, identity),
 * because a bot has a phone number and no session. A web caller is the mirror
 * image: it has a session JWT and no channel identity. Reshaping the chat
 * function to accept a userId would strip the generic-failure behaviour that
 * stops it being an oracle for which phone numbers hold accounts, so this is
 * a separate entry point that shares the lockout, the hold and the hashing.
 *
 * No step-up token is minted here, and none is needed. On the web, verifying
 * and executing happen inside one request, so there is no window in which a
 * token could be intercepted and no binding to recompute - the amount and
 * destination being authorised are the ones in the request being handled.
 */
export async function verifyPinForUserId(
  userId: string,
  pin: string,
  context: { ipAddress?: string } = {}
) {
  const record = await pinForUser(userId);
  if (!record) throw badRequest('Set a withdrawal PIN before you withdraw.', { code: 'PIN_NOT_SET' });

  const now = Date.now();
  if (record.lockedUntil && Date.parse(record.lockedUntil) > now) {
    throw forbidden('Too many incorrect PIN attempts. Please try again later.', {
      code: 'PIN_LOCKED',
      retryAt: record.lockedUntil,
    });
  }
  if (record.withdrawalsHeldUntil && Date.parse(record.withdrawalsHeldUntil) > now) {
    throw forbidden('Withdrawals are paused because your PIN changed recently.', {
      code: 'PIN_HELD',
      clearsAt: record.withdrawalsHeldUntil,
    });
  }

  const candidate = hashPin(userId, pin, record.pinSalt);
  if (!secureEqual(candidate.pinHash, record.pinHash)) {
    const failedAttempts = (record.failedAttempts ?? 0) + 1;
    const lockedUntil =
      failedAttempts >= MAX_FAILED_ATTEMPTS
        ? new Date(now + LOCKOUT_MINUTES * 60 * 1000).toISOString()
        : record.lockedUntil;
    await db.upsertWithdrawalPinRecord({ ...record, failedAttempts, lockedUntil, updatedAt: nowIso() });
    await createAuditLog({
      actorType: 'user',
      actorId: userId,
      action: 'withdrawal_pin.verify_failed',
      resourceType: 'withdrawal_pin',
      resourceId: userId,
      ipAddress: context.ipAddress,
      metadata: { channel: 'web', failedAttempts, locked: Boolean(lockedUntil) },
    });
    // The count is returned so the user can see the lockout approaching rather
    // than meeting it without warning.
    throw forbidden('That PIN is not correct.', {
      code: 'PIN_INVALID',
      attemptsRemaining: Math.max(0, MAX_FAILED_ATTEMPTS - failedAttempts),
    });
  }

  await db.upsertWithdrawalPinRecord({ ...record, failedAttempts: 0, lockedUntil: undefined, updatedAt: nowIso() });
  return { userId };
}

/**
 * Verify a PIN presented from a chat channel and, on success, mint a step-up
 * token bound to exactly one withdrawal.

 *
 * The caller is a bot authenticated by the service secret. That secret proves
 * WHICH SERVICE is calling; it must never by itself prove that the ACCOUNT
 * OWNER agreed. This function is the only place that turns the second fact
 * into a credential, which is why a leaked bot secret cannot move money on its
 * own.
 */
export async function verifyWithdrawalPin(
  input: z.infer<typeof verifyWithdrawalPinSchema>,
  resolveUserId: (channel: IdentityChannel, identity: string) => Promise<string | undefined>,
  context: { ipAddress?: string } = {}
) {
  const userId = await resolveUserId(input.channel, input.identity);

  // An unknown identity and a wrong PIN return the same error, deliberately.
  // Distinguishing them turns this endpoint into an oracle for which phone
  // numbers hold Sivan accounts.
  const genericFailure = () => forbidden('That PIN is not correct.');

  if (!userId) throw genericFailure();
  const record = await pinForUser(userId);
  if (!record) {
    // No PIN set is a distinct, non-secret state: the bot must be able to tell
    // the user to go and set one. It reveals nothing an attacker holding the
    // channel could not discover by trying to withdraw.
    throw badRequest('NO_PIN_SET');
  }

  const now = Date.now();
  if (record.lockedUntil && Date.parse(record.lockedUntil) > now) {
    throw forbidden('Too many incorrect PIN attempts. Try again later, or reset your PIN on the web.');
  }
  if (record.withdrawalsHeldUntil && Date.parse(record.withdrawalsHeldUntil) > now) {
    throw forbidden('Withdrawals are paused because your PIN changed recently. This clears automatically.', {
      code: 'PIN_HELD',
      clearsAt: record.withdrawalsHeldUntil,
    });
  }

  const candidate = hashPin(userId, input.pin, record.pinSalt);
  if (!secureEqual(candidate.pinHash, record.pinHash)) {
    const failedAttempts = (record.failedAttempts ?? 0) + 1;
    const lockedUntil =
      failedAttempts >= MAX_FAILED_ATTEMPTS
        ? new Date(now + LOCKOUT_MINUTES * 60 * 1000).toISOString()
        : record.lockedUntil;
    await db.upsertWithdrawalPinRecord({ ...record, failedAttempts, lockedUntil, updatedAt: nowIso() });
    await createAuditLog({
      actorType: 'user',
      actorId: userId,
      action: 'withdrawal_pin.verify_failed',
      resourceType: 'withdrawal_pin',
      resourceId: userId,
      ipAddress: context.ipAddress,
      metadata: { channel: input.channel, failedAttempts, locked: Boolean(lockedUntil) },
    });
    throw genericFailure();
  }

  // Success clears the counter. An attacker cannot accumulate failures across
  // a legitimate user's successful withdrawals.
  await db.upsertWithdrawalPinRecord({ ...record, failedAttempts: 0, lockedUntil: undefined, updatedAt: nowIso() });

  const token = crypto.randomBytes(32).toString('base64url');
  const stepUp: WithdrawalStepUpTokenRecord = {
    id: `wsu_${crypto.randomUUID()}`,
    userId,
    tokenHash: tokenHash(token),
    bindingHash: bindingHash({
      userId,
      amount: input.amount,
      currency: input.currency,
      destinationRef: input.destinationRef,
    }),
    channel: input.channel,
    amountText: canonicalAmount(input.amount),
    currency: input.currency.trim().toUpperCase(),
    destinationRef: input.destinationRef.trim(),
    usedAt: undefined,
    expiresAt: new Date(now + STEP_UP_TOKEN_TTL_SECONDS * 1000).toISOString(),
    createdAt: nowIso(),
  };
  await db.upsertWithdrawalStepUpTokenRecord(stepUp);

  await createAuditLog({
    actorType: 'user',
    actorId: userId,
    action: 'withdrawal_pin.verified',
    resourceType: 'withdrawal_step_up_token',
    resourceId: stepUp.id,
    ipAddress: context.ipAddress,
    metadata: { channel: input.channel, currency: stepUp.currency, amount: stepUp.amountText },
  });

  // The plaintext token is returned exactly once, here. Only its hash is
  // stored, so it cannot be recovered from the database later.
  return { stepUpToken: token, expiresAt: stepUp.expiresAt, userId };
}

/**
 * Spend a step-up token against the withdrawal it was minted for.
 *
 * Called by the withdrawal endpoint, which must treat a false return as "this
 * request is not authorised" and stop. Consuming and checking are one operation
 * so that two concurrent requests carrying the same token cannot both proceed.
 */
export async function consumeStepUpToken(input: {
  token: string;
  userId: string;
  amount: string;
  currency: string;
  destinationRef: string;
}) {
  const tokens = await db.listWithdrawalStepUpTokens();
  const hashed = tokenHash(input.token);
  const record = tokens.find((item) => secureEqual(item.tokenHash, hashed));
  if (!record) throw forbidden('This withdrawal needs your PIN.');

  if (record.usedAt) throw forbidden('That confirmation was already used. Please confirm again.');
  if (Date.parse(record.expiresAt) <= Date.now()) throw forbidden('That confirmation expired. Please confirm again.');
  if (record.userId !== input.userId) throw forbidden('This withdrawal needs your PIN.');

  // The binding is recomputed from the request that actually arrived, not from
  // the columns stored alongside the token. A token minted for one payout
  // therefore cannot authorise a different amount or a different destination,
  // even though the bot holds a valid secret and a valid token.
  const expected = bindingHash({
    userId: input.userId,
    amount: input.amount,
    currency: input.currency,
    destinationRef: input.destinationRef,
  });
  if (!secureEqual(expected, record.bindingHash)) {
    await createAuditLog({
      actorType: 'user',
      actorId: input.userId,
      action: 'withdrawal_pin.binding_mismatch',
      resourceType: 'withdrawal_step_up_token',
      resourceId: record.id,
      metadata: { channel: record.channel },
    });
    throw forbidden('These withdrawal details changed after you confirmed. Please confirm again.');
  }

  const consumed = await db.consumeWithdrawalStepUpToken(record.id, nowIso());
  // The database refuses the second consumer of the same row. Losing that race
  // is not an error to retry - it means someone else already spent this token.
  if (!consumed) throw forbidden('That confirmation was already used. Please confirm again.');

  return { userId: record.userId, channel: record.channel as IdentityChannel };
}
