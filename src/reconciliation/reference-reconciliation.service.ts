import { db } from '../database/json-database.js';
import type { DatabaseShape, ReconciliationFindingRecord, ReconciliationRunRecord, TransactionReferenceRecord } from '../database/types.js';
import { id, nowIso } from '../shared/id.js';

type FindingType = 'missing_reference' | 'duplicate_reference' | 'unmatched_webhook' | 'reference_mismatch';
type FindingSeverity = 'info' | 'warning' | 'error';

type ExpectedReference = {
  sivanTransactionId: string;
  resourceType: string;
  resourceId: string;
  provider: string;
  referenceType: string;
  referenceValue: string;
  direction: TransactionReferenceRecord['direction'];
  status?: string;
  required?: boolean;
  sourceField?: string;
};

export type ReferenceReconciliationFinding = {
  id: string;
  type: FindingType;
  severity: FindingSeverity;
  status: 'open' | 'resolved' | 'ignored';
  message: string;
  provider?: string;
  resourceType?: string;
  resourceId?: string;
  sivanTransactionId?: string;
  referenceId?: string;
  referenceType?: string;
  referenceValue?: string;
  webhookEventId?: string;
  expected?: unknown;
  actual?: unknown;
  createdAt: string;
};

export type ReferenceReconciliationDashboard = {
  generatedAt: string;
  summary: {
    totalFindings: number;
    openFindings: number;
    missingReferences: number;
    duplicateReferences: number;
    unmatchedWebhooks: number;
    referenceMismatches: number;
    errors: number;
    warnings: number;
    info: number;
    scannedResources: number;
    scannedReferences: number;
    scannedWebhooks: number;
  };
  byType: Record<FindingType, ReferenceReconciliationFinding[]>;
  findings: ReferenceReconciliationFinding[];
  latestPersistedRun?: ReconciliationRunRecord & { findings?: ReconciliationFindingRecord[] };
  recommendedActions: string[];
};

export async function buildReferenceReconciliationDashboard(options: { limit?: number } = {}): Promise<ReferenceReconciliationDashboard> {
  const data = await db.read();
  const generatedAt = nowIso();
  const limit = Math.max(1, Math.min(options.limit ?? 250, 1000));
  const refs = data.transactionReferences ?? [];
  const expected = buildExpectedReferences(data);
  const findings: ReferenceReconciliationFinding[] = [];

  findings.push(...findMissingReferences(expected, refs, generatedAt));
  findings.push(...findDuplicateReferences(refs, generatedAt));
  findings.push(...findReferenceMismatches(data, expected, refs, generatedAt));
  findings.push(...findUnmatchedWebhooks(data, refs, generatedAt));

  const ranked = findings
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.type.localeCompare(b.type) || (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, limit);

  const byType: ReferenceReconciliationDashboard['byType'] = {
    missing_reference: ranked.filter((item) => item.type === 'missing_reference'),
    duplicate_reference: ranked.filter((item) => item.type === 'duplicate_reference'),
    unmatched_webhook: ranked.filter((item) => item.type === 'unmatched_webhook'),
    reference_mismatch: ranked.filter((item) => item.type === 'reference_mismatch')
  };

  const runs = await db.listReconciliationRunsView({ limit: 5, offset: 0 }) as Array<ReconciliationRunRecord & { findings?: ReconciliationFindingRecord[] }>;
  const latestPersistedRun = runs.find((run) => (run.summary as any)?.scope === 'transaction_reference_findings');

  return {
    generatedAt,
    summary: {
      totalFindings: ranked.length,
      openFindings: ranked.filter((item) => item.status === 'open').length,
      missingReferences: byType.missing_reference.length,
      duplicateReferences: byType.duplicate_reference.length,
      unmatchedWebhooks: byType.unmatched_webhook.length,
      referenceMismatches: byType.reference_mismatch.length,
      errors: ranked.filter((item) => item.severity === 'error').length,
      warnings: ranked.filter((item) => item.severity === 'warning').length,
      info: ranked.filter((item) => item.severity === 'info').length,
      scannedResources: countScannedResources(data),
      scannedReferences: refs.length,
      scannedWebhooks: (data.webhookEvents ?? []).length + (data.unifiedWebhookLogs ?? []).length
    },
    byType,
    findings: ranked,
    latestPersistedRun,
    recommendedActions: buildRecommendedActions(byType)
  };
}

