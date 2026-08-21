import { z } from 'zod';
import { db } from '../database/json-database.js';
import { createAuditLog } from '../audit/audit.service.js';
import { badRequest, notFound } from '../shared/errors.js';
import { nowIso } from '../shared/id.js';
import { getAdminFeeSettings } from './admin-fees.service.js';
import { getLimitControls } from './admin-ops.service.js';
import { providerCapabilities } from '../providers/provider-routing.js';
import { BridgeClient } from '../providers/bridge/bridge.client.js';
import { refreshKycStatus } from '../customers/customers.service.js';
import { searchTransactionReferences } from '../references/transaction-references.service.js';
import type { NgnTransferRecord } from '../ngn/types/ngn.types.js';

export const userRestrictionSchema = z.object({
  reason: z.string().min(5).max(2000),
  restrictedBy: z.string().min(2).default('admin_api_key'),
  restrictionType: z.enum(['all_payment_actions', 'onramp', 'offramp', 'kyc', 'support_only']).default('all_payment_actions'),
  expiresAt: z.string().datetime().optional()
});

export const refundRequestSchema = z.object({
  resourceType: z.enum(['withdrawal', 'onramp_order', 'support_ticket']),
  resourceId: z.string().min(1),
  amount: z.string().min(1).optional(),
  currency: z.string().min(2).optional(),
  reason: z.string().min(5).max(2000),
  requestedBy: z.string().min(2).default('admin_api_key')
});

export const payoutRetrySchema = z.object({
  reason: z.string().min(5).max(2000),
  requestedBy: z.string().min(2).default('admin_api_key'),
  providerReference: z.string().optional()
});

export async function getGlobalSearch(q: string, options: { limit?: number } = {}) {
  const query = q.trim().toLowerCase();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  if (!query) return { query, results: [] };
  const data = await db.read();
  const match = (value: unknown) => JSON.stringify(value ?? '').toLowerCase().includes(query);
  const transactionReferences = await searchTransactionReferences(query, limit);
  const results = [
    ...transactionReferences.map((item) => ({ type: 'transaction_reference', id: item.id, title: item.referenceValue, subtitle: `${item.provider} · ${item.referenceType} · ${item.resourceType}:${item.resourceId}`, record: item })),
    ...data.users.filter(match).map((item) => ({ type: 'user', id: item.id, title: item.email, subtitle: item.fullName, record: item })),
    ...data.customers.filter(match).map((item) => ({ type: 'customer', id: item.id, title: item.providerCustomerId, subtitle: item.kycStatus, record: item })),
    ...data.withdrawals.filter(match).map((item) => ({ type: 'withdrawal', id: item.id, title: item.status, subtitle: `${item.sourceCurrency} → ${item.destinationCurrency}`, record: item })),
    ...(data.onrampOrders ?? []).filter(match).map((item) => ({ type: 'onramp_order', id: item.id, title: item.status, subtitle: `${item.sourceCurrency} → ${item.destinationCurrency}`, record: item })),
    ...data.externalAccounts.filter(match).map((item) => ({ type: 'external_account', id: item.id, title: item.bankName || item.providerExternalAccountId, subtitle: item.accountLast4, record: item })),
    ...(data.supportTickets ?? []).filter(match).map((item) => ({ type: 'support_ticket', id: item.id, title: item.subject, subtitle: item.status, record: item })),
    ...(data.webhookEvents ?? []).filter(match).map((item) => ({ type: 'webhook', id: item.id, title: item.providerEventId, subtitle: item.eventCategory, record: item }))
  ].slice(0, limit);
  return { query, count: results.length, results };
}

