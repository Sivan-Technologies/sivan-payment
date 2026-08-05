import { db } from '../database/json-database.js';
import { createAuditLog } from '../audit/audit.service.js';
import { id, nowIso } from '../shared/id.js';
import type { DepositDetectionSource, WalletDepositRecord } from '../database/types.js';

/**
 * LAYER 1: THE DEPOSIT RECORD.
 *
 * A Sivan user sells on Binance and withdraws USDC to their Sivan address.
 * That is the most common way money ENTERS this product for the launch market,
 * and before this module the system did nothing about it: no record, no feed
 * row, no notification. unified-balance.service.ts read a live chain balance
 * and the number was simply bigger than last time.
 *
 * See database/migrations/042_create_wallet_deposits.sql for the full account
 * of the gap.
 *
 *
 * THIS FILE IS THE SEAM.
 *
 * `recordDeposit` is the ONLY way a deposit enters the system. Everything
 * upstream of it - the balance poller today, an Alchemy/Helius webhook next,
 * possibly Privy later - exists solely to produce a `DepositObservation` and
 * hand it over. Everything downstream - the activity feed, the notifier - reads
 * `WalletDepositRecord` and never learns how the deposit was noticed.
 *
 * That is deliberate and it is the whole architecture. Swapping the detector
 * is a change to one file above this line. If a future change makes the feed
 * or the notifier care about `detectionSource`, that is the signal the seam
 * has leaked and should be pushed back here.
 *
 *
 * AN OBSERVATION LOG, NOT A LEDGER.
 *
 * Nothing here credits anybody. Spendable balance is still computed by reading
 * the chain in unified-balance.service.ts. These rows record that something was
 * seen, at a time, from a source. If they ever become a second authority on how
 * much money a user has, the result is the ledger-vs-chain drift written up in
 * LEDGER-VERDICT.md - two numbers that disagree and no way to say which is
 * right. Resist it.
 */

/**
 * What a detector must produce. Deliberately smaller than the record: id,
 * timestamps and the idempotency key are this module's business, not the
 * detector's.
 */
export interface DepositObservation {
  userId: string;
  walletId: string;
  address: string;
  chain: string;
  asset: string;
  /** Human units, six decimals. Detectors convert; storage never sees wei. */
  amount: string;
  detectionSource: DepositDetectionSource;
  /**
   * Supplied by detectors that see a transaction. The balance poller cannot,
   * so it passes a synthetic key instead - see depositIdempotencyKey.
   */
  txHash?: string;
  sender?: string;
  blockNumber?: number;
  blockTimestamp?: string;
  /**
   * Overrides the derived key. Only for detectors whose natural key is not
   * chain:txHash:logIndex - the balance poller uses this.
   */
  idempotencyKeyOverride?: string;
  rawPayload?: unknown;
}

/**
 * The key that makes at-least-once delivery safe.
 *
 * Every detector delivers more than once. Privy documents "at least once" with
 * an eight-step retry schedule; RPC vendors re-fire; a poller re-reads the same
 * balance every tick. And during the poll -> webhook migration two detectors
 * run deliberately at the same time on the same wallets.
 *
 * A duplicate is not a cosmetic problem. It is a second "you received money"
 * message for money received once, which a user reads as either a double credit
 * or a phishing attempt. Both are worse than silence.
 *
 * With a transaction the key is natural and exact. `logIndex` defaults to 0 and
 * matters for a single transaction containing two transfers to the same wallet
 * - rare, but a batch payout from an exchange is exactly that shape.
 */
export function depositIdempotencyKey(input: {
  chain: string;
  txHash?: string;
  logIndex?: number;
  address?: string;
  asset?: string;
  windowStart?: string;
}): string {
  if (input.txHash) {
    return `${input.chain}:${input.txHash.toLowerCase()}:${input.logIndex ?? 0}`;
  }
  /**
   * BALANCE-POLL FORM, AND ITS KNOWN LIMITATION.
   *
   * A balance delta has no transaction attached, so the key can only describe
   * "this wallet, this asset, this tick". Two real deposits inside one tick
   * therefore COLLAPSE INTO ONE RECORD, with the combined amount.
   *
   * That is a deliberate trade, not an oversight. The alternative - keying on
   * the amount, or on a random value - produces a DUPLICATE row every time the
   * same balance is read twice, and a missed second observation is recoverable
   * from the chain while a duplicated "you received money" message is not
   * recoverable from the user's trust.
   *
   * It disappears entirely once detection moves to webhooks, which is the main
   * reason to make that move.
   */
  return `${input.chain}:${(input.address ?? '').toLowerCase()}:${input.asset}:balance:${input.windowStart}`;
}

export interface RecordDepositResult {
  record: WalletDepositRecord;
  /** False when this observation was already known. Nothing should re-fire. */
  created: boolean;
}

/**
 * Record a deposit, idempotently.
 *
 * Safe to call repeatedly with the same observation. `created` tells the caller
 * whether anything downstream should happen; on a duplicate the answer is
 * always no.
 *
 * Deposits are recorded as PENDING. They are real - the chain has been read -
 * but not yet final, and the user is told immediately with wording that does
 * not claim spendability. Matching how exchanges themselves behave, because the
 * anxious moment is "I sent it and nothing happened", and resolving that fast
 * is worth more than one perfectly-final message later.
 */
export async function recordDeposit(observation: DepositObservation): Promise<RecordDepositResult> {
  const at = nowIso();
  const idempotencyKey =
    observation.idempotencyKeyOverride ??
    depositIdempotencyKey({
      chain: observation.chain,
      txHash: observation.txHash,
      address: observation.address,
      asset: observation.asset,
      windowStart: at
    });

  const candidate: WalletDepositRecord = {
    id: id('dep'),
    userId: observation.userId,
    walletId: observation.walletId,
    address: observation.address,
    chain: observation.chain,
    asset: observation.asset,
    amount: observation.amount,
    txHash: observation.txHash,
    sender: observation.sender,
    blockNumber: observation.blockNumber,
    blockTimestamp: observation.blockTimestamp,
    status: 'pending',
    detectionSource: observation.detectionSource,
    idempotencyKey,
    rawPayload: observation.rawPayload,
    createdAt: at,
    updatedAt: at
  };

  const outcome = await db.insertWalletDepositIfNew(candidate);

  /**
   * Audited only when NEW.
   *
   * A retry storm from a webhook vendor would otherwise write hundreds of
   * identical audit entries for one deposit, which is how the stale-transfer
   * alert produced 66 events for 3 transfers. The audit log should record
   * that money arrived, once.
   */
  if (outcome.created) {
    await createAuditLog({
      action: 'deposit.observed',
      resourceType: 'wallet_deposit',
      resourceId: outcome.record.id,
      actorType: 'system',
      metadata: {
        userId: outcome.record.userId,
        chain: outcome.record.chain,
        asset: outcome.record.asset,
        amount: outcome.record.amount,
        detectionSource: outcome.record.detectionSource,
        txHash: outcome.record.txHash ?? null
      }
    }).catch(() => undefined);
  }

  return outcome;
}

export async function listUserDeposits(userId: string): Promise<WalletDepositRecord[]> {
  return db.listWalletDeposits(userId);
}