export async function persistReferenceReconciliationRun(options: { dryRun?: boolean; limit?: number } = {}) {
  const dryRun = options.dryRun ?? true;
  const startedAt = nowIso();
  const dashboard = await buildReferenceReconciliationDashboard({ limit: options.limit ?? 1000 });
  const completedAt = nowIso();
  const runRecord: ReconciliationRunRecord = {
    id: id('recon'),
    provider: 'reference-ledger',
    dryRun,
    status: dashboard.summary.errors > 0 ? 'failed' : 'completed',
    summary: {
      scope: 'transaction_reference_findings',
      dryRun,
      ...dashboard.summary
    },
    startedAt,
    completedAt
  };

  const findingRecords = dashboard.findings.map((finding): ReconciliationFindingRecord => ({
    id: id('reconf'),
    runId: runRecord.id,
    provider: finding.provider,
    severity: finding.severity,
    findingType: finding.type,
    withdrawalId: finding.resourceType === 'withdrawal' ? finding.resourceId : undefined,
    liquidationAddressId: finding.referenceType === 'liquidation_address_id' ? finding.referenceValue : undefined,
    providerDrainId: finding.referenceType === 'bridge_drain_id' ? finding.referenceValue : undefined,
    resourceType: finding.resourceType,
    resourceId: finding.resourceId,
    referenceId: finding.referenceId,
    webhookEventId: finding.webhookEventId,
    sivanTransactionId: finding.sivanTransactionId,
    message: finding.message,
    expected: finding.expected,
    actual: finding.actual,
    status: finding.status,
    createdAt: completedAt
  }));

  await db.insertReconciliationRecords(runRecord, findingRecords);
  return { ...dashboard, runId: runRecord.id, dryRun, startedAt, completedAt };
}

