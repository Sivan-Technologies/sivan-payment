import { z } from 'zod';
import { db } from '../../database/json-database.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { id, nowIso } from '../../shared/id.js';
import { createAuditLog } from '../../audit/audit.service.js';
import { getNgnProvider } from '../provider/ngn-provider-registry.js';
import { getNgnQuote, markQuoteAccepted } from './ngn-quotes.service.js';
import type { NgnTimelineStep, NgnTransferRecord } from '../types/ngn.types.js';
import { getSpendable } from '../../balances/unified-balance.service.js';
import { getWalletProvider } from '../../wallets/provider/provider-registry.js';
import { resolveActiveWalletProvider } from '../../wallets/wallet-controls.service.js';

export const acceptNgnQuoteSchema = z.object({ userId: z.string().min(1), quoteId: z.string().min(1) });

function buildTimeline(transfer: NgnTransferRecord): NgnTimelineStep[] {
  const onramp = transfer.direction === 'onramp';
  const keys = onramp
    ? [
      ['quote_accepted', 'Quote accepted', 'The NGN quote has been accepted.'],
      ['awaiting_deposit', 'Waiting for NGN deposit', 'Transfer the exact NGN amount with the provider reference.'],
      ['deposit_received', 'Deposit confirmed', 'The NGN deposit has been detected.'],
      ['processing', 'Provider processing', 'The provider is preparing crypto delivery.'],
      ['crypto_sent', 'USDC/USDT sent', 'Crypto delivery has been submitted.'],
      ['completed', 'Completed', 'The NGN on-ramp is complete.']
    ]
    : [
      ['awaiting_crypto_deposit', 'Waiting for crypto deposit', 'Send supported USDC/USDT to the generated address.'],
      ['blockchain_confirmed', 'Blockchain confirmed', 'The crypto deposit has been confirmed.'],
      ['quote_accepted', 'Quote accepted', 'The NGN payout quote has been accepted.'],
      ['settlement_processing', 'Settlement processing', 'The provider is settling NGN.'],
      ['bank_processing', 'Bank transfer', 'The bank payout is processing.'],
      ['completed', 'Completed', 'The NGN off-ramp is complete.']
    ];
  const order = keys.map(([key]) => key);
  const currentIndex = Math.max(0, order.indexOf(transfer.status));
  return keys.map(([key, label, description], index) => ({ key, label, description, status: transfer.status === 'failed' || transfer.status === 'requires_review' ? (index <= currentIndex ? 'failed' : 'pending') : index < currentIndex ? 'completed' : index === currentIndex ? 'current' : 'pending', at: index <= currentIndex ? transfer.updatedAt : undefined } as NgnTimelineStep));
}

