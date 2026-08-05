/**
 * WHAT A CRYPTO-TO-CRYPTO TRANSFER COSTS.
 *
 * Sivan sponsors gas on every send - `sponsor: true` on both the EVM and the
 * Solana path in privy-wallet.provider.ts - and charged nothing for it. The
 * whole of balance.service.ts contained no fee logic at all; the only economic
 * guard was a 10 USDC minimum. Every transfer was a pure loss, and the loss was
 * invisible because nothing recorded it.
 *
 *
 * WHY A PERCENTAGE WITH A FLOOR AND A CAP, AND NOT A FIXED FEE.
 *
 * A single fixed fee was the first proposal. The numbers rule it out:
 *
 *     amount    $0.50 flat     $0.25 flat
 *     $10          5.00%          2.50%
 *     $50          1.00%          0.50%
 *     $100         0.50%          0.25%
 *
 * At $0.50 the $10 sender pays TEN TIMES the rate of the $100 sender for an
 * identical service. Sivan is WhatsApp-first for a Nigerian market, so small
 * everyday transfers are the core case, not the edge - a fixed fee taxes
 * exactly the users the product exists for.
 *
 * A flat percentage fails the other way: 1% of $1,000 is $10 to cover half a
 * cent of Solana gas. That is not a fee, it is a toll on the transfers most
 * worth having.
 *
 * So: 0.5%, never below $0.10, never above $1.00.
 *
 *     $10   $0.10   1.00%
 *     $20   $0.10   0.50%
 *     $50   $0.25   0.50%
 *     $100  $0.50   0.50%
 *     $500  $1.00   0.20%
 *     $1000 $1.00   0.10%
 *
 * Everyone between $20 and $200 pays exactly 0.5%, so nobody can point at
 * another user paying less for the same thing.
 *
 *
 * WHY NOT BANDS OR TIERS, WHICH LOOK TIDIER IN AN ADMIN PANEL.
 *
 * A banded structure was modelled and rejected:
 *
 *     0-25:$0.15 | 25-100:$0.35 | 100-500:$0.75 | 500+:$1.50
 *         $99.99 -> $0.35        $100.01 -> $0.75
 *
 * The fee MORE THAN DOUBLES across two cents. A user who notices that is being
 * cheated in a way that cannot be defended. This curve is continuous
 * everywhere: $19.99 -> $0.1000 and $20.01 -> $0.1001. Verified in the suite.
 *
 *
 * ONE IMPLEMENTATION, SERVED TO THE FRONTEND.
 *
 * This module is the only place the rule exists. The UI asks the API what a
 * transfer costs rather than recomputing it, because two copies of a pricing
 * rule is how they come to disagree - and a UI that quotes a different fee from
 * the one charged is a support ticket that reads as theft. Guarded by
 * test:transfer-fee-policy, which fails if the formula appears in frontend
 * source.
 */

/**
 * Six decimals, trailing zeros stripped.
 *
 * MATCHES money() IN balance.service.ts EXACTLY, and that matters more than
 * which format is nicer. That function renders 100 as "100", not "100.000000",
 * and its output is what lands in `amount` on every transfer and ledger entry.
 * A fee formatted differently would put two conventions in one record - so a
 * consumer comparing `amount` against `fee + netAmount` as strings would find
 * them unequal while the numbers agree. Caught by the ledger suite when the
 * gross came back "100" and the fee "0.500000".
 *
 * USDC and USDT both use six decimals on every chain here, and floats drift
 * past that, so six is the precision before trimming.
 */
const money = (value: number) =>
  (Math.round(value * 1e6) / 1e6).toFixed(6).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');

export interface TransferFeeConfig {
  /** Percentage of the amount, before the floor and cap are applied. */
  percent: number;
  /** Never charge less than this. 0 disables the floor. */
  minimumUsd: number;
  /** Never charge more than this. 0 disables the cap. */
  maximumUsd: number;
  /**
   * Added when the transfer must CREATE the recipient's token account.
   *
   * On Solana an Associated Token Account carries a rent-exempt deposit of
   * 0.00203928 SOL - about $0.31 at SOL $150 - and Sivan sponsors it. That is
   * 400x the transaction fee itself, which is $0.00075, so the two are
   * completely different costs and only one of them is worth pricing.
   *
   * Charged ONLY on the transfer that actually creates the account, which is
   * the first send to any given address. A flat floor high enough to cover it
   * would tax every transfer for a cost most of them do not cause: at a $0.45
   * floor a $10 send pays 4.5% forever, against local P2P spreads of 1-3%.
   * With the surcharge the same user pays 2.5% to someone they have paid
   * before, and 5.5% once when they add a new recipient.
   *
   * 0 disables it.
   */
  newRecipientUsd: number;
}

export interface TransferFeeQuote {
  /** What the user typed. */
  amount: string;
  /** Sivan's fee, six decimals. */
  fee: string;
  /**
   * What actually reaches the recipient.
   *
   * DEDUCTED, not added. A user sending 100 USDC has 100 leave their balance
   * and the recipient receives 99.50. This matches what every exchange
   * withdrawal does, so it is what a user arriving from Binance already
   * expects, and it removes an entire class of failure where a "send max" is
   * rejected for being fee-short of its own balance.
   */
  netAmount: string;
  /** Effective rate actually charged, for display. Never the nominal percent. */
  effectivePercent: string;
  /** The percentage/floor/cap part, before any surcharge. */
  baseFee: string;
  /** The new-recipient surcharge, or "0" when none applies. */
  newRecipientFee: string;
  /** True when this transfer creates the recipient's token account. */
  createsRecipientAccount: boolean;
  /** Which rule produced the BASE fee. For the UI, and for support. */
  appliedRule: 'percent' | 'minimum' | 'maximum';
  /** One line, safe to show a user or an admin. */
  explanation: string;
}

