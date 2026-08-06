import { db } from '../../database/json-database.js';
import { createAuditLog } from '../../audit/audit.service.js';
import { getNgnProvider } from '../provider/ngn-provider-registry.js';
import { getNgnControls } from './ngn-controls.service.js';
import { buildTimeline } from './ngn-transfers.service.js';
import type { NgnProviderSettlement } from '../provider/ngn-provider.js';
import type { NgnTransferRecord } from '../types/ngn.types.js';

/**
 * SETTLE FROM THE PROVIDER'S OWN RECORD, NOT FROM A WEBHOOK.
 *
 * A webhook is a notification, and a notification is allowed to fail. Ours
 * did: Breet sent six deliveries for one real settlement and every single one
 * was refused, first by a secret mismatch and then - underneath it - by a
 * confirmation call to an endpoint that does not exist for trades. 59 USDC
 * left a user's wallet, Breet converted it and paid 94,171 NGN to a PalmPay
 * account, and Sivan's own record still read "waiting for crypto deposit".
 *
 * Nothing about that was visible from inside the product. The transfer looked
 * stuck, the user would reasonably have sent again, and support had no way to
 * tell the difference between "not paid" and "paid, not told".
 *
 * So the webhook is no longer the only path. This asks the provider what it
 * did and reconciles against it, which makes delivery an OPTIMISATION - it
 * makes settlement fast - rather than the mechanism money depends on.
 *
 * Deliberately idempotent and one-directional: it only ever moves a transfer
 * FORWARD, and never past what the provider says. Running it twice, or
 * alongside a webhook that arrives late, changes nothing the second time.
 */

export interface ReconcileOutcome {
  checked: number;
  matched: number;
  advanced: Array<{ transferId: string; from: string; to: string; provider: string }>;
  unmatched: Array<{ depositAddress?: string; tradeId?: string; withdrawalStatus?: string }>;
  skipped: string[];
  /** Orders closed because nobody ever funded them. Never money at risk. */
  expired: string[];
}

/** How far along a status is. Only forward moves are applied. */
const ORDER = [
  'created',
  'quote_created',
  'quote_accepted',
  'awaiting_deposit',
  'awaiting_crypto_deposit',
  'deposit_received',
  'blockchain_confirmed',
  'processing',
  'settlement_processing',
  'bank_processing',
  'crypto_sent',
  'completed',
];

function rank(status: string): number {
  const index = ORDER.indexOf(status);
  return index < 0 ? 0 : index;
}

/**
 * What the provider's two states mean for OUR transfer.
 *
 * The trade and the withdrawal are separate. A completed trade means the
 * crypto became naira INSIDE Breet; only a completed withdrawal means the
 * naira reached the user's bank. Conflating them is how a product tells
 * somebody their money has landed when it has not.
 */
export function statusFromSettlement(
  settlement: Pick<NgnProviderSettlement, 'tradeStatus' | 'withdrawalStatus'>
): NgnTransferRecord['status'] | undefined {
  const trade = String(settlement.tradeStatus ?? '').toLowerCase();
  const withdrawal = String(settlement.withdrawalStatus ?? '').toLowerCase();

  if (withdrawal === 'completed' || withdrawal === 'success' || withdrawal === 'successful') {
    return 'completed';
  }
  if (withdrawal === 'failed' || withdrawal === 'rejected' || withdrawal === 'reversed') {
    return 'failed';
  }
  if (withdrawal === 'pending' || withdrawal === 'processing') return 'bank_processing';

  if (trade === 'flagged') return 'requires_review';
  if (trade === 'completed' || trade === 'success' || trade === 'successful') {
    return 'settlement_processing';
  }
  if (trade === 'failed' || trade === 'rejected' || trade === 'reversed') return 'failed';
  if (trade === 'pending' || trade === 'processing') return 'blockchain_confirmed';

  return undefined;
}

