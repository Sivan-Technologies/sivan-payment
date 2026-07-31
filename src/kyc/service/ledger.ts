/**
 * The Sivan ledger.
 *
 * THE LEDGER IS THE SOURCE OF TRUTH. Chain state is used to verify and
 * reconcile, never read as a balance.
 *
 * Why that rule is not negotiable, once wallets exist:
 *
 *   - someone sends tokens straight to a wallet address that were never a
 *     Sivan deposit. On-chain they are there. They are not the user's balance.
 *   - escrow holds funds that exist on-chain but are NOT spendable by the
 *     holder. No chain query can tell you that; only a ledger can.
 *   - a provider settles late, partially, or reverses.
 *   - a webhook is delivered twice.
 *
 * WHAT THIS ADDS OVER THE EXISTING balance.service LEDGER
 *
 * That one stores entries as audit logs and dedupes with read-then-write. Two
 * defects were measured before writing this, not assumed:
 *
 *   1. CONCURRENT duplicates get through. Three simultaneous writes of the same
 *      (sourceType, sourceId, kind) produced 3 entries where 1 was wanted. The
 *      check reads, then writes, with an await in between - so two webhook
 *      retries arriving together both see "no existing entry" and both insert.
 *      Duplicate credits are how a user is paid twice.
 *
 *   2. Nothing balances. A single unbacked debit of -999,999 was accepted and
 *      left the user at -999,599. There is no counter-entry requirement and no
 *      non-negative constraint, so a bug anywhere upstream silently becomes a
 *      wrong balance with no trace of where it came from.
 *
 * This module fixes both: postings are applied inside one db.mutate() so the
 * idempotency check and the insert cannot be interleaved, and a posting is a
 * SET of entries that must sum to zero.
 */

import { db } from '../../database/json-database.js';
import { id, nowIso } from '../../shared/id.js';

export type LedgerAsset = 'usdc' | 'usdt' | 'ngn';

/**
 * Accounts a posting can move value between.
 *
 * Double entry needs somewhere for value to come FROM. A deposit is not "user
 * +100"; it is "external -100, user +100". Without the other side there is
 * nothing to reconcile against and no way to prove the books are whole.
 */
export type LedgerAccount =
  /** Outside Sivan: a bank, a chain, a provider. */
  | 'external'
  /** A user's spendable balance. */
  | 'user_available'
  /** A user's funds locked in escrow. Real, but not spendable. */
  | 'user_held'
  /** Sivan's fee income. */
  | 'revenue';

export interface LedgerLeg {
  account: LedgerAccount;
  /** Required for user_* accounts, absent for external and revenue. */
  userId?: string;
  asset: LedgerAsset;
  /** Signed minor-unit string. Credits positive, debits negative. */
  amount: string;
}

export interface PostingInput {
  /**
   * Caller-supplied idempotency key.
   *
   * The same key must always describe the same posting. A provider's transfer
   * id plus the event kind is a good key; a timestamp is not.
   */
  idempotencyKey: string;
  kind: 'deposit' | 'withdrawal' | 'escrow_hold' | 'escrow_release' | 'fee' | 'adjustment';
  legs: LedgerLeg[];
  reference?: string;
  description?: string;
}

export interface PostingRecord extends PostingInput {
  postingId: string;
  createdAt: string;
}

export class LedgerError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

/**
 * Integer minor units, parsed from a string.
 *
 * Strings in, integers internally. A float cannot represent 0.1 exactly, and a
 * ledger that drifts by fractions of a cent per entry is a ledger that will not
 * reconcile after ten thousand rows.
 */
function toMinor(amount: string): number {
  const value = Number(amount);
  if (!Number.isFinite(value)) throw new LedgerError(`Amount is not a number: ${amount}`, 'invalid_amount');
  if (!Number.isInteger(value)) {
    throw new LedgerError(`Amount must be in minor units, got ${amount}`, 'invalid_amount');
  }
  return value;
}

function accountKey(leg: LedgerLeg): string {
  return leg.userId ? `${leg.account}:${leg.userId}:${leg.asset}` : `${leg.account}:${leg.asset}`;
}