/**
 * The default curve. Overridden by the admin fee settings at runtime; these
 * values exist so a deployment that has never opened the fee tab still charges
 * something sane rather than nothing.
 */
export const DEFAULT_TRANSFER_FEE: TransferFeeConfig = {
  percent: 0.5,
  minimumUsd: 0.25,
  maximumUsd: 1,
  newRecipientUsd: 0.3,
};

/**
 * Price one transfer.
 *
 * Pure, and deliberately so: no database, no clock, no environment. Every
 * caller - the quote endpoint, the transfer path, the tests - runs the same
 * arithmetic on the same inputs.
 */
export function quoteTransferFee(
  amount: number,
  config: TransferFeeConfig = DEFAULT_TRANSFER_FEE,
  options: { createsRecipientAccount?: boolean } = {}
): TransferFeeQuote {
  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const percent = Math.max(0, config.percent);
  const floor = Math.max(0, config.minimumUsd);
  const ceiling = Math.max(0, config.maximumUsd);

  const raw = safeAmount * (percent / 100);

  let fee = raw;
  let appliedRule: TransferFeeQuote['appliedRule'] = 'percent';
  if (floor > 0 && fee < floor) {
    fee = floor;
    appliedRule = 'minimum';
  }
  // Cap AFTER the floor. If a misconfiguration sets the cap below the floor,
  // the cap wins - it is the promise most visible to the user ("never more
  // than $1"), and honouring the floor instead would charge more than the
  // advertised maximum.
  if (ceiling > 0 && fee > ceiling) {
    fee = ceiling;
    appliedRule = 'maximum';
  }

  const baseFee = fee;

  /**
   * THE SURCHARGE, ONLY WHEN THE COST IS ACTUALLY INCURRED.
   *
   * Added AFTER the cap, deliberately. The cap limits Sivan's MARGIN; the
   * surcharge recovers a real out-of-pocket cost. Folding the surcharge under
   * the cap would mean a $500 transfer to a new address hits the $1 ceiling
   * and silently absorbs the $0.31 rent, which is the exact subsidy this
   * exists to remove.
   */
  const createsRecipientAccount = Boolean(options.createsRecipientAccount);
  const surcharge = createsRecipientAccount ? Math.max(0, config.newRecipientUsd) : 0;
  fee += surcharge;

  /**
   * THE FEE CAN NEVER EXCEED THE AMOUNT.
   *
   * With a $0.10 floor a 0.05 USDC transfer would otherwise be charged more
   * than it is worth and produce a NEGATIVE net - which downstream becomes a
   * transfer of a negative amount, and the provider would either reject it or,
   * worse, not. The minimum send amount should prevent this ever being reached;
   * this is the guard for when it is misconfigured.
   */
  if (fee > safeAmount) {
    fee = safeAmount;
    appliedRule = 'maximum';
  }

  const net = Math.max(0, safeAmount - fee);
  const effective = safeAmount > 0 ? (fee / safeAmount) * 100 : 0;

  const baseExplanation =
    appliedRule === 'minimum'
      ? `Minimum fee of $${floor.toFixed(2)} applied`
      : appliedRule === 'maximum'
        ? `Capped at the maximum fee of $${ceiling.toFixed(2)}`
        : `${percent}% of the amount sent`;

  /**
   * The user-facing reason. Named as a RECIPIENT ACCOUNT cost, not a "network"
   * or "gas" fee: Sivan sponsors the gas, so calling this a network fee would
   * be a claim a user can disprove on an explorer in thirty seconds. Creating
   * the account genuinely is a one-time on-chain cost, and saying so is both
   * true and reassuring - it explains why the same recipient is cheaper next
   * time.
   */
  const explanation = surcharge > 0
    ? `${baseExplanation}, plus a one-time $${surcharge.toFixed(2)} to set up this recipient's ${'' /* asset-agnostic */}account on chain`
    : baseExplanation;

  return {
    amount: money(safeAmount),
    fee: money(fee),
    baseFee: money(Math.min(baseFee, safeAmount)),
    newRecipientFee: money(surcharge),
    createsRecipientAccount,
    netAmount: money(net),
    effectivePercent: effective.toFixed(2),
    appliedRule,
    explanation,
  };
}

/**
 * The smallest transfer at which this curve is defensible.
 *
 * Not used as a gate - the admin sets the minimum send amount - but exposed so
 * the fee tab can warn when the two disagree. At a $0.10 floor a $5 transfer
 * costs 2%, which is high but honest; a $1 transfer would cost 10%, which is
 * not. Surfacing the number stops someone dropping the minimum to $1 without
 * seeing what it does to the effective rate.
 */
export function effectiveRateAt(amount: number, config: TransferFeeConfig = DEFAULT_TRANSFER_FEE): number {
  return Number(quoteTransferFee(amount, config).effectivePercent);
}

/**
 * Default minimum send amount, in the asset's own units.
 *
 * Lives here beside the fee curve because the two only make sense together:
 * the minimum is what stops the fee floor becoming an absurd effective rate.
 * At $5 with a $0.10 floor the worst case is 2%; at $1 it would be 10%.
 */
export const DEFAULT_TRANSFER_MIN_SEND = 10;