function buildExpectedReferences(data: DatabaseShape): ExpectedReference[] {
  const refs: ExpectedReference[] = [];
  const add = (item: Omit<ExpectedReference, 'referenceValue'> & { referenceValue?: unknown }) => {
    const value = normalizeReferenceValue(item.referenceValue);
    if (!value) return;
    refs.push({ ...item, referenceValue: value });
  };

  for (const withdrawal of data.withdrawals ?? []) {
    const base = { sivanTransactionId: withdrawal.id, resourceType: 'withdrawal', resourceId: withdrawal.id, status: withdrawal.status };
    add({ ...base, provider: 'sivan', referenceType: 'sivan_transaction_id', referenceValue: withdrawal.id, direction: 'internal', required: true, sourceField: 'id' });
    add({ ...base, provider: withdrawal.provider ?? 'bridge', referenceType: 'bridge_drain_id', referenceValue: withdrawal.providerDrainId, direction: 'outbound', sourceField: 'providerDrainId' });
    add({ ...base, provider: 'bridge', referenceType: 'liquidation_address_id', referenceValue: withdrawal.liquidationAddressId, direction: 'provider', sourceField: 'liquidationAddressId' });
    add({ ...base, provider: 'bank', referenceType: 'destination_reference', referenceValue: withdrawal.destinationReference, direction: 'outbound', sourceField: 'destinationReference' });
    add({ ...base, provider: 'bank', referenceType: 'destination_tx_hash', referenceValue: withdrawal.destinationTxHash, direction: 'outbound', sourceField: 'destinationTxHash' });
    add({ ...base, provider: 'crypto', referenceType: 'source_deposit_tx_hash', referenceValue: withdrawal.depositTxHash, direction: 'inbound', sourceField: 'depositTxHash' });
  }

  for (const order of data.onrampOrders ?? []) {
    const base = { sivanTransactionId: order.id, resourceType: 'onramp_order', resourceId: order.id, status: order.status };
    add({ ...base, provider: 'sivan', referenceType: 'sivan_transaction_id', referenceValue: order.id, direction: 'internal', required: true, sourceField: 'id' });
    add({ ...base, provider: order.provider ?? 'bridge', referenceType: 'provider_transfer_id', referenceValue: order.providerTransferId, direction: 'inbound', sourceField: 'providerTransferId' });
    add({ ...base, provider: order.provider ?? 'bridge', referenceType: 'provider_reference', referenceValue: order.providerReference, direction: 'inbound', sourceField: 'providerReference' });
    add({ ...base, provider: 'crypto', referenceType: 'destination_tx_hash', referenceValue: order.destinationTxHash, direction: 'outbound', sourceField: 'destinationTxHash' });
  }

  for (const account of data.virtualAccounts ?? []) {
    const base = { sivanTransactionId: account.id, resourceType: 'virtual_account', resourceId: account.id, status: account.status };
    add({ ...base, provider: 'sivan', referenceType: 'sivan_virtual_account_id', referenceValue: account.id, direction: 'internal', required: true, sourceField: 'id' });
    add({ ...base, provider: account.provider ?? 'bridge', referenceType: 'provider_account_id', referenceValue: account.providerAccountId, direction: 'provider', sourceField: 'providerAccountId' });
  }

  for (const event of data.virtualAccountEvents ?? []) {
    const base = { sivanTransactionId: event.virtualAccountId ?? event.providerAccountId ?? event.providerEventId, resourceType: 'virtual_account_event', resourceId: event.id, status: event.status };
    add({ ...base, provider: event.provider ?? 'bridge', referenceType: 'provider_event_id', referenceValue: event.providerEventId, direction: 'provider', required: true, sourceField: 'providerEventId' });
    add({ ...base, provider: event.provider ?? 'bridge', referenceType: 'deposit_id', referenceValue: event.depositId, direction: 'inbound', sourceField: 'depositId' });
    add({ ...base, provider: event.provider ?? 'bridge', referenceType: 'provider_account_id', referenceValue: event.providerAccountId, direction: 'provider', sourceField: 'providerAccountId' });
    add({ ...base, provider: 'bank', referenceType: 'deposit_reference', referenceValue: event.depositReference, direction: 'inbound', sourceField: 'depositReference' });
    add({ ...base, provider: 'crypto', referenceType: 'destination_tx_hash', referenceValue: event.destinationTxHash, direction: 'outbound', sourceField: 'destinationTxHash' });
  }

  for (const transaction of data.virtualAccountTransactions ?? []) {
    const base = { sivanTransactionId: transaction.id, resourceType: 'virtual_account_transaction', resourceId: transaction.id, status: transaction.status };
    add({ ...base, provider: 'sivan', referenceType: 'sivan_transaction_id', referenceValue: transaction.id, direction: 'internal', required: true, sourceField: 'id' });
    add({ ...base, provider: transaction.provider ?? 'bridge', referenceType: 'deposit_id', referenceValue: transaction.depositId, direction: 'inbound', required: true, sourceField: 'depositId' });
    add({ ...base, provider: transaction.provider ?? 'bridge', referenceType: 'provider_account_id', referenceValue: transaction.providerAccountId, direction: 'provider', sourceField: 'providerAccountId' });
    add({ ...base, provider: 'bank', referenceType: 'deposit_reference', referenceValue: transaction.depositReference, direction: 'inbound', sourceField: 'depositReference' });
    add({ ...base, provider: 'crypto', referenceType: 'destination_tx_hash', referenceValue: transaction.destinationTxHash, direction: 'outbound', sourceField: 'destinationTxHash' });
    add({ ...base, provider: transaction.provider ?? 'bridge', referenceType: 'provider_event_id', referenceValue: transaction.lastProviderEventId, direction: 'provider', sourceField: 'lastProviderEventId' });
  }

  return refs;
}

function findMissingReferences(expected: ExpectedReference[], refs: TransactionReferenceRecord[], createdAt: string): ReferenceReconciliationFinding[] {
  return expected
    .filter((item) => !refs.some((ref) => sameReference(ref, item)))
    .map((item) => ({
      id: fingerprint('missing', item.resourceType, item.resourceId, item.provider, item.referenceType, item.referenceValue),
      type: 'missing_reference' as const,
      severity: item.required ? 'error' as const : 'warning' as const,
      status: 'open' as const,
      provider: item.provider,
      resourceType: item.resourceType,
      resourceId: item.resourceId,
      sivanTransactionId: item.sivanTransactionId,
      referenceType: item.referenceType,
      referenceValue: item.referenceValue,
      message: `${item.resourceType} ${item.resourceId} has ${item.sourceField ?? item.referenceType}=${item.referenceValue}, but transaction_references has no matching ${item.provider}/${item.referenceType} row.`,
      expected: item,
      actual: null,
      createdAt
    }));
}