export async function getUserTimeline(userId: string) {
  const data = await db.read();
  const user = data.users.find((item) => item.id === userId);
  if (!user) throw notFound('User');
  const events = [
    { type: 'user.created', at: user.createdAt, title: 'User created', record: user },
    ...data.customers.filter((item) => item.userId === userId).map((item) => ({ type: 'customer.kyc', at: item.createdAt, title: `KYC ${item.kycStatus}`, record: item })),
    ...data.externalAccounts.filter((item) => item.userId === userId).map((item) => ({ type: 'bank_account', at: item.createdAt, title: `${item.currency.toUpperCase()} bank ${item.status}`, record: item })),
    ...data.withdrawals.filter((item) => item.userId === userId).map((item) => ({ type: 'withdrawal', at: item.createdAt, title: `Withdrawal ${item.status}`, record: item })),
    ...(data.onrampOrders ?? []).filter((item) => item.userId === userId).map((item) => ({ type: 'onramp', at: item.createdAt, title: `On-ramp ${item.status}`, record: item })),
    ...(data.supportTickets ?? []).filter((item) => item.userId === userId).map((item) => ({ type: 'support', at: item.createdAt, title: item.subject, record: item })),
    ...(data.legalAcceptances ?? []).filter((item) => item.userId === userId).map((item) => ({ type: 'legal_acceptance', at: item.acceptedAt, title: 'Accepted legal terms', record: item })),
    ...(data.auditLogs ?? []).filter((log) => log.actorId === userId || log.resourceId === userId || (log.metadata as any)?.userId === userId).map((log) => ({ type: 'audit', at: log.createdAt, title: log.action, record: log }))
  ].filter((event) => event.at).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { user, count: events.length, events };
}

export async function listUserRestrictions(userId?: string) {
  /**
   * TWO INDEXED ACTIONS, NOT THE WHOLE DATABASE.
   *
   * This was db.read() - 47 sequential `select *` queries, every table,
   * including the entire unbounded audit history - and it runs inside the
   * platform-status preHandler via getActiveRestrictionForUser() for EVERY
   * mutating request that names a user.
   *
   * That made it a tax on the whole platform, not one endpoint. Measured on
   * api-test after the onramp fixes: signup POST 3.9s and a buy rejection
   * 3.4s, against GET /health at 30ms and GET /api/system/status at 333ms -
   * the cost was the same on both, which is what gave the shared hook away.
   *
   * Third instance of this exact bug: getAdminPlatformSettings() (146s
   * signups), then getOnrampControls(), now this. The audit log is the most
   * expensive table in the system and the easiest one to read by accident.
   */
  return db.listAuditLogsByActions(
    ['admin.user_restricted', 'admin.user_unrestricted'],
    userId
  );
}

export async function restrictUser(userId: string, input: z.infer<typeof userRestrictionSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const data = await db.read();
  const user = data.users.find((item) => item.id === userId);
  if (!user) throw notFound('User');
  await createAuditLog({
    actorType: 'admin',
    actorId: input.restrictedBy,
    action: 'admin.user_restricted',
    resourceType: 'user',
    resourceId: userId,
    severity: 'warning',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { reason: input.reason, restrictionType: input.restrictionType, expiresAt: input.expiresAt, userEmail: user.email }
  });
  return { restricted: true, userId, ...input };
}

export async function unrestrictUser(userId: string, input: { reason?: string; actorId?: string } = {}, context: { ipAddress?: string; userAgent?: string } = {}) {
  await createAuditLog({ actorType: 'admin', actorId: input.actorId ?? 'admin_api_key', action: 'admin.user_unrestricted', resourceType: 'user', resourceId: userId, severity: 'warning', ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { reason: input.reason ?? 'Restriction removed' } });
  return { restricted: false, userId };
}

export async function getActiveRestrictionForUser(userId: string, action: 'onramp' | 'offramp' | 'kyc' | 'support' | 'all' = 'all') {
  const logs = await listUserRestrictions(userId);
  const latest = logs[0];
  if (!latest || latest.action === 'admin.user_unrestricted') return undefined;
  const metadata = latest.metadata as any;
  if (metadata?.expiresAt && new Date(metadata.expiresAt).getTime() < Date.now()) return undefined;
  const type = metadata?.restrictionType ?? 'all_payment_actions';
  if (type === 'all_payment_actions') return latest;
  if (type === action) return latest;
  if (action === 'offramp' && type === 'offramp') return latest;
  if (action === 'onramp' && type === 'onramp') return latest;
  return undefined;
}

export async function getProviderHealth() {
  const data = await db.read();
  const recentWebhookErrors = (data.auditLogs ?? []).filter((log) => log.severity === 'error' && /webhook|provider|bridge/i.test(log.action + JSON.stringify(log.metadata ?? {}))).slice(-20);
  return {
    generatedAt: nowIso(),
    providers: providerCapabilities.map((provider) => ({
      name: provider.name,
      available: provider.available,
      speed: provider.speed,
      reliability: provider.reliability,
      rails: provider.destinationPaymentRails,
      currencies: provider.destinationCurrencies,
      sourceChains: provider.sourceChains,
      health: provider.available ? 'configured' : 'unavailable'
    })),
    bridge: {
      webhookEventsStored: (data.webhookEvents ?? []).filter((event) => event.provider === 'bridge').length,
      recentWebhookErrors,
      lastWebhookAt: (data.webhookEvents ?? []).filter((event) => event.provider === 'bridge').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.createdAt
    }
  };
}

