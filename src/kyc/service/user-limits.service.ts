import { z } from 'zod';
import { db } from '../../database/json-database.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { id, nowIso } from '../../shared/id.js';
import { createAuditLog } from '../../audit/audit.service.js';
import { VOLUME_WINDOW_DAYS } from '../types/verification.types.js';
import type { FlowType, RailFamily } from '../types/verification.types.js';
import type { UserLimitOverrideRecord } from '../../database/types.js';

/**
 * PER-USER LIMITS.
 *
 * Reported: "i want that i can be able to update or reset individual limit in
 * users". Until now the only dial was verification-limits.service.ts, which is
 * keyed (flow, rail, level) - a TIER. Raising one merchant's ceiling raised it
 * for every user at that level, so the ordinary support request had no safe
 * answer at all.
 *
 * TWO DISTINCT ACTS, kept apart deliberately:
 *
 *   OVERRIDE  "this person may go higher than their tier allows"
 *             -> changes the ceiling. Spend history untouched.
 *
 *   RESET     "the volume we already counted no longer counts against them"
 *             -> forgives usage. Ceiling untouched.
 *
 * Collapsing them into one "fix this user's limit" button would make the two
 * indistinguishable in the audit log, and they carry different risk: an
 * override is visible and bounded, a reset erases evidence of volume already
 * moved. An examiner asking "how did this account move 20x its tier ceiling"
 * must be able to tell which happened.
 *
 * WHAT A RESET DOES NOT DO: delete transactions. It records a WATERMARK, and
 * usage ignores volume at or before it. The transfers stay exactly where they
 * are, so the AML trail survives and the reset itself is reviewable.
 */

const FLOWS = ['escrow', 'offramp', 'onramp'] as const;
const RAILS = ['ngn', 'foreign'] as const;

/**
 * Guard rail on a single exception, in naira.
 *
 * Not a policy statement about what is safe - it is a typo catch. The gap
 * between a legitimate uplift (millions) and a fat-fingered one (billions) is
 * wide, and an admin who genuinely needs more can say so twice by raising this
 * constant in a reviewed deploy. Chosen because it is ~100x the ENHANCED NGN
 * off-ramp ceiling, so no legitimate single-customer exception reaches it.
 */
export const MAX_USER_LIMIT_NGN = 5_000_000_000;

export const setUserLimitSchema = z.object({
  userId: z.string().trim().min(1),
  flow: z.enum(FLOWS),
  rail: z.enum(RAILS),
  /**
   * NULL is UNLIMITED. 0 CLOSES the flow. Both are legitimate and they are
   * opposites, so this is nullable rather than optional-with-a-default - an
   * admin must say which one they mean and the API will not guess.
   */
  cumulativeNgn: z.number().min(0).max(MAX_USER_LIMIT_NGN).nullable(),
  /**
   * Required, and min(1) after trimming so whitespace cannot satisfy it. A
   * limit exception with no stated reason is unauditable, and this is the one
   * field a reviewer six months from now actually needs.
   */
  reason: z.string().trim().min(1).max(500),
  updatedBy: z.string().trim().min(1).default('admin'),
  /**
   * ISO timestamp. Absent means permanent - allowed, because an institutional
   * client may genuinely warrant one, but the admin UI defaults to a date so
   * the safe choice is the default rather than the deliberate one.
   */
  expiresAt: z.string().datetime().optional(),
});

export const clearUserLimitSchema = z.object({
  userId: z.string().trim().min(1),
  flow: z.enum(FLOWS),
  rail: z.enum(RAILS),
  clearedBy: z.string().trim().min(1).default('admin'),
  reason: z.string().trim().min(1).max(500).optional(),
});

export const resetUserWindowSchema = z.object({
  userId: z.string().trim().min(1),
  flow: z.enum(FLOWS),
  rail: z.enum(RAILS),
  reason: z.string().trim().min(1).max(500),
  createdBy: z.string().trim().min(1).default('admin'),
});

export type SetUserLimitInput = z.infer<typeof setUserLimitSchema>;

/**
 * Has this override stopped applying?
 *
 * Expiry is evaluated at READ time rather than by a sweeper job. A cron that
 * deletes expired rows would make the ceiling depend on whether the job ran,
 * and a missed run would silently extend an exception past its end date -
 * exactly the failure this field exists to prevent. Reading it live means a
 * lapsed override cannot outlive its date even if every background process is
 * dead.
 */
export function isOverrideActive(
  override: Pick<UserLimitOverrideRecord, 'expiresAt'>,
  now: number = Date.now()
): boolean {
  if (!override.expiresAt) return true;
  const expiry = Date.parse(override.expiresAt);
  return Number.isFinite(expiry) ? expiry > now : true;
}

