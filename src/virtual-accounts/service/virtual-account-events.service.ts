import { db } from '../../database/json-database.js';
import { id, nowIso } from '../../shared/id.js';
import type { BridgeWebhookPayload } from '../../webhooks/webhooks.service.js';
import { syncPaymentTransactionReferencesForResource, upsertTransactionReference } from '../../references/transaction-references.service.js';
import type { VirtualAccountEventRecord, VirtualAccountEventType, VirtualAccountTransactionRecord, VirtualAccountTransactionStatus, VirtualAccountCurrency } from '../types/virtual-account.types.js';

function normalizeEventType(value: unknown): VirtualAccountEventType {
  const normalized = String(value ?? '').trim().toLowerCase();
  const supported: VirtualAccountEventType[] = ['funds_received', 'funds_scheduled', 'payment_submitted', 'payment_processed', 'in_review', 'refund_in_flight', 'refunded', 'refund_failed', 'account_update', 'activation', 'deactivation', 'microdeposit'];
  return supported.includes(normalized as VirtualAccountEventType) ? normalized as VirtualAccountEventType : 'unknown';
}

function transactionStatus(eventType: VirtualAccountEventType): VirtualAccountTransactionStatus {
  if (eventType === 'payment_processed') return 'completed';
  if (eventType === 'payment_submitted') return 'submitted';
  if (eventType === 'funds_received') return 'funds_received';
  if (eventType === 'funds_scheduled') return 'scheduled';
  if (eventType === 'in_review') return 'in_review';
  if (eventType === 'refund_in_flight') return 'refund_in_flight';
  if (eventType === 'refunded') return 'refunded';
  if (eventType === 'refund_failed') return 'refund_failed';
  return 'failed';
}

function currency(value: unknown): VirtualAccountCurrency | undefined {
  const normalized = String(value ?? '').toLowerCase();
  return ['usd', 'gbp', 'eur', 'ngn'].includes(normalized) ? normalized as VirtualAccountCurrency : undefined;
}

function extractDepositReference(source: any) {
  return source?.trace_number ?? source?.imad ?? source?.reference ?? source?.uetr ?? source?.tracking_number ?? source?.description;
}

export function isVirtualAccountWebhook(payload: BridgeWebhookPayload) {
  const object = payload.event_object ?? {};
  const category = String(payload.event_category ?? '').toLowerCase();
  return Boolean(
    category.includes('virtual_account') ||
    object.virtual_account_id ||
    object.deposit_id ||
    ['funds_received', 'funds_scheduled', 'payment_submitted', 'payment_processed', 'in_review', 'refund_in_flight', 'refunded', 'refund_failed', 'microdeposit'].includes(String(object.type ?? payload.event_type ?? '').toLowerCase())
  );
}

export async function applyBridgeVirtualAccountEvent(payload: BridgeWebhookPayload) {
  const object = payload.event_object ?? {};
  const providerEventId = String(object.id ?? payload.event_object_id ?? payload.event_id ?? '');
  if (!providerEventId) return null;

  const providerAccountId = String(object.virtual_account_id ?? object.virtualAccountId ?? '');
  const depositId = object.deposit_id ? String(object.deposit_id) : undefined;
  const eventType = normalizeEventType(object.type ?? payload.event_type ?? payload.event_object_status);
  const source = object.source ?? {};
  const receipt = object.receipt ?? {};
  const now = nowIso();
  const accounts = await db.listVirtualAccounts();
  const account = accounts.find((item) => item.provider === 'bridge' && item.providerAccountId === providerAccountId);

  const eventRecord: VirtualAccountEventRecord = {
    id: id('vaevt'),
    provider: 'bridge',
    providerEventId,
    virtualAccountId: account?.id,
    providerAccountId: providerAccountId || undefined,
    depositId,
    eventType,
    sourceCurrency: currency(object.currency),
    destinationCurrency: object.destination?.currency ?? receipt.destination_currency,
    sourceAmount: object.subtotal_amount ?? receipt.initial_amount ?? (['funds_received', 'funds_scheduled', 'in_review'].includes(eventType) ? object.amount : undefined),
    destinationAmount: ['payment_submitted', 'payment_processed'].includes(eventType) ? object.amount ?? receipt.final_amount : undefined,
    paymentRail: source.payment_rail,
    status: ['account_update', 'activation', 'deactivation', 'microdeposit'].includes(eventType) ? eventType as any : transactionStatus(eventType),
    depositReference: extractDepositReference(source),
    destinationTxHash: object.destination_tx_hash ?? receipt.destination_tx_hash,
    rawPayload: object,
    createdAt: object.created_at ?? payload.event_created_at ?? now,
    updatedAt: now,
  };
  await db.upsertVirtualAccountEventRecord(eventRecord);
  await upsertTransactionReference({ sivanTransactionId: eventRecord.virtualAccountId ?? eventRecord.providerAccountId ?? providerEventId, resourceType: 'virtual_account_event', resourceId: eventRecord.id, provider: 'bridge', referenceType: 'provider_event_id', referenceValue: providerEventId, direction: 'provider', status: eventRecord.status });

  if (!depositId) return { event: eventRecord, transaction: null };

  const existing = (await db.listVirtualAccountTransactions()).find((item) => item.provider === 'bridge' && item.depositId === depositId);
  const status = transactionStatus(eventType);
  const transaction: VirtualAccountTransactionRecord = {
    id: existing?.id ?? id('vatx'),
    provider: 'bridge',
    virtualAccountId: account?.id ?? existing?.virtualAccountId,
    providerAccountId: providerAccountId || existing?.providerAccountId,
    depositId,
    userId: account?.userId ?? existing?.userId,
    customerId: account?.customerId ?? existing?.customerId,
    sourceCurrency: eventRecord.sourceCurrency ?? existing?.sourceCurrency,
    destinationCurrency: eventRecord.destinationCurrency ?? existing?.destinationCurrency,
    sourceAmount: eventRecord.sourceAmount ?? existing?.sourceAmount,
    destinationAmount: eventRecord.destinationAmount ?? existing?.destinationAmount,
    paymentRail: eventRecord.paymentRail ?? existing?.paymentRail,
    status,
    depositReference: eventRecord.depositReference ?? existing?.depositReference,
    destinationTxHash: eventRecord.destinationTxHash ?? existing?.destinationTxHash,
    lastProviderEventId: providerEventId,
    rawPayload: object,
    createdAt: existing?.createdAt ?? eventRecord.createdAt,
    updatedAt: now,
    completedAt: status === 'completed' ? now : existing?.completedAt,
  };
  await db.upsertVirtualAccountTransactionRecord(transaction);
  await syncPaymentTransactionReferencesForResource('virtual_account_transaction', transaction);
  return { event: eventRecord, transaction };
}
