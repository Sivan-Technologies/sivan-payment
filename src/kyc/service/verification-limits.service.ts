import { z } from 'zod';
import { db } from '../../database/json-database.js';
import { badRequest } from '../../shared/errors.js';
import { nowIso } from '../../shared/id.js';
import { FLOW_LIMITS, VerificationLevel } from '../types/verification.types.js';
import type { FlowType, RailFamily } from '../types/verification.types.js';
import type { VerificationLimitOverride } from './verification-policy.js';

/**
 * Admin control over the verification ceilings.
 *
 * The ceilings were compiled into FLOW_LIMITS, so moving one required a code
 * change and a deploy. That is the wrong shape for a compliance number that
 * has to track the business, and it produced a concrete deadlock: Breet's live
 * minimum deposit is $50 (~NGN 80,000) while the BANK off-ramp ceiling was NGN
 * 50,000 per 30 days, so a Level 1 user could not clear a single withdrawal.
 *
 * Overrides are sparse. A row exists only where an admin has deliberately
 * departed from the shipped default, which keeps the defaults meaningful and
 * makes "what did we change" a one-row answer rather than a diff against a
 * full copy of the table.
 */

const FLOWS = ['escrow', 'offramp', 'onramp'] as const;
const RAILS = ['ngn', 'foreign'] as const;

export const setVerificationLimitSchema = z.object({
  flow: z.enum(FLOWS),
  rail: z.enum(RAILS),
  level: z.union([
    z.literal(VerificationLevel.NONE),
    z.literal(VerificationLevel.BANK),
    z.literal(VerificationLevel.IDENTITY),
    z.literal(VerificationLevel.ENHANCED),
  ]),
  /**
   * NULL is UNLIMITED and is NOT the same as 0, which closes the flow. Both
   * are legitimate, so this is nullable rather than optional-with-default -
   * an admin must say which one they mean.
   */
  cumulativeNgn: z.number().min(0).nullable(),
  reason: z.string().trim().min(1).max(500).optional(),
  updatedBy: z.string().trim().min(1).default('admin'),
});

export type SetVerificationLimitInput = z.infer<typeof setVerificationLimitSchema>;

export const clearVerificationLimitSchema = z.object({
  flow: z.enum(FLOWS),
  rail: z.enum(RAILS),
  level: z.union([
    z.literal(VerificationLevel.NONE),
    z.literal(VerificationLevel.BANK),
    z.literal(VerificationLevel.IDENTITY),
    z.literal(VerificationLevel.ENHANCED),
  ]),
});

/** The shipped default for a combination, before any override. */
export function defaultLimitFor(
  flow: FlowType,
  rail: RailFamily,
  level: VerificationLevel
): number | null {
  const match = FLOW_LIMITS.find((l) => l.flow === flow && l.rail === rail && l.level === level);
  return match ? match.cumulativeNgn : 0;
}

/**
 * Every override currently in force.
 *
 * Loaded once per request by callers and passed into decide(), so the policy
 * itself stays synchronous and testable without a database.
 */
export async function listVerificationLimitOverrides(): Promise<VerificationLimitOverride[]> {
  const rows = await db.listVerificationLimitOverrides();

  return rows.map((row) => ({
    flow: row.flow as FlowType,
    rail: row.rail as RailFamily,
    level: row.level as VerificationLevel,
    // Preserve the null/number distinction exactly. Coercing null to 0 here
    // would turn "unlimited" into "closed" - the most damaging possible
    // rounding of this particular value.
    cumulativeNgn: row.cumulativeNgn === null || row.cumulativeNgn === undefined
      ? null
      : Number(row.cumulativeNgn),
  }));
}

/**
 * The full picture for an admin screen: default, override, and what is live.
 *
 * Showing the default alongside the override is the point. An admin needs to
 * see what they changed it FROM, or the screen is just a list of numbers with
 * no way to judge whether one is sensible.
 */
export async function getVerificationLimitMatrix() {
  const overrides = await listVerificationLimitOverrides();

  return FLOW_LIMITS.map((entry) => {
    const override = overrides.find(
      (o) => o.flow === entry.flow && o.rail === entry.rail && o.level === entry.level
    );

    return {
      flow: entry.flow,
      rail: entry.rail,
      level: entry.level,
      defaultCumulativeNgn: entry.cumulativeNgn,
      overrideCumulativeNgn: override ? override.cumulativeNgn : undefined,
      isOverridden: Boolean(override),
      effectiveCumulativeNgn: override ? override.cumulativeNgn : entry.cumulativeNgn,
    };
  });
}

/**
 * Set (or replace) one ceiling.
 *
 * Refuses to make a HIGHER level more restrictive than a LOWER one. The ladder
 * only means something if it ascends: if BANK were raised above IDENTITY, a
 * user who completed extra verification would find themselves with a smaller
 * allowance than before they bothered, and lowestSufficientLevel() would send
 * them to a level that does not actually unblock them.
 */
export async function setVerificationLimit(input: SetVerificationLimitInput) {
  const overrides = await listVerificationLimitOverrides();

  const effective = (level: VerificationLevel): number | null => {
    if (level === input.level) return input.cumulativeNgn;
    const override = overrides.find(
      (o) => o.flow === input.flow && o.rail === input.rail && o.level === level
    );
    return override ? override.cumulativeNgn : defaultLimitFor(input.flow, input.rail, level);
  };

  const ladder = [
    VerificationLevel.NONE,
    VerificationLevel.BANK,
    VerificationLevel.IDENTITY,
    VerificationLevel.ENHANCED,
  ];

  for (let i = 1; i < ladder.length; i += 1) {
    const lower = effective(ladder[i - 1]!);
    const higher = effective(ladder[i]!);

    // null is unlimited, so a null above anything is fine, and anything above
    // a null is a regression.
    if (lower === null && higher !== null) {
      throw badRequest(
        `Level ${ladder[i]} would be capped at ${higher} while level ${ladder[i - 1]} is unlimited. ` +
          'A higher verification level cannot allow less than a lower one.'
      );
    }
    if (lower !== null && higher !== null && higher < lower) {
      throw badRequest(
        `Level ${ladder[i]} would allow ${higher} while level ${ladder[i - 1]} allows ${lower}. ` +
          'A higher verification level cannot allow less than a lower one.'
      );
    }
  }

  return db.upsertVerificationLimitOverride({
    flow: input.flow,
    rail: input.rail,
    level: input.level,
    cumulativeNgn: input.cumulativeNgn,
    reason: input.reason,
    updatedBy: input.updatedBy,
    updatedAt: nowIso(),
  });
}

/** Remove an override, returning the combination to its shipped default. */
export async function clearVerificationLimit(input: z.infer<typeof clearVerificationLimitSchema>) {
  await db.deleteVerificationLimitOverride(input.flow, input.rail, input.level);
  return { cleared: true, ...input, revertedTo: defaultLimitFor(input.flow, input.rail, input.level) };
}
