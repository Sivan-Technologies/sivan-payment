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
  if (transfer.direction === 'offramp' && transfer.depositAddress) {
    try {
      const swept = await sweepToRail(transfer);
      if (swept) {
        transfer.status = 'settlement_processing';
        transfer.metadata = { ...(transfer.metadata as Record<string, unknown>), sweep: swept };
        transfer.timeline = buildTimeline(transfer);
        await db.upsertNgnTransferRecord(transfer);
      }
    } catch (error) {
      await createAuditLog({
        actorType: 'system', actorId: 'ngn_sweep', action: 'ngn.sweep_failed',
        resourceType: 'payments_ngn_transfer', resourceId: transfer.id, severity: 'error',
        metadata: { depositAddress: transfer.depositAddress, reason: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  return transfer;
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

export async function listNgnTransfers(options: { userId?: string; status?: string } = {}) {
  return (await db.listNgnTransfers()).filter((item) => (!options.userId || item.userId === options.userId) && (!options.status || item.status === options.status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
