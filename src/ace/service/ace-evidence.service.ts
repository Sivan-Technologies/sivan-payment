import { db } from '../../database/json-database.js';
import { buildPublicOnrampTimeline, buildPublicWithdrawalTimeline } from '../../timeline/transaction-timeline.service.js';
import type { AceEvidenceBundle, AceEvidenceItem, AceResourceType } from '../types/ace.types.js';

export async function buildAceEvidence(input: { userId?: string; message: string; resourceType: AceResourceType; resourceId?: string; admin?: boolean }): Promise<AceEvidenceBundle> {
  const data = await db.read();
  const user = input.userId ? data.users.find((item) => item.id === input.userId) : undefined;
  const customer = user ? data.customers.find((item) => item.userId === user.id) : undefined;
  const transaction = findTransaction(data, input);
  const timeline = transaction?.kind === 'withdrawal'
    ? buildPublicWithdrawalTimeline(transaction.record, data)
    : transaction?.kind === 'onramp_order'
      ? buildPublicOnrampTimeline(transaction.record, data)
      : undefined;
  const trace = transaction ? (data.transactionReferences ?? []).filter((item) => item.resourceType === transaction.kind && item.resourceId === transaction.record.id) : [];
  const activeIncidents = (data.systemIncidents ?? []).filter((incident) => incident.status !== 'resolved');
  const relevantIncidents = transaction ? activeIncidents.filter((incident) => incident.affectedService === 'all' || (transaction.kind === 'withdrawal' && incident.affectedService === 'withdrawals') || (transaction.kind === 'onramp_order' && incident.affectedService === 'onramp') || incident.provider.toLowerCase() === String(transaction.record.provider ?? '').toLowerCase()) : activeIncidents;
  const webhooks = transaction ? findWebhooks(data.webhookEvents ?? [], transaction.record) : [];
  const reconciliationFindings = transaction ? (data.reconciliationFindings ?? []).filter((finding) => finding.resourceId === transaction.record.id || finding.withdrawalId === transaction.record.id || finding.sivanTransactionId === transaction.record.id) : [];
  const supportTickets = user ? (data.supportTickets ?? []).filter((ticket) => ticket.userId === user.id && (!transaction || ticket.resourceId === transaction.record.id || ticket.resourceType === transaction.kind)).slice(-5) : [];
  const queue = deriveQueueStatus(transaction?.record, webhooks, reconciliationFindings);
  const providerHealth = deriveProviderHealth(transaction?.record?.provider, relevantIncidents);
  const currentStep = timeline?.steps.find((step) => step.status === 'current') ?? [...(timeline?.steps ?? [])].reverse().find((step) => step.status === 'completed');
  const providerReference = transaction ? providerReferenceFor(transaction.kind, transaction.record, trace) : undefined;
  const evidenceItems: AceEvidenceItem[] = [
    ...(user ? [{ source: 'user.id', label: 'User ID', value: user.id, customerSafe: false }, { source: 'user.email', label: 'User email', value: user.email, customerSafe: false }] : []),
    ...(customer ? [{ source: 'customer.kycStatus', label: 'KYC status', value: customer.kycStatus, customerSafe: true }] : []),
    ...(transaction ? [
      { source: 'transaction.id', label: 'Request ID', value: transaction.record.id, customerSafe: true },
      { source: 'transaction.type', label: 'Transaction type', value: transaction.kind === 'withdrawal' ? 'withdrawal' : 'buy order', customerSafe: true },
      { source: 'transaction.status', label: 'Status', value: transaction.record.status, customerSafe: true },
      { source: 'transaction.provider', label: 'Provider', value: transaction.record.provider, customerSafe: true },
      { source: 'transaction.providerReference', label: 'Provider reference', value: providerReference, customerSafe: true },
      { source: 'transaction.explanation', label: 'Explanation', value: timeline?.explanation, customerSafe: true },
      { source: 'timeline.currentStage', label: 'Current stage', value: currentStep?.label, customerSafe: true }
    ] : []),
    ...relevantIncidents.map((incident) => ({ source: 'incident.active', label: 'Incident', value: `${incident.provider}: ${incident.message}`, customerSafe: true, metadata: { eta: incident.eta, severity: incident.severity } })),
    { source: 'webhooks.count', label: 'Webhook count', value: webhooks.length, customerSafe: Boolean(input.admin) },
    { source: 'queue.status', label: 'Queue status', value: queue.map((item) => `${item.name}:${item.status}`).join(', ') || 'normal', customerSafe: true },
    { source: 'providerHealth.status', label: 'Provider health', value: providerHealth.status, customerSafe: true },
    { source: 'reconciliation.count', label: 'Reconciliation findings', value: reconciliationFindings.length, customerSafe: Boolean(input.admin) },
    { source: 'supportTickets.count', label: 'Support tickets', value: supportTickets.length, customerSafe: false }
  ];

  return {
    user: user ? { id: user.id, email: input.admin ? user.email : undefined, kycStatus: customer?.kycStatus } : undefined,
    transaction: transaction ? { id: transaction.record.id, type: transaction.kind, status: transaction.record.status, explanation: timeline?.explanation, amount: amountFor(transaction.kind, transaction.record), currency: currencyFor(transaction.kind, transaction.record), provider: transaction.record.provider, providerReference } : undefined,
    timeline: timeline?.steps ?? [],
    trace: input.admin ? trace : trace.map(({ metadata, ...item }) => item),
    incidents: relevantIncidents,
    webhooks: input.admin ? webhooks : webhooks.map((event) => ({ id: event.id, provider: event.provider, eventType: event.eventType, eventCategory: event.eventCategory, processedAt: event.processedAt, createdAt: event.createdAt })),
    queue,
    providerHealth,
    reconciliationFindings: input.admin ? reconciliationFindings : [],
    supportTickets: input.admin ? supportTickets : supportTickets.map((ticket) => ({ id: ticket.id, status: ticket.status, type: ticket.type, createdAt: ticket.createdAt })),
    evidenceItems
  };
}