/** Active per-user overrides, expired ones already removed. */
export async function getActiveUserLimitOverrides(userId: string): Promise<UserLimitOverrideRecord[]> {
  const rows = await db.listUserLimitOverrides(userId);
  return rows.filter((row) => isOverrideActive(row));
}

/**
 * The ceiling for one user and flow, or undefined when no override applies.
 *
 * Returns `{ cumulativeNgn }` rather than a bare number precisely because null
 * is meaningful: `undefined` means "no override, use the tier", while
 * `{ cumulativeNgn: null }` means "an admin set this user to unlimited". A
 * bare `number | null` return could not tell those apart.
 */
export async function userLimitOverrideFor(
  userId: string,
  flow: FlowType,
  rail: RailFamily
): Promise<{ cumulativeNgn: number | null } | undefined> {
  const active = await getActiveUserLimitOverrides(userId);
  const match = active.find((row) => row.flow === flow && row.rail === rail);
  return match ? { cumulativeNgn: match.cumulativeNgn } : undefined;
}

/**
 * Volume forgiven for this user and flow: the most recent reset watermark.
 *
 * Only the LATEST matters. Resets are cumulative in effect, not additive - a
 * second reset supersedes the first, and summing them would double-forgive.
 */
export async function latestResetAt(
  userId: string,
  flow: FlowType,
  rail: RailFamily
): Promise<string | undefined> {
  const resets = await db.listUserLimitResets(userId);
  const forFlow = resets
    .filter((row) => row.flow === flow && row.rail === rail)
    .sort((a, b) => Date.parse(b.resetAt) - Date.parse(a.resetAt));
  return forFlow[0]?.resetAt;
}

async function requireUser(userId: string) {
  const user = await db.findUserById(userId);
  // 404 rather than a silent no-op. Setting a limit on a mistyped user id
  // would otherwise report success and change nothing, and the admin would
  // believe the customer was unblocked.
  if (!user) throw notFound('User');
  return user;
}

/**
 * Grant or replace one user's ceiling.
 *
 * Every write is audited with the before AND after value. "Who set this to 5
 * million" is answerable from the log alone, without reconstructing state.
 */
export async function setUserLimit(input: SetUserLimitInput) {
  await requireUser(input.userId);

  if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) {
    // Refused rather than stored. An override that is already expired writes a
    // row, reports success, and changes nothing - the worst combination.
    throw badRequest('expiresAt is in the past, so this override would never apply.');
  }

  const existing = (await db.listUserLimitOverrides(input.userId)).find(
    (row) => row.flow === input.flow && row.rail === input.rail
  );

  const saved = await db.upsertUserLimitOverride({
    userId: input.userId,
    flow: input.flow,
    rail: input.rail,
    cumulativeNgn: input.cumulativeNgn,
    reason: input.reason,
    updatedBy: input.updatedBy,
    expiresAt: input.expiresAt,
    updatedAt: nowIso(),
  });

  await createAuditLog({
    actorType: 'admin',
    actorId: input.updatedBy,
    action: 'admin.user_limit_set',
    resourceType: 'user_limit_override',
    resourceId: input.userId,
    // warning, not info: a limit exception is an AML-relevant act and should
    // surface in a filtered audit view rather than sink into routine traffic.
    severity: 'warning',
    metadata: {
      flow: input.flow,
      rail: input.rail,
      previousCumulativeNgn: existing ? existing.cumulativeNgn : null,
      hadPreviousOverride: Boolean(existing),
      cumulativeNgn: input.cumulativeNgn,
      unlimited: input.cumulativeNgn === null,
      expiresAt: input.expiresAt ?? null,
      reason: input.reason,
    },
  });

  return saved;
}

/** Remove an override so the user falls back to their tier ceiling. */
export async function clearUserLimit(input: z.infer<typeof clearUserLimitSchema>) {
  const existing = (await db.listUserLimitOverrides(input.userId)).find(
    (row) => row.flow === input.flow && row.rail === input.rail
  );
  if (!existing) throw notFound('User limit override');

  await db.deleteUserLimitOverride(input.userId, input.flow, input.rail);

  await createAuditLog({
    actorType: 'admin',
    actorId: input.clearedBy,
    action: 'admin.user_limit_cleared',
    resourceType: 'user_limit_override',
    resourceId: input.userId,
    severity: 'warning',
    metadata: {
      flow: input.flow,
      rail: input.rail,
      // The removed value is recorded because the row is gone: without this the
      // log would say an exception was revoked but not what it had been.
      removedCumulativeNgn: existing.cumulativeNgn,
      reason: input.reason ?? null,
    },
  });

  return { cleared: true, previous: existing };
}

