import { z } from 'zod';
import { db } from '../../database/json-database.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { id, nowIso } from '../../shared/id.js';
import { createAuditLog } from '../../audit/audit.service.js';
import { getNgnProvider } from '../provider/ngn-provider-registry.js';
import { getNgnQuote, markQuoteAccepted } from './ngn-quotes.service.js';
import type { NgnTimelineStep, NgnTransferRecord } from '../types/ngn.types.js';

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
  return transfer;
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