function findTransaction(data: any, input: { userId?: string; resourceType: AceResourceType; resourceId?: string }) {
  if (input.resourceType === 'withdrawal') {
    const record = input.resourceId ? data.withdrawals.find((item: any) => item.id === input.resourceId) : data.withdrawals.filter((item: any) => !input.userId || item.userId === input.userId).sort(descCreated)[0];
    return record ? { kind: 'withdrawal' as const, record } : undefined;
  }
  if (input.resourceType === 'onramp_order') {
    const record = input.resourceId ? (data.onrampOrders ?? []).find((item: any) => item.id === input.resourceId) : (data.onrampOrders ?? []).filter((item: any) => !input.userId || item.userId === input.userId).sort(descCreated)[0];
    return record ? { kind: 'onramp_order' as const, record } : undefined;
  }
  const latestWithdrawal = data.withdrawals.filter((item: any) => !input.userId || item.userId === input.userId).sort(descCreated)[0];
  const latestOrder = (data.onrampOrders ?? []).filter((item: any) => !input.userId || item.userId === input.userId).sort(descCreated)[0];
  if (!latestOrder) return latestWithdrawal ? { kind: 'withdrawal' as const, record: latestWithdrawal } : undefined;
  if (!latestWithdrawal) return { kind: 'onramp_order' as const, record: latestOrder };
  return latestWithdrawal.createdAt > latestOrder.createdAt ? { kind: 'withdrawal' as const, record: latestWithdrawal } : { kind: 'onramp_order' as const, record: latestOrder };
}

function findWebhooks(webhooks: any[], record: any) {
  const values = [record.id, record.providerDrainId, record.providerTransferId, record.destinationReference, record.providerReference, record.destinationTxHash, record.depositTxHash].filter(Boolean).map(String);
  return webhooks.filter((event) => {
    const text = JSON.stringify(event.payload ?? {});
    return values.some((value) => event.eventObjectId === value || event.providerEventId === value || text.includes(value));
  }).sort(descCreated).slice(0, 20);
}

function deriveQueueStatus(record: any, webhooks: any[], findings: any[]): Array<{ name: string; status: string; detail?: string }> {
  if (!record) return [{ name: 'transaction_lookup', status: 'not_found', detail: 'No matching transaction found' }];
  const ageMinutes = (Date.now() - new Date(record.updatedAt ?? record.createdAt).getTime()) / 60000;
  const openFindings = findings.filter((finding) => finding.status === 'open');
  const queue: Array<{ name: string; status: string; detail?: string }> = [{ name: 'provider_webhooks', status: webhooks.length ? 'seen' : ['completed', 'failed', 'cancelled'].includes(record.status) ? 'not_required' : 'pending' }];
  if (ageMinutes > 30 && !['completed', 'failed', 'cancelled'].includes(record.status)) queue.push({ name: 'stale_transaction_watch', status: 'watch', detail: `${Math.round(ageMinutes)} minutes since update` });
  if (openFindings.length) queue.push({ name: 'reconciliation', status: 'open_findings', detail: `${openFindings.length} open finding(s)` });
  return queue;
}

function deriveProviderHealth(provider?: string, incidents: any[] = []) {
  if (!provider) return { status: 'unknown' };
  const providerIncident = incidents.find((incident) => incident.provider.toLowerCase() === provider.toLowerCase());
  if (providerIncident) return { provider, status: providerIncident.severity === 'critical' ? 'degraded' : 'delayed', detail: providerIncident.message };
  return { provider, status: 'normal' };
}

function providerReferenceFor(kind: string, record: any, trace: any[]) {
  if (kind === 'withdrawal') return record.providerDrainId ?? record.destinationReference ?? trace.find((item) => ['bridge_drain_id', 'destination_reference'].includes(item.referenceType))?.referenceValue;
  return record.providerTransferId ?? record.providerReference ?? trace.find((item) => ['provider_transfer_id', 'provider_reference'].includes(item.referenceType))?.referenceValue;
}
function amountFor(kind: string, record: any) { return kind === 'withdrawal' ? record.destinationAmount ?? record.sourceAmount : record.amount; }
function currencyFor(kind: string, record: any) { return kind === 'withdrawal' ? record.destinationCurrency?.toUpperCase?.() : record.sourceCurrency?.toUpperCase?.(); }
function descCreated(a: any, b: any) { return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')); }