export async function acceptNgnQuote(input: z.infer<typeof acceptNgnQuoteSchema>) {
  const quote = await getNgnQuote(input.quoteId);
  if (quote.userId !== input.userId) throw notFound('NGN quote');
  if (quote.status !== 'quote_created') throw badRequest('NGN quote is not available to accept.');
  if (quote.expiresAt <= nowIso()) throw badRequest('NGN quote has expired. Request a new quote.');
  /**
   * AN ON-RAMP NEEDS SOMEWHERE TO SEND THE CRYPTO.
   *
   * The Breet provider refuses without metadata.recipientAddress, and before
   * this it did so with a provider-shaped message after the quote had already
   * been marked accepted - leaving a consumed quote and a 403 the user could
   * do nothing with. Checked here, BEFORE acceptance, so the quote survives
   * and the user is told the one thing that will fix it.
   */
  if (quote.direction === 'onramp' && !(quote.metadata as any)?.recipientAddress) {
    throw badRequest(
      'Create your wallet before buying crypto, so we have somewhere to send it.'
    );
  }

  const accepted = await markQuoteAccepted(quote);
  const provider = getNgnProvider(accepted.provider);
  const partial: Partial<NgnTransferRecord> = accepted.direction === 'onramp' ? await provider.createOnrampTransfer(accepted) : await provider.createOfframpTransfer(accepted);
  const now = nowIso();
  const transfer: NgnTransferRecord = { id: id('ngnt'), quoteId: accepted.id, userId: accepted.userId, customerId: accepted.customerId, direction: accepted.direction, provider: accepted.provider, sourceCurrency: accepted.sourceCurrency, destinationCurrency: accepted.destinationCurrency, sourceAmount: accepted.sourceAmount, destinationAmount: accepted.destinationAmount, rate: accepted.rate, feeAmount: accepted.feeAmount, providerQuoteId: accepted.providerQuoteId, status: partial.status ?? 'created', providerTransferId: partial.providerTransferId, bankReference: partial.bankReference, depositAddress: partial.depositAddress, virtualAccount: partial.virtualAccount, settlementReference: partial.settlementReference, destinationTxHash: partial.destinationTxHash, metadata: { quoteMetadata: accepted.metadata, transferMetadata: partial.metadata }, createdAt: now, updatedAt: now };
  transfer.timeline = buildTimeline(transfer);
  await db.upsertNgnTransferRecord(transfer);
  await createAuditLog({ actorType: 'user', actorId: input.userId, action: 'ngn.transfer_created', resourceType: 'payments_ngn_transfer', resourceId: transfer.id, metadata: { quoteId: accepted.id, direction: transfer.direction, provider: transfer.provider } });

  /**
   * SWEEP THE CRYPTO TO THE RAIL, INSTEAD OF ASKING THE USER TO DO IT.
   *
   * An off-ramp gets a depositAddress back from Breet and, before this,
   * stopped there. The user was expected to open a wallet app and send crypto
   * to that address themselves - even though the funds are in a Sivan-managed
   * Privy wallet that Sivan can already sign for, with gas sponsored.
   *
   * That is the gap the user described: "when a user wants to offramp the
   * system should pick up the amount from the Privy wallet and send it to the
   * rail provider and settle it". Correct, and now it does.
   *
   * DELIBERATELY NON-FATAL. The order is already created and the deposit
   * address is already valid, so a sweep failure must not destroy it - the
   * manual route still works and the reconciler still watches the address.
   * Throwing here would lose a real order over a recoverable RPC error.
   */
  /**
   * AND IT MUST NOT BLOCK THE RESPONSE.
   *
   * Reported from the console, with a screenshot of the Review screen:
   *
   *     POST /api/ngn/offramp/orders 503 (Service Unavailable)
   *     "The payments-api service did not respond. This was a POST request and
   *      it was NOT retried, because repeating it could duplicate the action."
   *
   * That toast is the Cloudflare worker giving up at UPSTREAM_TIMEOUT_MS =
   * 12000. It is not the API refusing - the order had already been created.
   * The user saw a failure for something that had in fact happened, which is
   * the worst possible outcome on a money screen: retry and you may double it,
   * do nothing and you cannot tell.
   *
   * WHY IT TOOK >12s. Awaiting the sweep put an ON-CHAIN TRANSFER inside an
   * HTTP request. The chain is sequential and unbounded:
   *
   *     findUserWalletForNetwork   db
   *     getSpendable               reads EVERY wallet on EVERY network it
   *                                serves - for one EVM wallet that is an
   *                                ethereum read AND a base read, plus solana
   *     createTransfer             Privy signs and broadcasts
   *
   * Each hop is fast alone - measured Privy 0.21s, Solana 0.12s, Base 0.14s -
   * but they are serial, and any one of them stalling (a cold Render dyno, a
   * rate-limited public RPC) spends the entire 12s budget. The request cannot
   * be made reliably fast, because it is waiting on a blockchain.
   *
   * So the sweep no longer runs inside the request. It is scheduled, and the
   * response returns as soon as the ORDER exists - which is the only thing the
   * user is waiting to hear.
   *
   * THIS IS SAFE PRECISELY BECAUSE THE SWEEP WAS ALREADY DESIGNED TO FAIL:
   *   - it was already non-fatal, so nothing downstream assumed it completed
   *   - createTransfer is keyed `ngnsweep_${transfer.id}`, so a retry cannot
   *     sweep twice
   *   - ngn-settlement-reconciler already polls and only ever moves a transfer
   *     FORWARD, so it converges whether or not this attempt lands
   *
   * The deposit address is valid either way, so the manual route still works
   * for anyone who would rather send the crypto themselves.
   */
  if (transfer.direction === 'offramp' && transfer.depositAddress) {
    scheduleSweep(transfer);
  }

  return transfer;
}