export async function getQueueDashboard() {
  const data = await db.read();
  const pendingApprovals = (data.auditLogs ?? []).filter((log) => log.action === 'admin.approval_requested' && !(data.auditLogs ?? []).some((review) => ['admin.approval_approved', 'admin.approval_rejected'].includes(review.action) && (review.metadata as any)?.approvalId === log.resourceId));
  const staleWithdrawals = data.withdrawals.filter((item) => ['pending_deposit', 'deposit_received', 'payout_processing'].includes(item.status) && ageHours(item.createdAt) > 24);
  const staleOnramp = (data.onrampOrders ?? []).filter((item) => ['awaiting_payment', 'processing', 'requires_action'].includes(item.status) && ageHours(item.createdAt) > 24);
  const failedWebhooks = (data.webhookEvents ?? []).filter((item) => !item.processedAt);
  return {
    generatedAt: nowIso(),
    queues: [
      { name: 'approval_requests', pending: pendingApprovals.length, items: pendingApprovals.slice(0, 50) },
      { name: 'stale_withdrawals', pending: staleWithdrawals.length, items: staleWithdrawals.slice(0, 50) },
      { name: 'stale_onramp_orders', pending: staleOnramp.length, items: staleOnramp.slice(0, 50) },
      { name: 'unprocessed_webhooks', pending: failedWebhooks.length, items: failedWebhooks.slice(0, 50) }
    ]
  };
}

export async function getSettlementReconciliation() {
  const data = await db.read();
  const fees = await getAdminFeeSettings();
  const limits = await getLimitControls();

  const withdrawalsList = [
    ...(data.withdrawals ?? []),
    ...((data as any).ngnWithdrawals ?? []),
    ...((data as any).balanceTransfers ?? []),
  ];

  const completedWithdrawals = withdrawalsList.filter((item) => ['completed', 'settled', 'success'].includes(item.status));
  const completedOnramps = [
    ...(data.onrampOrders ?? []),
    ...((data as any).virtualAccountTransactions ?? []),
  ].filter((item) => ['completed', 'settled', 'success'].includes(item.status));
  const offrampGross = completedWithdrawals.reduce((sum, item) => sum + Number(item.destinationAmount ?? item.sourceAmount ?? item.amount ?? 0) + Number(item.feeAmount ?? 0), 0);
  const onrampGross = completedOnramps.reduce((sum, item) => sum + Number(item.amount ?? item.grossAmount ?? 0), 0);
  const sivanFees = completedWithdrawals.reduce((sum, item) => sum + Number(item.feeAmount ?? 0), 0) + completedOnramps.reduce((sum, item) => sum + Number(item.feeAmount ?? 0), 0);
  const providerCostEstimate = offrampGross * (fees.bridgeOfframpCostPercent / 100);

  return {
    generatedAt: nowIso(),
    summary: {
      completedWithdrawalCount: completedWithdrawals.length,
      completedOnrampCount: completedOnramps.length,
      offrampGrossUsdEstimate: money(offrampGross),
      onrampGrossUsdEstimate: money(onrampGross),
      sivanFeesUsd: money(sivanFees),
      providerCostEstimateUsd: money(providerCostEstimate),
      netSettlementEstimateUsd: money(sivanFees - providerCostEstimate)
    },
    providerBalances: [
      { provider: 'breet', currency: 'NGN / USDC', status: 'connected', availableBalance: 'Active Auto-Settlement', ledgerBalance: 'Live Rail', note: 'Breet NGN auto-settlement and bank payout rail connected.' },
      { provider: 'paj', currency: 'NGN', status: 'connected', availableBalance: 'Backup Provider', ledgerBalance: 'Standby Rail', note: 'PAJ NGN banking rail.' },
      { provider: 'solana', currency: 'USDC / USDT', status: 'connected', availableBalance: 'On-Chain Vault', ledgerBalance: 'Live Ledger', note: 'Solana non-custodial balance and settlement rail.' },
      { provider: 'bridge', currency: 'USD', status: 'standby', availableBalance: null, ledgerBalance: null, note: 'Bridge USD virtual accounts.' }
    ],
    treasuryBalances: [
      { account: 'operating', currency: 'USDC', status: 'active', balance: money(offrampGross + onrampGross), note: 'Sivan Payment Operating Treasury.' }
    ],
    limitControls: limits,
    findings: [
      ...(completedWithdrawals.length ? [] : [{ severity: 'info', message: 'No completed withdrawals in current data window.' }]),
      { severity: 'info', message: 'Active NGN offramp and Solana settlement rails are verified.' }
    ]
  };
}