function findDuplicateReferences(refs: TransactionReferenceRecord[], createdAt: string): ReferenceReconciliationFinding[] {
  const groups = new Map<string, TransactionReferenceRecord[]>();
  for (const ref of refs) {
    const value = normalizeReferenceValue(ref.referenceValue);
    if (!value) continue;
    const key = `${ref.provider.toLowerCase()}|${ref.referenceType.toLowerCase()}|${value.toLowerCase()}`;
    const items = groups.get(key) ?? [];
    items.push(ref);
    groups.set(key, items);
  }

  const findings: ReferenceReconciliationFinding[] = [];
  for (const items of groups.values()) {
    const resourceKeys = new Set(items.map((item) => `${item.resourceType}:${item.resourceId}`));
    if (resourceKeys.size <= 1) continue;
    const first = items[0];
    findings.push({
      id: fingerprint('duplicate', first.provider, first.referenceType, first.referenceValue),
      type: 'duplicate_reference',
      severity: 'error',
      status: 'open',
      provider: first.provider,
      resourceType: first.resourceType,
      resourceId: first.resourceId,
      sivanTransactionId: first.sivanTransactionId,
      referenceId: first.id,
      referenceType: first.referenceType,
      referenceValue: first.referenceValue,
      message: `${first.provider}/${first.referenceType} reference ${first.referenceValue} is attached to ${resourceKeys.size} different resources.`,
      expected: { uniqueOwner: true },
      actual: { resources: Array.from(resourceKeys), references: items.map((item) => ({ id: item.id, resourceType: item.resourceType, resourceId: item.resourceId, sivanTransactionId: item.sivanTransactionId })) },
      createdAt
    });
  }
  return findings;
}

function findReferenceMismatches(data: DatabaseShape, expected: ExpectedReference[], refs: TransactionReferenceRecord[], createdAt: string): ReferenceReconciliationFinding[] {
  const expectedByResourceType = new Map<string, ExpectedReference[]>();
  for (const item of expected) {
    const key = `${item.resourceType}:${item.resourceId}:${item.provider}:${item.referenceType}`.toLowerCase();
    const items = expectedByResourceType.get(key) ?? [];
    items.push(item);
    expectedByResourceType.set(key, items);
  }

  const findings: ReferenceReconciliationFinding[] = [];
  for (const ref of refs) {
    const resourceExists = hasResource(data, ref.resourceType, ref.resourceId);
    if (!resourceExists) {
      findings.push({
        id: fingerprint('missing-resource', ref.id),
        type: 'reference_mismatch',
        severity: 'error',
        status: 'open',
        provider: ref.provider,
        resourceType: ref.resourceType,
        resourceId: ref.resourceId,
        sivanTransactionId: ref.sivanTransactionId,
        referenceId: ref.id,
        referenceType: ref.referenceType,
        referenceValue: ref.referenceValue,
        message: `Reference ${ref.id} points to missing resource ${ref.resourceType}:${ref.resourceId}.`,
        expected: { resourceExists: true },
        actual: { resourceExists: false, reference: ref },
        createdAt
      });
      continue;
    }

    const key = `${ref.resourceType}:${ref.resourceId}:${ref.provider}:${ref.referenceType}`.toLowerCase();
    const candidates = expectedByResourceType.get(key);
    if (!candidates?.length) continue;
    const matchesValue = candidates.some((item) => normalizeReferenceValue(item.referenceValue).toLowerCase() === normalizeReferenceValue(ref.referenceValue).toLowerCase());
    if (matchesValue) continue;
    findings.push({
      id: fingerprint('mismatch', ref.id, ref.referenceValue),
      type: 'reference_mismatch',
      severity: 'warning',
      status: 'open',
      provider: ref.provider,
      resourceType: ref.resourceType,
      resourceId: ref.resourceId,
      sivanTransactionId: ref.sivanTransactionId,
      referenceId: ref.id,
      referenceType: ref.referenceType,
      referenceValue: ref.referenceValue,
      message: `Reference ${ref.id} has ${ref.referenceValue}, but ${ref.resourceType}:${ref.resourceId} currently expects ${candidates.map((item) => item.referenceValue).join(', ')} for ${ref.provider}/${ref.referenceType}.`,
      expected: candidates,
      actual: ref,
      createdAt
    });
  }
  return findings;
}

