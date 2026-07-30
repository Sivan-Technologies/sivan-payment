/**
 * Fee policy: turns an amount into the fee actually charged.
 *
 * Each flow can express a different shape, because Bridge exposes a different
 * mechanism for each. Getting this wrong means either charging a fee Bridge
 * does not withhold (a shortfall Sivan absorbs) or promising a rate that
 * cannot be applied.
 *
 *   ON-RAMP        POST /transfers { developer_fee: "1.30" }
 *                  A fixed USD AMOUNT that Sivan computes per order, because
 *                  the amount is known at quote time. A floor and tiers are
 *                  therefore fully expressible, and Bridge withholds exactly
 *                  what is sent.
 *
 *   OFF-RAMP       POST /liquidation_addresses { custom_developer_fee_percent }
 *                  A flat PERCENTAGE fixed when the address is created. The
 *                  user sends funds later, so no amount exists at that moment.
 *                  A floor or tier is impossible - not restricted, impossible.
 *
 *   VIRTUAL ACCT   POST /virtual_accounts { developer_fee_percent }
 *                  Same problem: fixed at creation, deposits arrive later.
 *                  Bridge's fee_config adds minimum_fee/maximum_fee but is in
 *                  beta with onboarding halted until Q3 2026.
 *
 * So a floor and tiers apply to ON-RAMP ONLY. This module makes that explicit
 * rather than leaving each call site to rediscover it.
 */

export interface FeeTier {
  /** Inclusive lower bound in the source currency. */
  minAmount: number;
  /** Exclusive upper bound, or null for the top tier. */
  maxAmount: number | null;
  percent: number;
}

export interface OnrampFeePolicyInput {
  amount: number;
  /** Flat percentage used when no tier matches. */
  basePercent: number;
  /** Minimum fee in USD. 0 disables the floor. */
  minimumFeeUsd: number;
  /** Ordered tiers. An empty array means a flat basePercent. */
  tiers: FeeTier[];
  /**
   * Bridge enforces transaction minimums AFTER the developer fee is deducted,
   * and dust below the minimum is neither credited nor returned. A fee that
   * pushes the net under this threshold would destroy the user's funds, so it
   * is capped rather than applied.
   */
  transactionMinimumUsd?: number;
}

export interface OnrampFeeResult {
  /** USD amount to send to Bridge as `developer_fee`. Two decimals. */
  feeAmount: string;
  /** Effective percentage actually charged, for display and reporting. */
  effectivePercent: string;
  /** Amount the user receives after the fee. */
  netAmount: string;
  /** Which rule produced this fee, for the UI and for support questions. */
  appliedRule: 'tier' | 'base_percent' | 'minimum_fee' | 'capped_to_minimum_net';
  /** Human-readable explanation, safe to show an admin or a support agent. */
  explanation: string;
}