/**
 * Run the sweep after the response has been sent.
 *
 * setImmediate rather than a floating promise: the handler returns first, and
 * the sweep starts on the next tick with nothing awaiting it. Errors are
 * captured here rather than escaping - an unhandled rejection in Node 15+
 * terminates the process, and losing the API over a slow RPC would be a far
 * worse bug than the one being fixed.
 *
 * Deliberately NOT a queue. A queue is the right answer at volume, but it is
 * infrastructure this deployment does not have, and the reconciler already
 * provides the durability a queue would: if this in-process attempt is lost to
 * a restart, the next reconciler pass still settles the transfer. Adding a
 * queue here would be a bigger change with no additional guarantee today.
 */
function scheduleSweep(transfer: NgnTransferRecord): void {
  setImmediate(() => {
    void (async () => {
      try {
        const swept = await sweepToRail(transfer);
        if (swept) {
          // Re-read before writing. The reconciler or a webhook may have moved
          // this transfer while the sweep was in flight, and blindly writing a
          // stale in-memory copy would roll that progress back.
          const current = (await db.listNgnTransfers())
            .find((row) => row.id === transfer.id) ?? transfer;

          current.status = 'settlement_processing';
          current.metadata = { ...(current.metadata as Record<string, unknown>), sweep: swept };
          current.timeline = buildTimeline(current);
          current.updatedAt = nowIso();
          await db.upsertNgnTransferRecord(current);
        }
      } catch (error) {
        await createAuditLog({
          actorType: 'system', actorId: 'ngn_sweep', action: 'ngn.sweep_failed',
          resourceType: 'payments_ngn_transfer', resourceId: transfer.id, severity: 'error',
          metadata: { depositAddress: transfer.depositAddress, reason: error instanceof Error ? error.message : String(error) },
        }).catch(() => { /* the audit write is the last thing that may fail; never rethrow from a detached task */ });
      }
    })();
  });
}

/**
 * WHY A SKIPPED SWEEP IS WORTH A LOG.
 *
 * Every bail-out below used to be a bare `return undefined`. That is correct
 * behaviour - a user who intends to send crypto manually is not an error - but
 * it made two completely different situations identical from the outside:
 *
 *   "this user has no balance and does not know they must now deposit"
 *   "this user always meant to pay from their own wallet"
 *
 * Both produced silence and an order sitting in `awaiting_crypto_deposit`. The
 * `orders_awaiting_deposit` pile-up on api-test was the first kind, and it was
 * only found by reading the database, because nothing anywhere said so.
 *
 * Deliberately `info`, not `error`. A skipped sweep is a normal outcome; it is
 * the INVISIBILITY that was the defect, not the skip.
 */
async function recordSweepSkipped(
  transfer: NgnTransferRecord,
  reason: 'no_network' | 'no_wallet_for_network' | 'insufficient_spendable',
  detail: Record<string, unknown> = {}
): Promise<undefined> {
  await createAuditLog({
    actorType: 'system',
    actorId: 'ngn_sweep',
    action: 'ngn.sweep_skipped',
    resourceType: 'payments_ngn_transfer',
    resourceId: transfer.id,
    severity: 'info',
    metadata: { reason, depositAddress: transfer.depositAddress, ...detail },
  });
  return undefined;
}

/**
 * Send the off-ramp amount from the user's own wallet to the rail's deposit
 * address.
 *
 * Returns undefined - not an error - when there is nothing to sweep from. A
 * user who funded a personal wallet elsewhere and intends to send manually is
 * a legitimate case, not a failure. Each such exit is recorded so that case can
 * be told apart from a user who is simply stuck.
 */
