/**
 * Structural, not an import from ./activityFeed - same reason that module
 * declares its own record shapes. The backend test suite imports this file and
 * the backend tsconfig uses node16 resolution, which requires explicit .js
 * extensions; importing across would drag the frontend's extensionless graph
 * into that compile. Only the two fields these KPIs read are declared.
 */
type ActivityRow = { state: 'pending' | 'success' | 'failed'; status: string };

/**
 * THE THREE NUMBERS A USER OPENS THE DASHBOARD FOR.
 *
 * The row used to be four cards, two of which were broken the same way the
 * activity feed was - single-source reads on a six-source product:
 *
 *   Payout volume   read ONLY `withdrawals`, so it showed $0.00 while the
 *                   account had 2 COMPLETED crypto sends. It also summed
 *                   destinationAmount across usd|gbp|eur and prefixed "$", so
 *                   a GBP and a EUR payout would have rendered as one dollar
 *                   figure. That never fired only because nothing had
 *                   completed yet.
 *   Transactions    a count of rows, directly above the list of rows.
 *
 * Both contradicted the unified feed the moment it shipped: the card said
 * "0 Lifetime" while six transactions sat underneath it.
 *
 * Replaced by questions rather than metrics:
 *
 *   Your balance   what can I spend            (unifiedBalance, unchanged)
 *   In progress    is anything stuck           (derived here)
 *   Your limit     how much headroom is left   (derived here, naira only)
 *
 * Everything here is a pure function of data the client already holds. No new
 * endpoint, and - the point of the exercise - no second source of truth that
 * can disagree with the list below it.
 */

/**
 * Statuses where the USER is the blocker.
 *
 * The distinction the card exists to make: "2 in progress" is ambient, "1
 * needs you" is a call to action. Kept as raw provider statuses rather than
 * matching on the friendly label, because the label is presentation and could
 * be reworded without anyone realising it broke this.
 */
const WAITING_ON_USER = new Set([
  'awaiting_payment',
  'pending_deposit',
  'awaiting_crypto_deposit',
  'awaiting_deposit',
  'requires_action',
]);

export interface InProgressKpi {
  /** Everything still moving. */
  count: number;
  /** The subset the user can personally unblock. */
  needsYou: number;
  value: string;
  sub: string;
  trend: string;
  /** 'action' when the user is the blocker, so the card can stop looking calm. */
  tone: 'ok' | 'action';
}

export function inProgressKpi(rows: ActivityRow[]): InProgressKpi {
  const pending = rows.filter((row) => row.state === 'pending');
  const needsYou = pending.filter((row) => WAITING_ON_USER.has(String(row.status).toLowerCase())).length;

  return {
    count: pending.length,
    needsYou,
    value: String(pending.length),
    sub: pending.length ? 'Moving right now' : 'Nothing in flight',
    /**
     * Three states, in descending order of what the user should do about it.
     * "All on track" is deliberately reassuring rather than empty: something
     * IS happening, it just is not their turn.
     */
    trend: needsYou > 0
      ? `${needsYou} need${needsYou === 1 ? 's' : ''} you`
      : pending.length > 0
        ? 'All on track'
        : 'Nothing pending',
    tone: needsYou > 0 ? 'action' : 'ok',
  };
}

/** Minimal shape read from VerificationSummary - see activityFeed for why. */
interface Allowance {
  flow: string;
  rail: string;
  limitNgn: number | null;
  usedNgn: number;
  remainingNgn: number | null;
}
interface Summary {
  level: number;
  levelLabel: string;
  path: 'ngn_bank' | 'bridge_kyc';
  windowDays: number;
  allowances: Allowance[];
  nextStep?: { description?: string; available?: boolean };
}

export interface LimitKpi {
  label: string;
  value: string;
  sub: string;
  trend: string;
  tone: 'ok' | 'action' | 'muted';
}

