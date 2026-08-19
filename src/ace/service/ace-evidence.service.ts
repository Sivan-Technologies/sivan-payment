import { db } from '../../database/json-database.js';
import { buildPublicOnrampTimeline, buildPublicWithdrawalTimeline } from '../../timeline/transaction-timeline.service.js';
import { buildTimeline as buildNgnTimeline } from '../../ngn/service/ngn-transfers.service.js';
import { getVerificationSummary } from '../../kyc/service/verification-summary.service.js';
import type { AceEvidenceBundle, AceEvidenceItem, AceIntent, AceResourceType } from '../types/ace.types.js';

export async function buildAceEvidence(input: { userId?: string; message: string; resourceType: AceResourceType; resourceId?: string; intent?: AceIntent; admin?: boolean }): Promise<AceEvidenceBundle> {
  const data = await db.read();
  const user = input.userId ? data.users.find((item) => item.id === input.userId) : undefined;
  const customer = user ? data.customers.find((item) => item.userId === user.id) : undefined;
  const transaction = findTransaction(data, input);
  /**
   * A NAMED REFERENCE THAT RESOLVED TO NOTHING IS ITS OWN ANSWER.
   *
   * Without this the assistant cannot tell "you gave me an id I cannot find"
   * apart from "you gave me no id", and the second used to mean "report on
   * their newest transaction". That is precisely how a user pasting
   * ngnt_f17c5017 got told about buy order or_17f19d8b.
   */
  const unresolvedReference = input.resourceId && !transaction ? input.resourceId : undefined;

  /**
   * VERIFICATION EVIDENCE, fetched only when it is what was asked about.
   *
   * getVerificationSummary() is a real read against users, customers, accounts
   * and the limit matrix, so it is not free - and attaching it to every
   * "where is my payout" question would be waste. Gated on intent.
   *
   * Failure is swallowed to a warning rather than thrown: a support assistant
   * that 500s because a secondary lookup failed is worse than one that answers
   * from the evidence it does have.
   */
  const verification = input.intent === 'verification' && input.userId
    ? await getVerificationSummary(input.userId).catch(() => undefined)
    : undefined;
  const timeline = transaction?.kind === 'withdrawal'
    ? buildPublicWithdrawalTimeline(transaction.record, data)
    : transaction?.kind === 'onramp_order'
      ? buildPublicOnrampTimeline(transaction.record, data)
      /**
       * NGN transfers already carry a timeline builder - buildTimeline() in
       * ngn-transfers.service - and it was simply never wired in here. Reused
       * rather than reimplemented so the assistant and the transaction page
       * describe the same stages in the same words.
       *
       * `explanation` is the CURRENT step's description, matching what the
       * other two builders return, so downstream copy needs no special case.
       */
      : transaction?.kind === 'ngn_transfer'
        ? ngnTimelineFor(transaction.record)
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
    /**
     * The verification facts, as individual evidence lines.
     *
     * This list is what actually reaches Sivan AI - the bundle's typed fields
     * are for local composition, but the remote call sends evidenceItems only.
     * So verification data that is not itemised here is invisible to the model
     * no matter how well-populated the bundle is. Proven by probe: given a KYC
     * row the live model answered "Your verification status is approved";
     * given only transaction rows it produced a generic sentence about
     * identity checks.
     */
    ...(verification ? [
      { source: 'verification.level', label: 'Verification level', value: `${verification.level} (${verification.levelLabel})`, customerSafe: true },
      { source: 'verification.path', label: 'Verification path', value: verification.path, customerSafe: true },
      { source: 'verification.identityComplete', label: 'Identity check complete', value: verification.identityComplete, customerSafe: true },
      { source: 'verification.pathComplete', label: 'Verification complete', value: verification.pathComplete, customerSafe: true },
      ...Object.entries(verification.checks ?? {}).map(([name, status]) => ({
        source: `verification.check.${name}`, label: `Check: ${name}`, value: String(status), customerSafe: true,
      })),
      { source: 'verification.terms', label: 'Provider terms', value: verification.terms?.required ? (verification.terms.accepted ? 'accepted' : 'not accepted') : 'not required', customerSafe: true },
      { source: 'verification.hasPayoutAccount', label: 'Payout account on file', value: verification.hasPayoutAccount, customerSafe: true },
      ...(verification.hasPendingPayoutReview ? [{ source: 'verification.payoutReview', label: 'Payout account in review', value: true, customerSafe: true }] : []),
      ...(verification.nextStep ? [{
        source: 'verification.nextStep',
        label: 'Next step',
        value: `${verification.nextStep.label}: ${verification.nextStep.description}${verification.nextStep.available ? '' : ' (not available yet)'}`,
        customerSafe: true,
      }] : []),
    ] : []),
    ...(unresolvedReference ? [{ source: 'reference.unresolved', label: 'Reference not found', value: unresolvedReference, customerSafe: true }] : []),
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
    intent: input.intent,
    unresolvedReference,
    verification: verification ? {
      level: verification.level,
      levelLabel: verification.levelLabel,
      path: verification.path,
      identityComplete: verification.identityComplete,
      pathComplete: verification.pathComplete,
      checks: verification.checks as unknown as Record<string, string>,
      termsRequired: Boolean(verification.terms?.required),
      termsAccepted: Boolean(verification.terms?.accepted),
      hasPayoutAccount: verification.hasPayoutAccount,
      hasPendingPayoutReview: verification.hasPendingPayoutReview,
      nextStep: verification.nextStep
        ? { label: verification.nextStep.label, description: verification.nextStep.description, available: verification.nextStep.available }
        : undefined,
    } : undefined,
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

/**
 * Find the record the user is asking about - and DO NOT INVENT ONE.
 *
 * The old contract was: 'general' means "grab their newest transaction". That
 * single line produced the worst class of bug this assistant had. Asking about
 * verification, or pasting an NGN reference, or saying hello, all landed on
 * 'general' and all got a confident status report about an unrelated buy
 * order, complete with a Request ID the user had never seen.
 *
 * The rule now:
 *   - a concrete type + id  -> look up exactly that, or nothing
 *   - 'transaction_lookup'  -> the user IS asking about a transaction but did
 *                              not say which; their latest is a fair answer
 *   - 'general'             -> attach NOTHING
 *
 * "Which transaction do you mean?" is a better answer than a fluent
 * description of the wrong one.
 */
function findTransaction(data: any, input: { userId?: string; resourceType: AceResourceType; resourceId?: string }) {
  if (input.resourceType === 'general') return undefined;
  if (input.resourceType === 'ngn_transfer') {
    const rows = (data.ngnTransfers ?? []).filter((item: any) => !input.userId || item.userId === input.userId);
    const record = input.resourceId
      ? rows.find((item: any) => item.id === input.resourceId)
      : rows.sort(descCreated)[0];
    return record ? { kind: 'ngn_transfer' as const, record } : undefined;
  }
  if (input.resourceType === 'withdrawal') {
    const record = input.resourceId ? data.withdrawals.find((item: any) => item.id === input.resourceId) : data.withdrawals.filter((item: any) => !input.userId || item.userId === input.userId).sort(descCreated)[0];
    return record ? { kind: 'withdrawal' as const, record } : undefined;
  }
  if (input.resourceType === 'onramp_order') {
    const record = input.resourceId ? (data.onrampOrders ?? []).find((item: any) => item.id === input.resourceId) : (data.onrampOrders ?? []).filter((item: any) => !input.userId || item.userId === input.userId).sort(descCreated)[0];
    return record ? { kind: 'onramp_order' as const, record } : undefined;
  }
  /**
   * Reached only for 'transaction_lookup' - someone who asked about a
   * transaction without naming one. NGN transfers join the race here; they
   * were absent before, so a user whose only recent activity was a naira
   * payout got "no transaction found" or, worse, a stale buy order.
   */
  const mine = (rows: any[]) => (rows ?? []).filter((item: any) => !input.userId || item.userId === input.userId);
  const candidates = [
    { kind: 'withdrawal' as const, record: mine(data.withdrawals).sort(descCreated)[0] },
    { kind: 'onramp_order' as const, record: mine(data.onrampOrders).sort(descCreated)[0] },
    { kind: 'ngn_transfer' as const, record: mine(data.ngnTransfers).sort(descCreated)[0] },
  ].filter((item) => Boolean(item.record));
  if (!candidates.length) return undefined;
  return candidates.sort((a, b) => descCreated(a.record, b.record))[0];
}

/**
 * Shape an NGN transfer's steps like the other two builders' output.
 *
 * buildTimeline() returns NgnTimelineStep[]; the public builders return an
 * object with `steps` and `explanation`. Normalised here so buildAceEvidence
 * has one shape to consume.
 */
function ngnTimelineFor(record: any) {
  const steps = buildNgnTimeline(record) ?? [];
  const current = steps.find((step: any) => step.status === 'current')
    ?? [...steps].reverse().find((step: any) => step.status === 'completed');
  return { steps, explanation: current?.description };
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
  /** Breet's own ids, in the order a support agent would quote them. */
  if (kind === 'ngn_transfer') return record.settlementReference ?? record.providerTransferId ?? record.bankReference;
  if (kind === 'withdrawal') return record.providerDrainId ?? record.destinationReference ?? trace.find((item) => ['bridge_drain_id', 'destination_reference'].includes(item.referenceType))?.referenceValue;
  return record.providerTransferId ?? record.providerReference ?? trace.find((item) => ['provider_transfer_id', 'provider_reference'].includes(item.referenceType))?.referenceValue;
}
/**
 * NGN transfers carry destinationAmount/destinationCurrency like withdrawals,
 * not `amount`/`sourceCurrency` like orders. Without this branch every naira
 * payout reported an undefined amount - the record was found and then
 * described as having no value.
 */
function amountFor(kind: string, record: any) {
  if (kind === 'withdrawal' || kind === 'ngn_transfer') return record.destinationAmount ?? record.sourceAmount;
  return record.amount;
}
function currencyFor(kind: string, record: any) {
  if (kind === 'withdrawal' || kind === 'ngn_transfer') return record.destinationCurrency?.toUpperCase?.();
  return record.sourceCurrency?.toUpperCase?.();
}
function descCreated(a: any, b: any) { return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')); }