/**
 * A posting must balance, per asset.
 *
 * Checked per asset rather than overall, because +100 USDC and -100 NGN sum to
 * zero while describing something incoherent.
 */
export function validatePosting(input: PostingInput): void {
  if (!input.idempotencyKey || !input.idempotencyKey.trim()) {
    throw new LedgerError('idempotencyKey is required', 'missing_key');
  }
  if (!Array.isArray(input.legs) || input.legs.length < 2) {
    throw new LedgerError('A posting needs at least two legs', 'single_leg');
  }

  const perAsset = new Map<LedgerAsset, number>();
  for (const leg of input.legs) {
    const amount = toMinor(leg.amount);
    if (amount === 0) throw new LedgerError('A leg cannot be zero', 'zero_leg');
    if ((leg.account === 'user_available' || leg.account === 'user_held') && !leg.userId) {
      throw new LedgerError(`${leg.account} requires a userId`, 'missing_user');
    }
    perAsset.set(leg.asset, (perAsset.get(leg.asset) ?? 0) + amount);
  }

  for (const [asset, sum] of perAsset) {
    if (sum !== 0) {
      throw new LedgerError(
        `Posting does not balance for ${asset}: legs sum to ${sum}, must be 0`,
        'unbalanced'
      );
    }
  }
}

/**
 * Apply a posting atomically.
 *
 * The idempotency check and the insert happen inside ONE db.mutate() with no
 * await between them. That is the whole point: the existing ledger checks for a
 * duplicate, awaits, then writes, so two concurrent webhook retries both see
 * nothing and both insert. Measured: 3 concurrent identical writes produced 3
 * entries.
 *
 * Returns the existing posting unchanged when the key has been seen, so a retry
 * is a no-op rather than an error - which is what a provider retrying a webhook
 * actually needs.
 */
export async function postToLedger(input: PostingInput): Promise<{ posting: PostingRecord; duplicate: boolean }> {
  validatePosting(input);

  return db.mutate((data: any) => {
    data.ledgerPostings = data.ledgerPostings ?? [];

    const existing = data.ledgerPostings.find((p: PostingRecord) => p.idempotencyKey === input.idempotencyKey);
    if (existing) return { posting: existing, duplicate: true };

    const posting: PostingRecord = {
      ...input,
      postingId: id('post'),
      createdAt: nowIso(),
    };
    data.ledgerPostings.push(posting);
    return { posting, duplicate: false };
  });
}

export interface BalanceSnapshot {
  available: number;
  held: number;
  /** available + held. What the user "has", spendable or not. */
  total: number;
}

/**
 * Balance for one user and asset, derived by replaying postings.
 *
 * Derived rather than stored on purpose. A stored balance and a set of entries
 * are two sources of truth that will eventually disagree, and when they do
 * there is no way to know which is right.
 */
export async function getBalance(userId: string, asset: LedgerAsset): Promise<BalanceSnapshot> {
  const data = await db.read();
  const postings: PostingRecord[] = (data as any).ledgerPostings ?? [];

  let available = 0;
  let held = 0;

  for (const posting of postings) {
    for (const leg of posting.legs) {
      if (leg.asset !== asset || leg.userId !== userId) continue;
      const amount = toMinor(leg.amount);
      if (leg.account === 'user_available') available += amount;
      if (leg.account === 'user_held') held += amount;
    }
  }

  return { available, held, total: available + held };
}

/**
 * Every account balance, for reconciliation.
 *
 * If the books are whole, every asset sums to exactly zero across all accounts
 * including `external`. A non-zero total means value was created or destroyed,
 * which is a bug, not a rounding artefact.
 */
export async function trialBalance(): Promise<{ byAccount: Record<string, number>; byAsset: Record<string, number> }> {
  const data = await db.read();
  const postings: PostingRecord[] = (data as any).ledgerPostings ?? [];

  const byAccount: Record<string, number> = {};
  const byAsset: Record<string, number> = {};

  for (const posting of postings) {
    for (const leg of posting.legs) {
      const amount = toMinor(leg.amount);
      byAccount[accountKey(leg)] = (byAccount[accountKey(leg)] ?? 0) + amount;
      byAsset[leg.asset] = (byAsset[leg.asset] ?? 0) + amount;
    }
  }

  return { byAccount, byAsset };
}

