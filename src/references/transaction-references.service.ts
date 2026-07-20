import { db } from '../database/json-database.js';
import type { TransactionReferenceRecord } from '../database/types.js';
import { id, nowIso } from '../shared/id.js';

export type ReferenceDirection = TransactionReferenceRecord['direction'];

export async function upsertTransactionReference(input: Omit<TransactionReferenceRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string; createdAt?: string }) {
  if (!input.referenceValue) return null;
  const now = nowIso();
  const existing = (await db.listTransactionReferences()).find((item) => item.provider === input.provider && item.referenceType === input.referenceType && item.referenceValue === input.referenceValue && item.resourceType === input.resourceType && item.resourceId === input.resourceId);
  const record: TransactionReferenceRecord = {
    id: existing?.id ?? input.id ?? id('txref'),
    sivanTransactionId: input.sivanTransactionId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    provider: input.provider,
    referenceType: input.referenceType,
    referenceValue: String(input.referenceValue),
    direction: input.direction,
    status: input.status,
    metadata: input.metadata,
    createdAt: existing?.createdAt ?? input.createdAt ?? now,
    updatedAt: now,
  };
  await db.upsertTransactionReferenceRecord(record);
  return record;
}

export async function getTransactionTrace(resourceType: string, resourceId: string) {
  const refs = await db.listTransactionReferences();
  return refs
    .filter((item) => item.resourceType === resourceType && item.resourceId === resourceId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function searchTransactionReferences(query: string, limit = 50) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const refs = await db.listTransactionReferences();
  return refs
    .filter((item) => [item.sivanTransactionId, item.resourceId, item.provider, item.referenceType, item.referenceValue, item.status].some((value) => String(value ?? '').toLowerCase().includes(q)))
    .slice(0, limit);
}

export async function syncPaymentTransactionReferencesForResource(resourceType: 'withdrawal' | 'onramp_order' | 'virtual_account_transaction', resource: any) {
  const sivanTransactionId = resource.id;
  const base = { sivanTransactionId, resourceType, resourceId: resource.id };
  await upsertTransactionReference({ ...base, provider: 'sivan', referenceType: 'sivan_transaction_id', referenceValue: resource.id, direction: 'internal', status: resource.status });

  if (resourceType === 'withdrawal') {
    await upsertTransactionReference({ ...base, provider: resource.provider ?? 'bridge', referenceType: 'bridge_drain_id', referenceValue: resource.providerDrainId, direction: 'outbound', status: resource.status });
    await upsertTransactionReference({ ...base, provider: 'bridge', referenceType: 'liquidation_address_id', referenceValue: resource.liquidationAddressId, direction: 'provider', status: resource.status });
    await upsertTransactionReference({ ...base, provider: 'bank', referenceType: 'destination_reference', referenceValue: resource.destinationReference, direction: 'outbound', status: resource.status });
    await upsertTransactionReference({ ...base, provider: 'bank', referenceType: 'destination_tx_hash', referenceValue: resource.destinationTxHash, direction: 'outbound', status: resource.status });
    await upsertTransactionReference({ ...base, provider: 'crypto', referenceType: 'source_deposit_tx_hash', referenceValue: resource.depositTxHash, direction: 'inbound', status: resource.status });
  }

  if (resourceType === 'onramp_order') {
    await upsertTransactionReference({ ...base, provider: resource.provider ?? 'bridge', referenceType: 'provider_transfer_id', referenceValue: resource.providerTransferId, direction: 'inbound', status: resource.status });
    await upsertTransactionReference({ ...base, provider: resource.provider ?? 'bridge', referenceType: 'provider_reference', referenceValue: resource.providerReference, direction: 'inbound', status: resource.status });
    await upsertTransactionReference({ ...base, provider: 'crypto', referenceType: 'destination_tx_hash', referenceValue: resource.destinationTxHash, direction: 'outbound', status: resource.status });
  }

  if (resourceType === 'virtual_account_transaction') {
    await upsertTransactionReference({ ...base, provider: resource.provider ?? 'bridge', referenceType: 'deposit_id', referenceValue: resource.depositId, direction: 'inbound', status: resource.status });
    await upsertTransactionReference({ ...base, provider: resource.provider ?? 'bridge', referenceType: 'provider_account_id', referenceValue: resource.providerAccountId, direction: 'provider', status: resource.status });
    await upsertTransactionReference({ ...base, provider: 'bank', referenceType: 'deposit_reference', referenceValue: resource.depositReference, direction: 'inbound', status: resource.status });
    await upsertTransactionReference({ ...base, provider: 'crypto', referenceType: 'destination_tx_hash', referenceValue: resource.destinationTxHash, direction: 'outbound', status: resource.status });
  }
}