function findUnmatchedWebhooks(data: DatabaseShape, refs: TransactionReferenceRecord[], createdAt: string): ReferenceReconciliationFinding[] {
  const values = buildKnownReferenceValueSet(data, refs);
  const findings: ReferenceReconciliationFinding[] = [];
  const seenProviderEvents = new Set<string>();

  for (const event of data.webhookEvents ?? []) {
    const providerEventKey = `${event.provider}:${event.providerEventId}`.toLowerCase();
    seenProviderEvents.add(providerEventKey);
    if (!isTransactionalWebhook(event.eventCategory, event.eventType, event.payload)) continue;
    const candidates = webhookCandidateValues(event);
    const matched = candidates.some((candidate) => values.has(candidate.toLowerCase()));
    if (matched) continue;
    findings.push({
      id: fingerprint('unmatched-webhook', event.provider, event.providerEventId),
      type: 'unmatched_webhook',
      severity: event.processedAt ? 'warning' : 'error',
      status: 'open',
      provider: event.provider,
      webhookEventId: event.id,
      referenceValue: event.eventObjectId ?? event.providerEventId,
      referenceType: event.eventCategory ?? event.eventType ?? 'webhook_event',
      message: `${event.provider} webhook ${event.providerEventId} (${event.eventCategory ?? event.eventType ?? 'unknown'}) has no matching Sivan transaction/reference.`,
      expected: { anyKnownReference: candidates },
      actual: { webhook: event },
      createdAt
    });
  }

  for (const log of data.unifiedWebhookLogs ?? []) {
    if (!log.providerEventId) continue;
    const providerEventKey = `${log.provider}:${log.providerEventId}`.toLowerCase();
    if (seenProviderEvents.has(providerEventKey)) continue;
    if (!isTransactionalWebhook(log.eventCategory, log.eventType, log.payload)) continue;
    const candidates = unifiedWebhookCandidateValues(log);
    const matched = candidates.some((candidate) => values.has(candidate.toLowerCase()));
    if (matched) continue;
    findings.push({
      id: fingerprint('unmatched-unified-webhook', log.provider, log.providerEventId),
      type: 'unmatched_webhook',
      severity: 'warning',
      status: 'open',
      provider: log.provider,
      webhookEventId: log.id,
      referenceValue: log.paymentReference ?? log.providerEventId,
      referenceType: log.eventCategory ?? log.eventType ?? 'unified_webhook_event',
      message: `Unified webhook log ${log.providerEventId} has no matching Sivan transaction/reference.`,
      expected: { anyKnownReference: candidates },
      actual: { webhook: log },
      createdAt
    });
  }

  return findings;
}

function buildKnownReferenceValueSet(data: DatabaseShape, refs: TransactionReferenceRecord[]) {
  const set = new Set<string>();
  const add = (value: unknown) => {
    const normalized = normalizeReferenceValue(value);
    if (normalized) set.add(normalized.toLowerCase());
  };
  refs.forEach((ref) => add(ref.referenceValue));
  for (const item of buildExpectedReferences(data)) add(item.referenceValue);
  for (const event of data.virtualAccountEvents ?? []) add(event.providerEventId);
  return set;
}

function webhookCandidateValues(event: { providerEventId?: string; eventObjectId?: string; payload?: unknown }) {
  const payload = (event.payload ?? {}) as any;
  const object = payload.event_object ?? payload.data ?? payload.object ?? {};
  return uniqueValues([
    event.providerEventId,
    event.eventObjectId,
    payload.event_id,
    payload.event_object_id,
    object.id,
    object.client_reference_id,
    object.liquidation_address_id,
    object.transfer_id,
    object.deposit_id,
    object.virtual_account_id,
    object.virtual_account?.id,
    object.source_deposit_instructions?.reference,
    object.deposit_instructions?.reference,
    object.receipt?.destination_tx_hash,
    object.destination_tx_hash,
    object.deposit_tx_hash
  ]);
}