/**
 * WHETHER TO SHOW A NAIRA LIMIT AT ALL.
 *
 * limitNgn is the internal DENOMINATOR for every limit, including the foreign
 * rail - a UK user selling USDC for GBP has a real enforced cap, it is simply
 * expressed in a currency they never touch. So the rule is not "hide this from
 * non-Nigerians", it is:
 *
 *   never show a ₦ figure to someone who does not transact in ₦.
 *
 * Same outcome for a Nigerian today, but it stays correct if the rails ever
 * cross. `path` is derived from user.country server-side
 * (verificationPathFor(user.country)), so this IS the country gate - named for
 * what it means rather than where it came from.
 */
export function showsNairaLimit(summary: Summary | null | undefined): boolean {
  return summary?.path === 'ngn_bank';
}

const ngn = (value: number) => `₦${Math.round(value).toLocaleString('en-NG')}`;

/**
 * The third card. Returns a LIMIT card for naira users and a VERIFICATION card
 * for everyone else - a different question for a different user, not a
 * degraded fallback.
 *
 * A UK user is therefore left with no visible limit even though the foreign
 * rail is capped. That is a real gap and it is what ships today; closing it
 * needs limits expressible in the user's own currency, which is backend work
 * and not something to fake with a hardcoded FX rate on a dashboard card.
 */
export function limitKpi(summary: Summary | null | undefined, summaryLoaded: boolean): LimitKpi {
  // Never a confident number before the answer arrives. The dashboard has
  // shipped this bug twice already - a KPI that reads zero or "Incomplete"
  // while loading accuses a verified user of not being verified.
  if (!summaryLoaded || !summary) {
    return { label: 'Verification', value: '—', sub: 'Checking…', trend: 'Loading your status', tone: 'muted' };
  }

  if (!showsNairaLimit(summary)) {
    return {
      label: 'Verification',
      value: summary.levelLabel.replace(/^Level \d+: /, ''),
      sub: `Level ${summary.level}`,
      trend: summary.nextStep?.description ? 'Higher limits available' : 'Ready',
      tone: 'ok',
    };
  }

  /**
   * The naira OFF-RAMP allowance specifically: selling crypto for naira is
   * what a Nigerian user is doing, and it is the ceiling they actually meet.
   */
  const offramp = summary.allowances.find((a) => a.flow === 'offramp' && a.rail === 'ngn');

  if (!offramp) {
    // Server did not report the allowance. Say nothing rather than invent a
    // ceiling - a wrong limit is worse than an absent one.
    return {
      label: 'Verification',
      value: summary.levelLabel.replace(/^Level \d+: /, ''),
      sub: `Level ${summary.level}`,
      trend: 'Ready',
      tone: 'ok',
    };
  }

  // null is genuinely uncapped and is already modelled server-side. Rendering
  // it as ₦0 would tell an unlimited user they can do nothing.
  if (offramp.remainingNgn === null) {
    return {
      label: 'Your limit',
      value: 'No limit',
      sub: `${summary.levelLabel} · selling to naira`,
      trend: 'Uncapped at your level',
      tone: 'ok',
    };
  }

  const spent = offramp.limitNgn !== null && offramp.limitNgn > 0;
  return {
    label: 'Your limit',
    // REMAINING, not the ceiling. "₦100,000" reads as "you may sell 100k"
    // even after they have sold 90k of it.
    value: `${ngn(offramp.remainingNgn)} left`,
    sub: `${summary.levelLabel} · next ${summary.windowDays} days`,
    trend: summary.nextStep?.description && summary.nextStep.available === false
      // The NIN/BVN step exists but has no provider wired, so it must not be
      // offered as something they can go and do right now.
      ? 'Higher limits coming'
      : summary.nextStep?.description
        ? 'Raise your limit'
        : spent
          ? `${ngn(offramp.usedNgn)} used`
          : 'Ready',
    // Amber once the limit is actually spent: at ₦0 left the user cannot
    // transact and needs to know that is why, not read a calm green "Ready".
    tone: offramp.remainingNgn === 0 ? 'action' : 'ok',
  };
}
