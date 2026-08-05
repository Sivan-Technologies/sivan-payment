/**
 * GAS SPONSORSHIP: WHAT IT COSTS, AND WHAT STOPS IT BEING DRAINED.
 *
 * Sivan sponsors the network fee on every transfer - `sponsor: true` on both
 * the EVM and Solana paths - so a user never needs to hold SOL or ETH. Privy
 * required confirmation that we would follow their security guidance before
 * enabling Solana sponsorship, and this module is the arithmetic half of that.
 *
 *
 * THE TWO COSTS ARE NOT THE SAME SIZE, AND CONFLATING THEM MISLEADS.
 *
 *   transaction fee   5,000 lamports    ~$0.0008 at SOL $150
 *   ATA rent          0.00203928 SOL    ~$0.31   at SOL $150
 *
 * A transfer costs a tenth of a cent. A transfer to an address that has never
 * held the token costs 400x that, because it must create an Associated Token
 * Account carrying a rent-exempt deposit. Only the second is worth defending
 * against, and only the second is worth pricing.
 *
 *
 * THE ATTACK THIS EXISTS TO STOP.
 *
 * Privy document a rent-refund exploit: an ATA's rent is refunded to the
 * ACCOUNT OWNER when it closes, not to whoever paid to create it. Their
 * example is an app whose transactions include `CloseAccount`. Sivan never
 * emits that instruction - verified by grep across the whole backend - so the
 * literal exploit does not apply.
 *
 * The same economics are reachable another way, though: sign up, verify once,
 * then loop small transfers to freshly generated addresses. Each costs Sivan
 * ~$0.31 of sponsored rent, and the attacker can later close those accounts
 * and keep it. At a $0.25 fee that is a net transfer of value away from Sivan
 * on every send.
 *
 * So the control that matters is not "how many transfers" - those are free -
 * it is "how many NEW RECIPIENTS". The two limits below reflect that: the
 * transfer count is a coarse backstop, and the new-recipient count is the real
 * defence.
 *
 *
 * WHY GRADUATED BY ACCOUNT AGE.
 *
 * Privy recommend starting new accounts conservatively. But every user is new
 * in week one, and a launch where genuine early adopters hit a wall is worse
 * than the gas it saves - so the tiers are deliberately generous. Worst case
 * at the top tier is 10 new recipients x $0.31 = $3.10 per user per day, and a
 * user paying ten new people a day is a business, not an attacker.
 */

/** Lamports charged per Solana signature. Protocol constant. */
export const SOLANA_SIGNATURE_LAMPORTS = 5_000;

/** Rent-exempt deposit for an SPL token account, in SOL. */
export const SOLANA_ATA_RENT_SOL = 0.00203928;

/**
 * SOL price used to express sponsored cost in dollars.
 *
 * A CONSTANT, DELIBERATELY, and not a live feed. This number exists to drive a
 * safety limit and an admin display, not to settle anything - and a circuit
 * breaker whose threshold moves with a price oracle is one that trips at
 * unpredictable times for reasons unrelated to usage. Privy report actual
 * spend in USD via GET /v1/apps/gas_spend; that is the number to reconcile
 * against, and this is only the pre-flight estimate.
 *
 * Overridable by an admin so it can be corrected without a deploy when SOL
 * moves far enough to matter.
 */
export const DEFAULT_SOL_PRICE_USD = 150;

export interface GasLimitTier {
  /** Inclusive lower bound on account age, in hours. */
  minAgeHours: number;
  /** Total transfers permitted in a rolling 24h. */
  transfersPerDay: number;
  /** Transfers to a NEVER-SEEN recipient permitted in a rolling 24h. */
  newRecipientsPerDay: number;
  label: string;
}

/**
 * Generous on purpose. See the header: an early-phase product cannot afford to
 * obstruct its first users, and the transfer count is nearly free to allow.
 */