function matchTransfer(
  transfers: NgnTransferRecord[],
  settlement: NgnProviderSettlement
): NgnTransferRecord | undefined {
  const meta = (transfer: NgnTransferRecord) =>
    (typeof transfer.metadata === 'object' && transfer.metadata ? transfer.metadata : {}) as any;

  if (settlement.tradeId) {
    const byTrade = transfers.find((item) => meta(item).breetTradeId === settlement.tradeId);
    if (byTrade) return byTrade;
  }

  // The deposit address is the durable link. Lowercased on both sides because
  // Breet returns checksummed EVM addresses and our stored copy may not be.
  const address = String(settlement.depositAddress ?? '').toLowerCase();
  if (!address) return undefined;

  const candidates = transfers.filter(
    (item) =>
      String(item.depositAddress ?? '').toLowerCase() === address ||
      String(meta(item).transferMetadata?.depositAddress ?? '').toLowerCase() === address
  );
  if (candidates.length === 0) return undefined;

  /**
   * BREET DEPOSIT ADDRESSES ARE PERMANENT AND REUSED.
   *
   * The same address serves every future off-ramp by the same user on the
   * same asset, so an address can legitimately match several transfers. The
   * one this settlement belongs to is the oldest that has NOT already
   * completed - completing the newest instead would mark a fresh order paid
   * on the strength of an old payout.
   *
   * This is the reason the poller cannot be the only mechanism if a user
   * stacks two orders on one address inside a poll interval; the webhook,
   * once fixed, carries the trade id and is exact. Both are kept.
   */
  const open = candidates
    .filter((item) => item.status !== 'completed' && item.status !== 'failed')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return open[0] ?? candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** Nothing has been received in these states. */
const UNFUNDED_STATUSES = new Set([
  'created', 'quote_created', 'quote_accepted', 'awaiting_deposit', 'awaiting_crypto_deposit',
]);

/**
 * How long a user has to fund an off-ramp before it is closed.
 *
 * 24 hours, not minutes: a deposit address stays valid at the provider, and
 * somebody who starts a sell in the evening and finishes it next morning must
 * not find their order cancelled. Long enough to be generous, short enough
 * that a week of abandoned orders does not pile up.
 */
const UNFUNDED_EXPIRY_HOURS = Number(process.env.NGN_UNFUNDED_EXPIRY_HOURS || 24);

async function expireUnfundedOrders(
  transfers: NgnTransferRecord[],
  actorId?: string
): Promise<string[]> {
  const expired: string[] = [];
  const cutoff = Date.now() - UNFUNDED_EXPIRY_HOURS * 3_600_000;

  for (const transfer of transfers) {
    if (!UNFUNDED_STATUSES.has(String(transfer.status))) continue;
    // A tx hash means crypto DID arrive - never close one of these, whatever
    // the status field says.
    if (transfer.destinationTxHash) continue;
    const started = Date.parse(transfer.updatedAt ?? transfer.createdAt ?? '');
    if (!Number.isFinite(started) || started > cutoff) continue;

    // Same reasoning as the advance path above: an expired order whose
    // timeline still says "Waiting for crypto deposit" tells the user to keep
    // waiting for something that has been closed.
    const expiredRecord = {
      ...transfer,
      status: 'expired',
      updatedAt: new Date().toISOString(),
      metadata: {
        ...(typeof transfer.metadata === 'object' && transfer.metadata ? transfer.metadata as Record<string, unknown> : {}),
        expiredReason: `No crypto deposit received within ${UNFUNDED_EXPIRY_HOURS}h.`,
        expiredAt: new Date().toISOString(),
      },
    } as NgnTransferRecord;
    expiredRecord.timeline = buildTimeline(expiredRecord);
    await db.upsertNgnTransferRecord(expiredRecord);

    await createAuditLog({
      actorType: 'system',
      actorId: actorId || 'ngn_reconciler',
      action: 'ngn.transfer_expired',
      resourceType: 'payments_ngn_transfer',
      resourceId: transfer.id,
      severity: 'info',
      metadata: { previousStatus: transfer.status, hours: UNFUNDED_EXPIRY_HOURS },
    });
    expired.push(transfer.id);
  }

  return expired;
}

export async function reconcileNgnSettlements(
  options: { actorId?: string } = {}
): Promise<ReconcileOutcome> {
  const outcome: ReconcileOutcome = {
    checked: 0,
    matched: 0,
    advanced: [],
    unmatched: [],
    skipped: [],
    expired: [],
  };

  /**
   * EXPIRE ORDERS NOBODY EVER FUNDED - BEFORE THE PROVIDER GUARD.
   *
   * A QUOTE expires after 10 minutes, but once accepted the TRANSFER sat in
   * `awaiting_crypto_deposit` forever. Nothing ever closed it.
   *
   * Measured on api-test: 9 such transfers, the oldest two days old, every one
   * with no destinationTxHash - the user opened a sell, saw the deposit
   * address, and walked away. Harmless individually, but they accumulate and
   * held the health endpoint at critical.
   *
   * DELIBERATELY ABOVE the listSettlements() guard. Expiry is a local
   * bookkeeping decision about orders the user never funded; it needs no
   * provider call. My first version placed it after that guard, and on any
   * provider without listSettlements - the mock, and any future one - the
   * function returned early and NOTHING was ever expired. Caught by running
   * it, not by reading it.
   *
   * Conservative by design. Only closed when the status says nothing was
   * received, AND there is no destinationTxHash, AND it is older than the
   * window. Wrongly closing a funded order means somebody's money vanishing
   * from their own dashboard while it is genuinely in flight.
   */
  const allTransfers = await db.listNgnTransfers();
  outcome.expired = await expireUnfundedOrders(allTransfers, options.actorId);

  const controls = await getNgnControls();
  const provider = getNgnProvider(controls.activeProvider);
  if (typeof provider.listSettlements !== 'function') {
    outcome.skipped.push(`${controls.activeProvider} cannot list settlements`);
    return outcome;
  }

  const settlements = await provider.listSettlements();
  outcome.checked = settlements.length;

  const transfers = await db.listNgnTransfers();


  if (settlements.length === 0) return outcome;

  for (const settlement of settlements) {
    const transfer = matchTransfer(transfers, settlement);
    if (!transfer) {
      outcome.unmatched.push({
        depositAddress: settlement.depositAddress,
        tradeId: settlement.tradeId,
        withdrawalStatus: settlement.withdrawalStatus,
      });
      continue;
    }
    outcome.matched += 1;

    const next = statusFromSettlement(settlement);
    if (!next) continue;

    // requires_review is a sideways move, not a forward one, so it is allowed
    // out of any non-terminal state. Everything else only moves forward.
    const terminal = transfer.status === 'completed' || transfer.status === 'failed';
    if (terminal) continue;
    if (next !== 'requires_review' && rank(next) <= rank(transfer.status)) continue;

    const now = new Date().toISOString();
    const updated: NgnTransferRecord = {
      ...transfer,
      status: next,
      completedAt: next === 'completed' ? now : transfer.completedAt,
      destinationTxHash: settlement.txHash ?? transfer.destinationTxHash,
      metadata: {
        ...(typeof transfer.metadata === 'object' && transfer.metadata ? transfer.metadata : {}),
        breetTradeId: settlement.tradeId,
        breetWithdrawalId: settlement.withdrawalId,
        depositTxHash: settlement.txHash,
        settledCryptoAmount: settlement.cryptoAmount,
        settledFiatAmount: settlement.fiatAmount,
        // Stamped so it is obvious in support that this transfer was healed by
        // polling rather than told by a webhook - which is itself a signal
        // that webhook delivery needs looking at.
        reconciledFromProvider: true,
        reconciledAt: now,
      },
      updatedAt: now,
    };

    /**
     * REBUILD THE TIMELINE, NOT JUST THE STATUS.
     *
     * Reported: "its got delivered to the breet sandbox but i kept seeing
     * waiting for your asset till now". Confirmed on the test API - transfer
     * ngnt_4f2d3ec0 read status "blockchain_confirmed" while its timeline
     * still had awaiting_crypto_deposit marked `current`.
     *
     * The UI renders the TIMELINE, not the status field, so the user was told
     * the crypto had never arrived for something the backend already knew had
     * confirmed. This service wrote `status` and left `timeline` exactly as it
     * was when the order was created - the word "timeline" did not appear in
     * this file at all.
     *
     * Rebuilt from the updated record, so the two can no longer disagree.
     */
    updated.timeline = buildTimeline(updated);

    await db.upsertNgnTransferRecord(updated);
    outcome.advanced.push({
      transferId: transfer.id,
      from: transfer.status,
      to: next,
      provider: controls.activeProvider,
    });

    await createAuditLog({
      actorType: options.actorId ? 'admin' : 'system',
      actorId: options.actorId ?? 'ngn_settlement_reconciler',
      action: 'ngn.transfer_reconciled',
      resourceType: 'payments_ngn_transfer',
      resourceId: transfer.id,
      severity: 'info',
      metadata: {
        from: transfer.status,
        to: next,
        tradeId: settlement.tradeId,
        withdrawalId: settlement.withdrawalId,
      },
    });
  }

  return outcome;
}