/**
 * Would this spend overdraw the user?
 *
 * Called BEFORE building a posting. The ledger itself does not refuse a
 * negative available balance - an adjustment or a correction legitimately can -
 * so the guard belongs at the point of spending, where the caller knows intent.
 */
export async function canSpend(userId: string, asset: LedgerAsset, minorAmount: number): Promise<boolean> {
  if (!Number.isInteger(minorAmount) || minorAmount <= 0) return false;
  const balance = await getBalance(userId, asset);
  return balance.available >= minorAmount;
}

// -------------------------------------------------------------- builders

/** External value arriving and becoming spendable. */
export function depositPosting(args: {
  idempotencyKey: string;
  userId: string;
  asset: LedgerAsset;
  minorAmount: number;
  reference?: string;
}): PostingInput {
  return {
    idempotencyKey: args.idempotencyKey,
    kind: 'deposit',
    reference: args.reference,
    legs: [
      { account: 'external', asset: args.asset, amount: String(-args.minorAmount) },
      { account: 'user_available', userId: args.userId, asset: args.asset, amount: String(args.minorAmount) },
    ],
  };
}

/**
 * Moving a user's own funds from spendable to held.
 *
 * Both legs belong to the same user: nothing enters or leaves Sivan, the funds
 * simply stop being spendable. This is the state no chain query can express.
 */
export function escrowHoldPosting(args: {
  idempotencyKey: string;
  userId: string;
  asset: LedgerAsset;
  minorAmount: number;
  reference?: string;
}): PostingInput {
  return {
    idempotencyKey: args.idempotencyKey,
    kind: 'escrow_hold',
    reference: args.reference,
    legs: [
      { account: 'user_available', userId: args.userId, asset: args.asset, amount: String(-args.minorAmount) },
      { account: 'user_held', userId: args.userId, asset: args.asset, amount: String(args.minorAmount) },
    ],
  };
}

/** Held funds released to the counterparty. */
export function escrowReleasePosting(args: {
  idempotencyKey: string;
  fromUserId: string;
  toUserId: string;
  asset: LedgerAsset;
  minorAmount: number;
  feeMinorAmount?: number;
  reference?: string;
}): PostingInput {
  const fee = args.feeMinorAmount ?? 0;
  const net = args.minorAmount - fee;
  if (net < 0) throw new LedgerError('Fee cannot exceed the amount released', 'fee_exceeds_amount');

  const legs: LedgerLeg[] = [
    { account: 'user_held', userId: args.fromUserId, asset: args.asset, amount: String(-args.minorAmount) },
    { account: 'user_available', userId: args.toUserId, asset: args.asset, amount: String(net) },
  ];
  if (fee > 0) legs.push({ account: 'revenue', asset: args.asset, amount: String(fee) });

  return { idempotencyKey: args.idempotencyKey, kind: 'escrow_release', reference: args.reference, legs };
}

/** Value leaving Sivan, with the fee split out. */
export function withdrawalPosting(args: {
  idempotencyKey: string;
  userId: string;
  asset: LedgerAsset;
  minorAmount: number;
  feeMinorAmount?: number;
  reference?: string;
}): PostingInput {
  const fee = args.feeMinorAmount ?? 0;
  const net = args.minorAmount - fee;
  if (net < 0) throw new LedgerError('Fee cannot exceed the amount withdrawn', 'fee_exceeds_amount');

  const legs: LedgerLeg[] = [
    { account: 'user_available', userId: args.userId, asset: args.asset, amount: String(-args.minorAmount) },
    { account: 'external', asset: args.asset, amount: String(net) },
  ];
  if (fee > 0) legs.push({ account: 'revenue', asset: args.asset, amount: String(fee) });

  return { idempotencyKey: args.idempotencyKey, kind: 'withdrawal', reference: args.reference, legs };
}
