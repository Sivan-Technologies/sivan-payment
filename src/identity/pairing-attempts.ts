import { env } from '../config/env.js';
import { tooManyRequests } from '../shared/errors.js';
import type { IdentityChannel } from '../database/types.js';

/**
 * Failed-attempt lockout for pairing-code redemption.
 *
 * This is the brute-force control. The per-IP limiter in shared/rate-limit.ts
 * is not, and cannot be: both bots relay every user from a single IP, so that
 * bucket is sized for a whole population (300/min) and is deliberately generous.
 * A single attacker sitting inside that allowance still gets 300 guesses a
 * minute, indefinitely, and every one of them looks like ordinary bot traffic.
 *
 * WHY THE KEY IS THE REDEEMER, NOT THE TOKEN
 *
 * The obvious design - count attempts on the pairing token - cannot work. A
 * wrong guess hashes to nothing, finds no row, and so has no token to count
 * against. Attempts are therefore keyed by the identity presenting the code
 * (telegram user id, or WhatsApp number), which is the one thing every attempt
 * carries whether or not the code was real.
 *
 * That key is only as trustworthy as the caller, and the caller is the bot: it
 * takes `telegramUserId` from `message.from.id` on a signed webhook. A stranger
 * who stole the service secret could rotate the field to dodge this counter,
 * which is why the secret remains the primary control and this is defence in
 * depth. What it does buy is the realistic case: one attacker, one bot account,
 * spraying guesses at ~21M combinations. Six tries per 15 minutes turns that
 * from hours into millennia.
 *
 * SUCCESS CLEARS THE COUNTER
 *
 * A user who fumbles a code twice and then gets it right is not an attacker,
 * and should not carry a penalty into their next link attempt. Only unbroken
 * runs of failure accumulate.
 *
 * IN-PROCESS, LIKE THE RATE LIMITER
 *
 * State lives in a Map, so it is per-instance and resets on deploy. Both are
 * acceptable and neither is silent: a horizontally scaled deployment multiplies
 * the effective allowance by the instance count, which is noted in
 * docs/env-vars.md next to the tunables. Moving this to Redis is the correct
 * fix when the payment API runs more than one instance, and the interface here
 * is deliberately small enough to swap.
 */

interface AttemptRecord {
  failures: number;
  firstFailureAt: number;
  lockedUntil?: number;
}

const attempts = new Map<string, AttemptRecord>();

function attemptKey(channel: IdentityChannel, identity: string) {
  return `${channel}:${identity.trim().toLowerCase()}`;
}

/**
 * Call BEFORE looking the token up. Throws 429 while a lockout is in force.
 *
 * The check has to come first: if it ran after the token lookup, a locked-out
 * attacker would still learn whether each guess matched a real code from the
 * shape of the error, which is the exact oracle the lockout exists to close.
 */
export function assertPairingAttemptAllowed(channel: IdentityChannel, identity: string) {
  if (!env.IDENTITY_PAIRING_LOCKOUT_ENABLED) return;

  const key = attemptKey(channel, identity);
  const record = attempts.get(key);
  if (!record?.lockedUntil) return;

  const now = Date.now();
  if (record.lockedUntil <= now) {
    // Lockout served. Clear it rather than leaving a stale record that would
    // make the next single failure look like the Nth.
    attempts.delete(key);
    return;
  }

  const retryAfterSeconds = Math.ceil((record.lockedUntil - now) / 1000);
  throw tooManyRequests(
    `Too many incorrect pairing codes. Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`,
    { retryAfterSeconds }
  );
}

/**
 * Call on every REJECTED redemption, whatever the reason.
 *
 * Deliberately not limited to "code not found". An expired code, a code issued
 * for the other channel, and a code belonging to an already-linked account are
 * all indistinguishable from guesses at this layer, and counting only the
 * not-found case would leave a channel-mismatch oracle wide open.
 */
export function recordFailedPairingAttempt(channel: IdentityChannel, identity: string) {
  if (!env.IDENTITY_PAIRING_LOCKOUT_ENABLED) return;

  const key = attemptKey(channel, identity);
  const now = Date.now();
  const windowMs = env.IDENTITY_PAIRING_LOCKOUT_WINDOW_MINUTES * 60 * 1000;
  const existing = attempts.get(key);

  // A fresh window, either because this is a first failure or because the
  // previous run of failures aged out without reaching the threshold.
  if (!existing || now - existing.firstFailureAt > windowMs) {
    attempts.set(key, { failures: 1, firstFailureAt: now });
    pruneExpired(now, windowMs);
    return;
  }

  existing.failures += 1;
  if (existing.failures >= env.IDENTITY_PAIRING_MAX_FAILED_ATTEMPTS) {
    existing.lockedUntil = now + env.IDENTITY_PAIRING_LOCKOUT_MINUTES * 60 * 1000;
  }
}

/**
 * Call on every SUCCESSFUL redemption. See "success clears the counter" above.
 */
export function clearPairingAttempts(channel: IdentityChannel, identity: string) {
  attempts.delete(attemptKey(channel, identity));
}

function pruneExpired(now: number, windowMs: number) {
  if (attempts.size < 5_000) return;
  for (const [key, record] of attempts.entries()) {
    const lockActive = record.lockedUntil && record.lockedUntil > now;
    if (!lockActive && now - record.firstFailureAt > windowMs) attempts.delete(key);
  }
}

/** Test seam. Never called by application code. */
export function __resetPairingAttempts() {
  attempts.clear();
}