export const DEFAULT_GAS_LIMIT_TIERS: GasLimitTier[] = [
  { minAgeHours: 0, transfersPerDay: 10, newRecipientsPerDay: 3, label: 'First 24 hours' },
  { minAgeHours: 24, transfersPerDay: 20, newRecipientsPerDay: 5, label: 'First week' },
  { minAgeHours: 24 * 7, transfersPerDay: 50, newRecipientsPerDay: 10, label: 'Established' },
];

export interface GasControls {
  /** Master switch. Off means no per-user limits are applied at all. */
  limitsEnabled: boolean;
  /**
   * Report-only. Limits are evaluated and logged but never enforced.
   *
   * THE INTENDED LAUNCH STATE. These thresholds are guesses until real traffic
   * exists, and guessing wrong in the strict direction costs customers rather
   * than money. Run in warn mode, read a fortnight of real behaviour, then
   * enforce numbers that are grounded in it.
   */
  warnOnly: boolean;
  tiers: GasLimitTier[];
  /** Rolling-24h sponsored spend, in USD, at which new-ATA sends are refused. */
  dailyBudgetUsd: number;
  /** For converting SOL costs to USD. Not a price oracle - see the constant. */
  solPriceUsd: number;
}

export const DEFAULT_GAS_CONTROLS: GasControls = {
  limitsEnabled: true,
  warnOnly: true,
  tiers: DEFAULT_GAS_LIMIT_TIERS,
  /**
   * $25/day, not the $50 first proposed.
   *
   * Derived rather than picked: at the top tier, 100 active users x 3 new
   * recipients x $0.31 is about $93/day of legitimate worst case. A $50
   * breaker would trip on real traffic at ~50 users. $25 is deliberately low
   * for launch, when there are far fewer users than that - a breaker that
   * trips early and loudly is information, not an outage, and the number is
   * admin-settable the moment real spend data exists.
   */
  dailyBudgetUsd: 25,
  solPriceUsd: DEFAULT_SOL_PRICE_USD,
};

/** USD cost of one sponsored Solana transaction, excluding any ATA creation. */
export function solanaTransactionCostUsd(solPriceUsd = DEFAULT_SOL_PRICE_USD): number {
  return (SOLANA_SIGNATURE_LAMPORTS / 1e9) * solPriceUsd;
}

/** USD cost of creating one Associated Token Account. */
export function ataRentCostUsd(solPriceUsd = DEFAULT_SOL_PRICE_USD): number {
  return SOLANA_ATA_RENT_SOL * solPriceUsd;
}

/**
 * What Sivan sponsors for one transfer.
 *
 * EVM transfers are excluded: Base gas is paid in ETH and has no ATA
 * equivalent, and folding a different chain's economics into one number would
 * make the budget meaningless. Returns 0 for anything that is not Solana, and
 * the caller is expected to treat that as "not tracked here" rather than free.
 */
export function sponsoredCostUsd(input: {
  network: string;
  createsRecipientAccount?: boolean;
  solPriceUsd?: number;
}): number {
  if (String(input.network).toLowerCase() !== 'solana') return 0;
  const price = input.solPriceUsd ?? DEFAULT_SOL_PRICE_USD;
  const base = solanaTransactionCostUsd(price);
  return input.createsRecipientAccount ? base + ataRentCostUsd(price) : base;
}

/** The tier that applies to an account of this age. */
export function tierForAge(ageHours: number, tiers: GasLimitTier[] = DEFAULT_GAS_LIMIT_TIERS): GasLimitTier {
  const sorted = [...tiers].sort((a, b) => a.minAgeHours - b.minAgeHours);
  let match = sorted[0];
  for (const tier of sorted) {
    if (ageHours >= tier.minAgeHours) match = tier;
  }
  return match;
}