/**
 * Forgive the volume already counted in this user's rolling window.
 *
 * Deliberately append-only and deliberately NOT a deletion of transfers. The
 * watermark approach means:
 *   - the transactions remain, so the AML trail is intact
 *   - the act itself is a row someone can find and question
 *   - it can be explained after the fact, because forgivenNgn is captured now
 *     and could not be recomputed once the 30-day window rolls past it
 */
export async function resetUserWindow(input: z.infer<typeof resetUserWindowSchema>) {
  await requireUser(input.userId);

  // Imported lazily to avoid a cycle: verification-state imports the database,
  // and the summary service imports this module.
  const { getCumulativeNgnVolume } = await import('./verification-state.js');
  const { effectiveUsedNgn } = await import('./user-limit-usage.js');

  const rawUsed = await getCumulativeNgnVolume(input.userId, VOLUME_WINDOW_DAYS);
  // What is being forgiven is what currently COUNTS, not the raw window total -
  // an earlier reset may already have excluded part of it, and recording the
  // raw figure would overstate what this action did.
  const forgiven = await effectiveUsedNgn(input.userId, input.flow, input.rail, rawUsed);

  const record = {
    id: id('ulr'),
    userId: input.userId,
    flow: input.flow,
    rail: input.rail,
    resetAt: nowIso(),
    forgivenNgn: forgiven,
    reason: input.reason,
    createdBy: input.createdBy,
    createdAt: nowIso(),
  };

  await db.createUserLimitReset(record);

  await createAuditLog({
    actorType: 'admin',
    actorId: input.createdBy,
    action: 'admin.user_limit_window_reset',
    resourceType: 'user_limit_reset',
    resourceId: input.userId,
    // The highest severity used here: this is the action that forgives money
    // already moved, and it should be the easiest one to find later.
    severity: 'warning',
    metadata: {
      flow: input.flow,
      rail: input.rail,
      forgivenNgn: forgiven,
      rawWindowVolumeNgn: rawUsed,
      windowDays: VOLUME_WINDOW_DAYS,
      reason: input.reason,
    },
  });

  return record;
}

/**
 * Everything an admin needs to judge one user's limits, in one call.
 *
 * Returns tier default, per-user override and the EFFECTIVE figure together.
 * An operator cannot judge a ceiling without seeing what it was changed from -
 * the same reasoning as getVerificationLimitMatrix(), applied per user.
 */
export async function getUserLimitDetail(userId: string) {
  await requireUser(userId);

  const { listVerificationLimitOverrides } = await import('./verification-limits.service.js');
  const { getVerificationState, getCumulativeNgnVolume } = await import('./verification-state.js');
  const { limitFor } = await import('./verification-policy.js');
  const { effectiveUsedNgn } = await import('./user-limit-usage.js');

  const [state, tierOverrides, userOverrides, resets, rawUsed] = await Promise.all([
    getVerificationState(userId),
    listVerificationLimitOverrides(),
    db.listUserLimitOverrides(userId),
    db.listUserLimitResets(userId),
    getCumulativeNgnVolume(userId, VOLUME_WINDOW_DAYS),
  ]);

  const rows = [];
  for (const flow of FLOWS) {
    for (const rail of RAILS) {
      const tierLimit = limitFor(flow, rail, state.level, tierOverrides);
      const override = userOverrides.find((row) => row.flow === flow && row.rail === rail);
      const active = override ? isOverrideActive(override) : false;
      const used = await effectiveUsedNgn(userId, flow, rail, rawUsed);
      const effective = active && override ? override.cumulativeNgn : tierLimit;

      rows.push({
        flow,
        rail,
        tierLimitNgn: tierLimit,
        overrideCumulativeNgn: override ? override.cumulativeNgn : undefined,
        // An EXPIRED override is reported rather than hidden. "Why did this
        // customer's limit drop overnight" is answered by seeing the lapsed
        // row, not by its absence.
        overrideExpired: Boolean(override) && !active,
        overrideExpiresAt: override?.expiresAt,
        overrideReason: override?.reason,
        isOverridden: active,
        effectiveLimitNgn: effective,
        usedNgn: used,
        remainingNgn: effective === null ? null : Math.max(effective - used, 0),
      });
    }
  }

  return {
    userId,
    level: state.level,
    windowDays: VOLUME_WINDOW_DAYS,
    rawWindowVolumeNgn: rawUsed,
    limits: rows,
    resets: resets.slice(0, 20),
  };
}