function round2(value: number): number {
  // Bridge accepts at most 2 decimal places on developer_fee.
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Tiers are validated rather than trusted: an overlap or a gap would make the
 * fee depend on array order, which is the kind of bug that shows up as a
 * customer complaint months later.
 */
export function validateTiers(tiers: FeeTier[]): string[] {
  const errors: string[] = [];
  if (!tiers.length) return errors;

  const sorted = [...tiers].sort((a, b) => a.minAmount - b.minAmount);

  if (sorted[0].minAmount !== 0) {
    errors.push(`The first tier must start at 0, but starts at ${sorted[0].minAmount}.`);
  }

  for (let i = 0; i < sorted.length; i += 1) {
    const tier = sorted[i];
    if (tier.percent < 0 || tier.percent > 100) {
      errors.push(`Tier ${i + 1} percent must be between 0 and 100, got ${tier.percent}.`);
    }
    if (tier.maxAmount !== null && tier.maxAmount <= tier.minAmount) {
      errors.push(`Tier ${i + 1} ends (${tier.maxAmount}) at or before it starts (${tier.minAmount}).`);
    }
    const next = sorted[i + 1];
    if (!next) {
      if (tier.maxAmount !== null) {
        errors.push('The last tier must be open-ended (no upper bound), otherwise large amounts have no fee.');
      }
      continue;
    }
    if (tier.maxAmount === null) {
      errors.push(`Tier ${i + 1} is open-ended but is not the last tier.`);
      continue;
    }
    if (tier.maxAmount < next.minAmount) {
      errors.push(`Gap between ${tier.maxAmount} and ${next.minAmount}: amounts in between have no fee.`);
    }
    if (tier.maxAmount > next.minAmount) {
      errors.push(`Tiers ${i + 1} and ${i + 2} overlap between ${next.minAmount} and ${tier.maxAmount}.`);
    }
  }

  return errors;
}

export function findTier(amount: number, tiers: FeeTier[]): FeeTier | undefined {
  return tiers.find(
    (t) => amount >= t.minAmount && (t.maxAmount === null || amount < t.maxAmount)
  );
}

/**
 * Compute the on-ramp fee for a specific amount.
 *
 * Order matters and is deliberate:
 *   1. tier percentage, else base percentage
 *   2. raise to the minimum fee if below it
 *   3. reduce if the net would fall under Bridge's transaction minimum
 *
 * Step 3 last, because protecting the user's funds outranks collecting a fee.
 */
export function calculateOnrampFee(input: OnrampFeePolicyInput): OnrampFeeResult {
  const { amount, basePercent, minimumFeeUsd, tiers, transactionMinimumUsd = 0 } = input;

  if (!(amount > 0)) {
    return {
      feeAmount: '0.00',
      effectivePercent: '0.00',
      netAmount: '0.00',
      appliedRule: 'base_percent',
      explanation: 'Amount must be greater than zero.',
    };
  }

  const tier = findTier(amount, tiers);
  const percent = tier ? tier.percent : basePercent;

  let fee = round2((amount * percent) / 100);
  let rule: OnrampFeeResult['appliedRule'] = tier ? 'tier' : 'base_percent';
  let explanation = tier
    ? `${percent}% (tier ${tier.minAmount}\u2013${tier.maxAmount ?? '\u221e'})`
    : `${percent}% flat`;

  if (minimumFeeUsd > 0 && fee < minimumFeeUsd) {
    fee = round2(minimumFeeUsd);
    rule = 'minimum_fee';
    explanation = `$${minimumFeeUsd.toFixed(2)} minimum applied (${percent}% would have been $${round2((amount * percent) / 100).toFixed(2)})`;
  }

  // Bridge enforces its transaction minimum AFTER the developer fee, and dust
  // below that is neither credited nor returned. Never let a fee destroy the
  // user's funds.
  if (transactionMinimumUsd > 0 && amount - fee < transactionMinimumUsd) {
    const maxFee = round2(Math.max(amount - transactionMinimumUsd, 0));
    if (maxFee < fee) {
      fee = maxFee;
      rule = 'capped_to_minimum_net';
      explanation =
        `Fee reduced to $${fee.toFixed(2)} so the net stays at or above Bridge's ` +
        `$${transactionMinimumUsd.toFixed(2)} transaction minimum.`;
    }
  }

  const net = round2(amount - fee);
  const effective = amount > 0 ? (fee / amount) * 100 : 0;

  return {
    feeAmount: fee.toFixed(2),
    effectivePercent: effective.toFixed(2),
    netAmount: net.toFixed(2),
    appliedRule: rule,
    explanation,
  };
}

/**
 * A preview across representative amounts.
 *
 * Exists so an admin can see the consequences of a tier change before saving.
 * A fee table is easy to get subtly wrong, and the failure mode is charging
 * real customers the wrong amount.
 */
export function previewOnrampFees(
  input: Omit<OnrampFeePolicyInput, 'amount'>,
  amounts: number[] = [10, 25, 50, 100, 250, 500, 1000, 5000]
) {
  return amounts.map((amount) => {
    const result = calculateOnrampFee({ ...input, amount });
    return {
      amount: amount.toFixed(2),
      fee: result.feeAmount,
      net: result.netAmount,
      effectivePercent: result.effectivePercent,
      rule: result.appliedRule,
    };
  });
}