function unifiedWebhookCandidateValues(log: { providerEventId?: string; paymentReference?: string; payload?: unknown }) {
  return uniqueValues([log.providerEventId, log.paymentReference, ...webhookCandidateValues({ providerEventId: log.providerEventId, payload: log.payload })]);
}

function isTransactionalWebhook(category?: string, type?: string, payload?: unknown) {
  const text = `${category ?? ''} ${type ?? ''} ${JSON.stringify(payload ?? {}).slice(0, 500)}`.toLowerCase();
  if (/(customer|kyc|tos|external_account|external_acccount)/.test(text) && !/(transfer|drain|funds|payment|deposit|virtual_account)/.test(text)) return false;
  return /(transfer|drain|liquidation|funds_|funds |payment_|payment |deposit|virtual_account|microdeposit|refund)/.test(text);
}

function sameReference(ref: TransactionReferenceRecord, expected: ExpectedReference) {
  return ref.resourceType === expected.resourceType
    && ref.resourceId === expected.resourceId
    && ref.provider === expected.provider
    && ref.referenceType === expected.referenceType
    && normalizeReferenceValue(ref.referenceValue).toLowerCase() === normalizeReferenceValue(expected.referenceValue).toLowerCase();
}

function hasResource(data: DatabaseShape, resourceType: string, resourceId: string) {
  if (resourceType === 'withdrawal') return (data.withdrawals ?? []).some((item) => item.id === resourceId);
  if (resourceType === 'onramp_order') return (data.onrampOrders ?? []).some((item) => item.id === resourceId);
  if (resourceType === 'virtual_account') return (data.virtualAccounts ?? []).some((item) => item.id === resourceId);
  if (resourceType === 'virtual_account_event') return (data.virtualAccountEvents ?? []).some((item) => item.id === resourceId);
  if (resourceType === 'virtual_account_transaction') return (data.virtualAccountTransactions ?? []).some((item) => item.id === resourceId);
  return true;
}

function countScannedResources(data: DatabaseShape) {
  return (data.withdrawals ?? []).length
    + (data.onrampOrders ?? []).length
    + (data.virtualAccounts ?? []).length
    + (data.virtualAccountEvents ?? []).length
    + (data.virtualAccountTransactions ?? []).length;
}

function buildRecommendedActions(byType: ReferenceReconciliationDashboard['byType']) {
  const actions: string[] = [];
  if (byType.missing_reference.length) actions.push('Run the transaction-reference backfill/sync for affected resources before provider reconciliation.');
  if (byType.duplicate_reference.length) actions.push('Pause automatic settlement for duplicate provider references until support confirms the canonical Sivan transaction.');
  if (byType.unmatched_webhook.length) actions.push('Reprocess unmatched provider webhooks after confirming provider event IDs and object IDs.');
  if (byType.reference_mismatch.length) actions.push('Compare provider payloads with Sivan records; correct stale resource fields or stale transaction reference rows.');
  if (!actions.length) actions.push('No reference ledger issues detected. Continue routine reconciliation monitoring.');
  return actions;
}

function normalizeReferenceValue(value: unknown) {
  return String(value ?? '').trim();
}

function uniqueValues(values: unknown[]) {
  return Array.from(new Set(values.map(normalizeReferenceValue).filter(Boolean)));
}

function severityRank(severity: FindingSeverity) {
  if (severity === 'error') return 3;
  if (severity === 'warning') return 2;
  return 1;
}

function fingerprint(...parts: unknown[]) {
  const raw = parts.map((part) => normalizeReferenceValue(part).toLowerCase()).join('|');
  let hash = 0;
  for (let index = 0; index < raw.length; index += 1) hash = ((hash << 5) - hash + raw.charCodeAt(index)) | 0;
  return `rfind_${Math.abs(hash).toString(36)}`;
}