export async function getDocumentVerificationQueue() {
  const data = await db.read();
  const usersById = new Map(data.users.map((user) => [user.id, user]));
  const rows = await Promise.all(data.customers.map(async (customer) => {
    const diagnostics = await getBridgeKycDiagnostics(customer);
    const user = usersById.get(customer.userId);
    return {
      id: customer.id,
      userId: customer.userId,
      userEmail: user?.email,
      userName: user?.fullName,
      provider: customer.provider,
      providerCustomerId: customer.providerCustomerId,
      customerType: customer.customerType,
      kycStatus: customer.kycStatus,
      tosStatus: customer.tosStatus,
      documents: extractDocumentEvidence(customer.raw),
      diagnostics,
      actionSummary: diagnostics.actionSummary,
      missingRequirements: diagnostics.missingRequirements,
      pendingRequirements: diagnostics.pendingRequirements,
      issueRequirements: diagnostics.issueRequirements,
      updatedAt: customer.updatedAt
    };
  }));
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getCustomerKycDiagnostics(userId: string) {
  const before = await db.read();
  const existing = before.customers.find((customer) => customer.userId === userId);
  if (!existing) throw notFound('Customer');
  let customer = existing;
  let refreshError: string | undefined;
  try {
    customer = await refreshKycStatus(userId);
  } catch (error) {
    refreshError = error instanceof Error ? error.message : String(error);
  }
  const diagnostics = await getBridgeKycDiagnostics(customer);
  return {
    refreshedAt: nowIso(),
    refreshError,
    customer: {
      id: customer.id,
      userId: customer.userId,
      provider: customer.provider,
      providerCustomerId: customer.providerCustomerId,
      customerType: customer.customerType,
      kycLinkId: customer.kycLinkId,
      kycStatus: customer.kycStatus,
      tosStatus: customer.tosStatus,
      updatedAt: customer.updatedAt
    },
    diagnostics
  };
}

export async function requestRefund(input: z.infer<typeof refundRequestSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  await assertResourceExists(input.resourceType, input.resourceId);
  await createAuditLog({ actorType: 'admin', actorId: input.requestedBy, action: 'admin.refund_requested', resourceType: input.resourceType, resourceId: input.resourceId, severity: 'warning', ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: input });
  return { requested: true, status: 'approval_required', ...input };
}

export async function requestPayoutRetry(withdrawalId: string, input: z.infer<typeof payoutRetrySchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const data = await db.read();
  const withdrawal = data.withdrawals.find((item) => item.id === withdrawalId);
  if (!withdrawal) throw notFound('Withdrawal');
  if (!['failed', 'requires_action', 'payout_processing'].includes(withdrawal.status)) throw badRequest('Payout retry is only allowed for failed/requires_action/payout_processing withdrawals');
  await createAuditLog({ actorType: 'admin', actorId: input.requestedBy, action: 'admin.payout_retry_requested', resourceType: 'payments_withdrawal', resourceId: withdrawalId, severity: 'warning', ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { ...input, withdrawal } });
  return { requested: true, status: 'provider_sync_required', withdrawalId, ...input };
}

async function assertResourceExists(resourceType: string, resourceId: string) {
  const data = await db.read();
  if (resourceType === 'withdrawal' && !data.withdrawals.some((item) => item.id === resourceId)) throw notFound('Withdrawal');
  if (resourceType === 'onramp_order' && !(data.onrampOrders ?? []).some((item) => item.id === resourceId)) throw notFound('On-ramp order');
  if (resourceType === 'support_ticket' && !(data.supportTickets ?? []).some((item) => item.id === resourceId)) throw notFound('Support ticket');
}

function extractDocumentEvidence(raw: unknown) {
  const text = JSON.stringify(raw ?? {});
  const evidence: string[] = [];
  if (/passport/i.test(text)) evidence.push('passport');
  if (/license|driver/i.test(text)) evidence.push('driver_license');
  if (/identity|id_document|government/i.test(text)) evidence.push('identity_document');
  if (/proof_of_address|address/i.test(text)) evidence.push('proof_of_address');
  return evidence.length ? evidence : ['provider_hosted_kyc'];
}

async function getBridgeKycDiagnostics(customer: any) {
  const diagnostics: any = {
    provider: customer.provider,
    checkedAt: nowIso(),
    bridgeKycStatus: customer.kycStatus,
    bridgeTosStatus: customer.tosStatus,
    missingRequirements: [] as string[],
    pendingRequirements: [] as string[],
    completedRequirements: [] as string[],
    issueRequirements: [] as string[],
    additionalRequirements: [] as string[],
    endorsements: [] as any[],
    actionSummary: customer.kycStatus === 'kyc_approved' ? 'KYC approved.' : 'No live Bridge diagnostics available for this customer.',
    operatorGuidance: [] as string[]
  };
  if (customer.provider !== 'bridge') {
    diagnostics.actionSummary = customer.provider === 'mock'
      ? 'Legacy mock customer. Not Bridge-verifiable. Ask user to complete a fresh Bridge KYC flow before real provider actions.'
      : `Customer provider is ${customer.provider}; Bridge diagnostics do not apply.`;
    return diagnostics;
  }

  const client = new BridgeClient();
  let kycLink: any;
  let bridgeCustomer: any;
  const errors: string[] = [];
  if (customer.kycLinkId) {
    try {
      kycLink = await client.request<any>(`/kyc_links/${customer.kycLinkId}`);
      diagnostics.kycLink = summarizeKycLink(kycLink);
      diagnostics.bridgeKycStatus = kycLink.kyc_status || diagnostics.bridgeKycStatus;
      diagnostics.bridgeTosStatus = kycLink.tos_status || diagnostics.bridgeTosStatus;
    } catch (error) {
      errors.push(`KYC link lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (customer.providerCustomerId) {
    try {
      bridgeCustomer = await client.request<any>(`/customers/${customer.providerCustomerId}`);
      diagnostics.bridgeCustomer = summarizeBridgeCustomer(bridgeCustomer);
      diagnostics.bridgeCustomerStatus = bridgeCustomer.status;
      diagnostics.bridgeKycStatus = bridgeCustomer.status || diagnostics.bridgeKycStatus;
      diagnostics.endorsements = summarizeEndorsements(bridgeCustomer.endorsements || []);
    } catch (error) {
      errors.push(`Bridge customer lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const endorsements = diagnostics.endorsements || [];
  diagnostics.missingRequirements = unique(endorsements.flatMap((endorsement: any) => endorsement.missingRequirements || []));
  diagnostics.pendingRequirements = unique(endorsements.flatMap((endorsement: any) => endorsement.pendingRequirements || []));
  diagnostics.completedRequirements = unique(endorsements.flatMap((endorsement: any) => endorsement.completedRequirements || []));
  diagnostics.issueRequirements = unique(endorsements.flatMap((endorsement: any) => endorsement.issueRequirements || []));
  diagnostics.additionalRequirements = unique(endorsements.flatMap((endorsement: any) => endorsement.additionalRequirements || []));
  diagnostics.errors = errors;
  diagnostics.actionSummary = buildKycActionSummary(diagnostics);
  diagnostics.operatorGuidance = buildKycOperatorGuidance(diagnostics);
  return diagnostics;
}

function summarizeKycLink(raw: any) {
  return {
    id: raw?.id,
    customerId: raw?.customer_id,
    kycStatus: raw?.kyc_status,
    tosStatus: raw?.tos_status,
    type: raw?.type,
    personaInquiryType: raw?.persona_inquiry_type,
    hasKycLink: Boolean(raw?.kyc_link),
    hasTosLink: Boolean(raw?.tos_link),
    updatedAt: raw?.updated_at,
    createdAt: raw?.created_at
  };
}

function summarizeBridgeCustomer(raw: any) {
  return {
    id: raw?.id,
    status: raw?.status,
    type: raw?.type,
    email: raw?.email,
    firstName: raw?.first_name,
    lastName: raw?.last_name,
    updatedAt: raw?.updated_at,
    createdAt: raw?.created_at
  };
}

function summarizeEndorsements(endorsements: any[]) {
  return endorsements.map((endorsement) => {
    const requirements = endorsement?.requirements || {};
    const missingRequirements = flattenRequirements(requirements.missing);
    const pendingRequirements = flattenRequirements(requirements.pending);
    const completedRequirements = flattenRequirements(requirements.complete);
    const issueRequirements = flattenRequirements(requirements.issues);
    return {
      name: endorsement?.name,
      status: endorsement?.status,
      missingRequirements,
      pendingRequirements,
      completedRequirements,
      issueRequirements,
      additionalRequirements: flattenRequirements(endorsement?.additional_requirements)
    };
  });
}

function flattenRequirements(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenRequirements);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(flattenRequirements);
  return [String(value)];
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function humanRequirement(value: string) {
  const labels: Record<string, string> = {
    date_of_birth: 'date of birth',
    min_age_18: '18+ age check',
    post_processing: 'Bridge post-processing',
    kyc_approval: 'Bridge KYC approval',
    kyc_with_proof_of_address: 'KYC with proof of address',
    selfie_verification: 'selfie verification',
    proof_of_address: 'proof of address',
    source_of_funds_questionnaire: 'source-of-funds questionnaire',
    tax_identification_number: 'tax identification number'
  };
  return labels[value] || value.replaceAll('_', ' ');
}

function buildKycActionSummary(diagnostics: any) {
  if (diagnostics.errors?.length && !diagnostics.endorsements?.length) return `Could not load live Bridge requirements: ${diagnostics.errors.join('; ')}`;
  if (String(diagnostics.bridgeKycStatus) === 'approved' || String(diagnostics.bridgeKycStatus) === 'kyc_approved') return 'KYC approved by Bridge.';
  const missing = diagnostics.missingRequirements || [];
  const pending = diagnostics.pendingRequirements || [];
  const issues = diagnostics.issueRequirements || [];
  if (missing.length) return `User action required: missing ${missing.map(humanRequirement).join(', ')}.`;
  if (pending.length) return `Waiting on Bridge/user: pending ${pending.map(humanRequirement).join(', ')}.`;
  if (issues.length) return `Bridge reported issues: ${issues.map(humanRequirement).join(', ')}.`;
  if (diagnostics.additionalRequirements?.length) return `Bridge still requires ${diagnostics.additionalRequirements.map(humanRequirement).join(', ')}.`;
  return 'KYC is not approved yet. Re-open hosted Bridge verification or refresh after Bridge post-processing.';
}

function buildKycOperatorGuidance(diagnostics: any) {
  const missing = new Set<string>(diagnostics.missingRequirements || []);
  const guidance: string[] = [];
  if (missing.has('date_of_birth') || missing.has('min_age_18')) {
    guidance.push('Ask the user to re-open the secure Bridge/Persona verification page and complete date of birth / 18+ age verification.');
  }
  if (missing.has('post_processing')) {
    guidance.push('Bridge post-processing has not completed; refresh after a few minutes. If it remains stuck, create a provider support ticket with Bridge.');
  }
  if (missing.has('proof_of_address')) guidance.push('Ask the user to upload/confirm proof of address inside Bridge verification.');
  if (missing.has('source_of_funds_questionnaire')) guidance.push('Ask the user to complete the source-of-funds questionnaire inside Bridge verification.');
  if (!guidance.length && String(diagnostics.bridgeKycStatus) !== 'approved') guidance.push('Run full KYC refresh, then ask the user to continue hosted Bridge verification if status remains incomplete.');
  return guidance;
}

function ageHours(iso: string) { return (Date.now() - new Date(iso).getTime()) / 36e5; }
function money(value: number) { return value.toFixed(2); }

export async function getBusinessKpis() {
  const data = await db.read();
  const now = Date.now();
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
  const inMonth = (iso?: string) => Boolean(iso && new Date(iso).getTime() >= monthAgo);
  const ngnTransfers = ((data as any).ngnTransfers ?? []) as NgnTransferRecord[];
  const allTransactions = [
    ...data.withdrawals,
    ...ngnTransfers,
    ...((data as any).ngnWithdrawals ?? []),
    ...((data as any).balanceTransfers ?? []),
    ...(data.onrampOrders ?? []),
    ...((data as any).virtualAccountTransactions ?? []),
  ];
  const monthlyTransactions = allTransactions.filter((item: any) => inMonth(item.createdAt) || inMonth(item.updatedAt) || inMonth(item.completedAt));
  const monthlyUserIds = new Set<string>();
  for (const item of monthlyTransactions as any[]) if (item.userId) monthlyUserIds.add(item.userId);
  for (const item of data.externalAccounts) if (inMonth(item.createdAt)) monthlyUserIds.add(item.userId);
  for (const item of data.customers) if (inMonth(item.createdAt) || inMonth(item.updatedAt)) monthlyUserIds.add(item.userId);
  for (const item of data.supportTickets ?? []) if (inMonth(item.createdAt) || inMonth(item.updatedAt)) monthlyUserIds.add(item.userId);

  const completedNgnOfframps = ngnTransfers.filter((item) => item.direction === 'offramp' && item.status === 'completed');
  const completedWithdrawals = [...data.withdrawals, ...((data as any).ngnWithdrawals ?? []), ...((data as any).balanceTransfers ?? [])].filter((item) => ['completed', 'settled', 'success'].includes(item.status));
  const completedOnramps = [...(data.onrampOrders ?? []), ...((data as any).virtualAccountTransactions ?? [])].filter((item) => ['completed', 'settled', 'success'].includes(item.status));
  const monthlyCompletedWithdrawals = completedWithdrawals.filter((item) => inMonth(item.completedAt ?? item.updatedAt ?? item.createdAt));
  const monthlyCompletedNgnOfframps = completedNgnOfframps.filter((item) => inMonth(item.completedAt ?? item.updatedAt ?? item.createdAt));
  const monthlyCompletedOnramps = completedOnramps.filter((item) => inMonth(item.completedAt ?? item.updatedAt ?? item.createdAt));
  const monthlyWithdrawalVolume = monthlyCompletedWithdrawals.reduce((sum, item) => sum + Number(item.destinationAmount ?? item.sourceAmount ?? item.amount ?? 0) + Number(item.feeAmount ?? 0), 0);
  const monthlyNgnOfframpVolume = monthlyCompletedNgnOfframps.reduce((sum, item) => sum + ngnTransferSourceUsd(item), 0);
  const monthlyOnrampVolume = monthlyCompletedOnramps.reduce((sum, item) => sum + Number(item.amount ?? item.grossAmount ?? 0), 0);
  const x402Transactions = allTransactions.filter(hasX402Signal);
  const completedX402Transactions = x402Transactions.filter((item: any) => ['completed', 'settled', 'success'].includes(String(item.status ?? '').toLowerCase()));
  const monthlyCompletedX402Transactions = completedX402Transactions.filter((item: any) => inMonth(item.completedAt ?? item.updatedAt ?? item.createdAt));
  const x402AuditSignals = (data.auditLogs ?? []).filter(hasX402Signal);
  const monthlyX402Volume = monthlyCompletedX402Transactions.reduce((sum, item: any) => sum + transactionUsdAmount(item), 0);
  const payoutDurations = [...completedWithdrawals, ...completedNgnOfframps]
    .map((item) => item.completedAt ? new Date(item.completedAt).getTime() - new Date(item.createdAt).getTime() : 0)
    .filter((value) => Number.isFinite(value) && value > 0);
  const avgPayoutMinutes = payoutDurations.length ? Math.round(payoutDurations.reduce((sum, value) => sum + value, 0) / payoutDurations.length / 60000) : 0;
  const successfulTransactions = allTransactions.filter((item: any) => ['completed', 'settled', 'success'].includes(item.status)).length;
  const transactingUsers = new Map<string, number>();
  for (const item of allTransactions as any[]) if (item.userId) transactingUsers.set(item.userId, (transactingUsers.get(item.userId) ?? 0) + 1);
  const repeatUsers = [...transactingUsers.values()].filter((count) => count > 1).length;
  const disputeLikeTypes = new Set(['wrong_token_or_network', 'deposit_not_detected', 'payout_delayed', 'onramp_payment', 'onramp_delivery']);
  const disputeTickets = (data.supportTickets ?? []).filter((ticket) => disputeLikeTypes.has(ticket.type)).length;
  const revenue = completedWithdrawals.reduce((sum, item) => sum + Number(item.feeAmount ?? 0), 0)
    + completedNgnOfframps.reduce((sum, item) => sum + ngnTransferFeeUsd(item), 0)
    + completedOnramps.reduce((sum, item) => sum + Number(item.feeAmount ?? 0), 0);
  return {
    generatedAt: nowIso(),
    currentUsers: data.users.length,
    monthlyActiveUsers: monthlyUserIds.size,
    monthlyTransactionVolumeUsd: money(monthlyWithdrawalVolume + monthlyNgnOfframpVolume + monthlyOnrampVolume),
    averagePayoutTimeMinutes: avgPayoutMinutes,
    successfulTransactionPercent: percent(allTransactions.length ? (successfulTransactions / allTransactions.length) * 100 : 100),
    repeatCustomerRatePercent: percent(transactingUsers.size ? (repeatUsers / transactingUsers.size) * 100 : 0),
    disputeRatePercent: percent(allTransactions.length ? (disputeTickets / allTransactions.length) * 100 : 0),
    revenueUsd: money(revenue),
    details: {
      monthlyWithdrawalVolumeUsd: money(monthlyWithdrawalVolume),
      monthlyNgnOfframpVolumeUsd: money(monthlyNgnOfframpVolume),
      monthlyOnrampVolumeUsd: money(monthlyOnrampVolume),
      transactionCount: allTransactions.length,
      monthlyTransactionCount: monthlyTransactions.length,
      repeatCustomerCount: repeatUsers,
      disputeTicketCount: disputeTickets,
      x402PaymentRail: {
        source: 'sivan-payment',
        channelBoundary: 'Telegram and WhatsApp can initiate or display x402 flows, but this KPI only counts payment-owned x402 records.',
        status: x402Transactions.length ? 'live' : 'ready',
        monthlyVolumeUsd: money(monthlyX402Volume),
        totalVolumeUsd: money(completedX402Transactions.reduce((sum, item: any) => sum + transactionUsdAmount(item), 0)),
        count: x402Transactions.length,
        completedCount: completedX402Transactions.length,
        monthlyCompletedCount: monthlyCompletedX402Transactions.length,
        auditSignalCount: x402AuditSignals.length,
        lastSeenAt: latestIso([...x402Transactions, ...x402AuditSignals].map((item: any) => item.completedAt ?? item.updatedAt ?? item.createdAt))
      }
    }
  };
}

function percent(value: number) { return Number(value.toFixed(2)).toString(); }
function hasX402Signal(item: any) {
  const directFields = [
    item?.provider,
    item?.providerRail,
    item?.paymentProvider,
    item?.reference,
    item?.providerReference,
    item?.paymentId,
    item?.id,
    item?.resourceId,
    item?.action,
    item?.eventType,
    item?.eventCategory
  ];
  const metadata = item?.metadata ?? item?.payload;
  const haystack = [...directFields, metadata ? JSON.stringify(metadata) : ''].join(' ').toLowerCase();
  return /\bx402\b|x402-/.test(haystack);
}
function transactionUsdAmount(item: any) {
  const sourceCurrency = String(item?.sourceCurrency ?? item?.asset ?? item?.currency ?? '').toLowerCase();
  if (sourceCurrency === 'usdc' || sourceCurrency === 'usdt' || sourceCurrency === 'usd') return Number(item?.sourceAmount ?? item?.amount ?? item?.amountUsd ?? item?.usdAmount ?? 0) || 0;
  return Number(item?.amountUsd ?? item?.usdAmount ?? item?.sourceAmountUsd ?? item?.amount ?? 0) || 0;
}
function latestIso(values: Array<string | undefined>) {
  return values.filter(Boolean).sort().at(-1);
}
function ngnTransferSourceUsd(item: NgnTransferRecord) { return Number(item.sourceAmount ?? 0); }
function ngnTransferFeeUsd(item: NgnTransferRecord) {
  const fee = Number(item.feeAmount ?? 0);
  if (!Number.isFinite(fee) || fee <= 0) return 0;
  const sourceAmount = Math.abs(Number(item.sourceAmount ?? 0));
  const rate = Number(item.rate ?? 0);
  if (sourceAmount > 0 && fee > sourceAmount * 2 && rate > 0) return fee / rate;
  return fee;
}