async function sweepToRail(transfer: NgnTransferRecord): Promise<Record<string, unknown> | undefined> {
  const network = String((transfer.metadata as any)?.quoteMetadata?.network ?? '').toLowerCase();
  if (!network) return recordSweepSkipped(transfer, 'no_network');

  /**
   * Same wallet-selection rule as everywhere else - but asked by FAMILY.
   *
   * This used `findUserWallet(userId, network === 'solana' ? 'solana' : 'ethereum')`,
   * an exact chain-string match. Every wallet provisioned in this deployment
   * is filed as chain:'base', so a Base off-ramp found no row and returned
   * undefined here - which this function treats as "nothing to sweep, that is
   * fine". The user's off-ramp then sat waiting for a crypto deposit that
   * Sivan was supposed to make on their behalf and silently did not. That is
   * exactly the `orders_awaiting_deposit` pile-up on api-test.
   *
   * The earlier manual sweep proof passed because that particular wallet
   * happened to be filed as 'ethereum'. Provisioning order decided whether a
   * user's off-ramp worked.
   */
  const wallet = await db.findUserWalletForNetwork(transfer.userId, network);
  if (!wallet) return recordSweepSkipped(transfer, 'no_wallet_for_network', { network });

  const asset = String(transfer.sourceCurrency ?? 'usdc').toLowerCase();
  /**
   * Never sweep more than the wallet holds. Privy signs what it is told to
   * sign; an over-sized transfer reverts on chain AFTER we have told the user
   * their off-ramp is under way.
   */
  const spendable = await getSpendable(transfer.userId, asset);
  const amount = Number(transfer.sourceAmount ?? 0);
  if (spendable === null || spendable < amount || amount <= 0) {
    /**
     * The shortfall is the number a human actually needs, so it is computed
     * here rather than left to be re-derived from two other fields later. A
     * null `spendable` means the balance could not be READ, which is not the
     * same as a balance of zero and must not be reported as one.
     */
    return recordSweepSkipped(transfer, 'insufficient_spendable', {
      asset,
      network,
      requiredAmount: amount,
      spendable,
      shortfall: spendable === null ? null : Math.max(0, amount - spendable),
      balanceUnreadable: spendable === null,
    });
  }

  const provider = getWalletProvider(await resolveActiveWalletProvider());
  const result = await provider.createTransfer({
    providerWalletId: wallet.providerWalletId,
    providerCustomerId: wallet.customerId,
    asset: asset as any,
    chain: network as any,
    amount: String(transfer.sourceAmount),
    toAddress: transfer.depositAddress!,
    // Keyed on the transfer, so a retry cannot sweep twice.
    idempotencyKey: `ngnsweep_${transfer.id}`,
    reference: transfer.id,
  });

  await createAuditLog({
    actorType: 'system', actorId: 'ngn_sweep', action: 'ngn.sweep_submitted',
    resourceType: 'payments_ngn_transfer', resourceId: transfer.id, severity: 'info',
    metadata: { depositAddress: transfer.depositAddress, amount: transfer.sourceAmount, asset, network, providerTransferId: result.providerTransferId, sponsored: result.sponsored },
  });

  return {
    providerTransferId: result.providerTransferId,
    txHash: result.txHash,
    userOperationHash: result.userOperationHash,
    sponsored: result.sponsored,
    sweptAt: nowIso(),
  };
}

/**
 * How long an unfunded off-ramp stays open. MUST match the reconciler's
 * NGN_UNFUNDED_EXPIRY_HOURS - two different numbers here would show a user a
 * countdown that disagrees with when their order actually closes, which is
 * worse than showing none.
 */
export const NGN_UNFUNDED_EXPIRY_HOURS = Number(process.env.NGN_UNFUNDED_EXPIRY_HOURS || 24);

/** Statuses where the user still owes us crypto and may still cancel. */
export const NGN_CANCELLABLE_STATUSES = new Set([
  'created', 'quote_created', 'quote_accepted', 'awaiting_deposit', 'awaiting_crypto_deposit',
]);

/**
 * THE NETWORK AND THE DEADLINE, LIFTED OUT OF METADATA.
 *
 * Reported with a screenshot: a sell showing a deposit address and no
 * indication of which chain it belongs to. The address in question -
 * AVXsBHMhRtc5LqoLTvaQBX7oUayS4f3h1TrATUX1v7Df - is base58, so it is Solana,
 * but a user cannot be expected to identify a chain by an address format. Send
 * USDC on the wrong chain to a Breet deposit address and it is gone; there is
 * no recall on chain and Breet is not watching that network for that address.
 *
 * The network was never missing from the DATA - quoteMetadata.network says
 * "solana" for that exact transfer. It was missing from every layer above it.
 * NgnTransferRecord has no `network` field, so nothing in the API or the UI
 * could reach it without knowing to dig through a nested metadata blob.
 *
 * Derived here rather than added as a stored column: the value already exists
 * on every record ever written, so a migration would only duplicate it and
 * create a second thing that can drift.
 */