export interface GasLimitDecision {
  allowed: boolean;
  /** True when the limit WOULD have refused but warnOnly is on. */
  wouldRefuse: boolean;
  /** Which rule decided. 'none' when nothing applied. */
  rule: 'none' | 'transfers_per_day' | 'new_recipients_per_day' | 'daily_budget';
  tier: string;
  /** User-facing. Must always say when the limit resets. */
  reason?: string;
  /** For the log and the admin, never the user. */
  detail?: Record<string, unknown>;
}

export interface GasLimitInput {
  /** Age of the account in hours. */
  accountAgeHours: number;
  /** Transfers this user has made in the rolling window. */
  transfersToday: number;
  /** Distinct NEW recipients this user has funded in the rolling window. */
  newRecipientsToday: number;
  /** Whether the pending transfer creates a recipient account. */
  createsRecipientAccount: boolean;
  /** Platform-wide sponsored spend in the rolling window, USD. */
  spendTodayUsd: number;
  controls: GasControls;
  /** Hours until the oldest counted event ages out. For the message. */
  resetInHours?: number;
}

/**
 * Decide whether one transfer may proceed.
 *
 * Pure: no database, no clock. Every caller - the transfer path, the tests,
 * the admin preview - runs the same arithmetic on the same inputs.
 */
export function checkGasLimits(input: GasLimitInput): GasLimitDecision {
  const { controls } = input;
  const tier = tierForAge(input.accountAgeHours, controls.tiers);
  const resetText = input.resetInHours && input.resetInHours > 0
    ? ` Try again in about ${Math.ceil(input.resetInHours)} hour${Math.ceil(input.resetInHours) === 1 ? '' : 's'}.`
    : ' This limit resets on a rolling 24-hour basis.';

  const allow = (): GasLimitDecision => ({ allowed: true, wouldRefuse: false, rule: 'none', tier: tier.label });

  if (!controls.limitsEnabled) return allow();

  const refuse = (rule: GasLimitDecision['rule'], reason: string, detail: Record<string, unknown>): GasLimitDecision => ({
    // warnOnly inverts ONLY the outcome, never the evaluation. The decision is
    // still computed and reported so a fortnight of warn-mode logs says
    // exactly what enforcement would have done.
    allowed: controls.warnOnly,
    wouldRefuse: true,
    rule,
    tier: tier.label,
    reason,
    detail: { ...detail, warnOnly: controls.warnOnly },
  });

  /**
   * THE PLATFORM BUDGET IS CHECKED FIRST, and refuses ONLY new-ATA transfers.
   *
   * Halting ordinary transfers because a COST limit was reached would be an
   * outage in response to a spending problem - they cost $0.0008 each and are
   * not what drained the budget. Only the expensive kind is stopped.
   */
  if (controls.dailyBudgetUsd > 0 && input.spendTodayUsd >= controls.dailyBudgetUsd && input.createsRecipientAccount) {
    return refuse(
      'daily_budget',
      'Sending to a brand-new address is paused for a few hours while we top up network funding. '
      + 'Transfers to addresses you have paid before are unaffected.',
      { spendTodayUsd: input.spendTodayUsd, dailyBudgetUsd: controls.dailyBudgetUsd }
    );
  }

  if (input.createsRecipientAccount && input.newRecipientsToday >= tier.newRecipientsPerDay) {
    return refuse(
      'new_recipients_per_day',
      `You can send to ${tier.newRecipientsPerDay} new address${tier.newRecipientsPerDay === 1 ? '' : 'es'} per day.`
      + ` Sending to someone you have already paid still works.${resetText}`,
      { newRecipientsToday: input.newRecipientsToday, limit: tier.newRecipientsPerDay }
    );
  }

  if (input.transfersToday >= tier.transfersPerDay) {
    return refuse(
      'transfers_per_day',
      `You have reached your daily limit of ${tier.transfersPerDay} transfers.${resetText}`,
      { transfersToday: input.transfersToday, limit: tier.transfersPerDay }
    );
  }

  return allow();
}