function decorate(transfer: NgnTransferRecord) {
  const meta = (typeof transfer.metadata === 'object' && transfer.metadata ? transfer.metadata : {}) as any;
  const network = meta?.quoteMetadata?.network ? String(meta.quoteMetadata.network).toLowerCase() : undefined;

  const unfunded = NGN_CANCELLABLE_STATUSES.has(String(transfer.status)) && !transfer.destinationTxHash;
  // The reconciler measures from updatedAt, falling back to createdAt. Matched
  // exactly, or the countdown lies about the deadline it is describing.
  const started = Date.parse(transfer.updatedAt ?? transfer.createdAt ?? '');
  const expiresAt = unfunded && Number.isFinite(started)
    ? new Date(started + NGN_UNFUNDED_EXPIRY_HOURS * 3_600_000).toISOString()
    : undefined;

  return {
    ...transfer,
    /** Which chain the deposit address lives on. undefined when unknown. */
    network,
    /** When an unfunded order closes itself. Absent once funded or finished. */
    expiresAt,
    /** Whether the user may cancel right now, decided by the server. */
    cancellable: unfunded,
  };
}

export async function listNgnTransfers(options: { userId?: string; status?: string } = {}) {
  return (await db.listNgnTransfers())
    .filter((item) => (!options.userId || item.userId === options.userId) && (!options.status || item.status === options.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(decorate);
}

/**
 * Let a user close an off-ramp they have decided not to fund.
 *
 * There was NO way to do this. Grep found no cancel route, no service
 * function, nothing - an unfunded sell simply sat there until the 24h
 * reconciler swept it. Reported as "seems like a stale sell", which is exactly
 * right: the user had abandoned it hours earlier and the product still showed
 * it as live, with a deposit address inviting them to send funds into an order
 * they no longer wanted.
 *
 * REFUSES ONCE CRYPTO IS INVOLVED. A destinationTxHash means coins are on
 * chain and heading for the rail; "cancelling" that would tell the user
 * nothing is coming while their money is mid-flight. Those need support, not a
 * button.
 */
export async function cancelNgnTransfer(
  transferId: string,
  options: { userId?: string; actorId?: string; reason?: string } = {}
) {
  const transfer = (await db.listNgnTransfers()).find((item) => item.id === transferId);
  if (!transfer) throw notFound('NGN transfer');

  // Ownership is checked HERE as well as at the route. A cancel is a state
  // change on someone's money; one guard is not enough.
  if (options.userId && transfer.userId !== options.userId) throw notFound('NGN transfer');

  if (transfer.destinationTxHash) {
    throw badRequest('Your crypto is already on the way. This order can no longer be cancelled - contact support if something looks wrong.');
  }
  if (!NGN_CANCELLABLE_STATUSES.has(String(transfer.status))) {
    throw badRequest(`This order is ${String(transfer.status).replaceAll('_', ' ')} and can no longer be cancelled.`);
  }

  const now = nowIso();
  const cancelled: NgnTransferRecord = {
    ...transfer,
    status: 'cancelled',
    updatedAt: now,
    metadata: {
      ...(typeof transfer.metadata === 'object' && transfer.metadata ? transfer.metadata as Record<string, unknown> : {}),
      cancelledAt: now,
      cancelledBy: options.actorId || options.userId || 'user',
      cancelledReason: options.reason || 'Cancelled by the user before funding.',
      previousStatus: transfer.status,
    },
  };
  cancelled.timeline = buildTimeline(cancelled);
  await db.upsertNgnTransferRecord(cancelled);

  await createAuditLog({
    actorType: options.userId ? 'user' : 'admin',
    actorId: options.actorId || options.userId || 'user',
    action: 'ngn.transfer_cancelled',
    resourceType: 'payments_ngn_transfer',
    resourceId: transferId,
    severity: 'info',
    metadata: { previousStatus: transfer.status, reason: options.reason },
  });

  return decorate(cancelled);
}

export async function retryNgnTransfer(transferId: string, actorId = 'admin_api_key') {
  const transfer = (await db.listNgnTransfers()).find((item) => item.id === transferId);
  if (!transfer) throw notFound('NGN transfer');
  const now = nowIso();
  const retried: NgnTransferRecord = { ...transfer, status: transfer.direction === 'onramp' ? 'processing' : 'settlement_processing', updatedAt: now, metadata: { ...(typeof transfer.metadata === 'object' && transfer.metadata ? transfer.metadata as Record<string, unknown> : {}), retriedBy: actorId, retriedAt: now } };
  retried.timeline = buildTimeline(retried);
  await db.upsertNgnTransferRecord(retried);
  await createAuditLog({ actorType: 'admin', actorId, action: 'ngn.transfer_retry_requested', resourceType: 'payments_ngn_transfer', resourceId: transferId, severity: 'warning' });
  return retried;
}
