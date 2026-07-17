import { z } from 'zod';
import { db } from '../database/json-database.js';
import { createAuditLog } from '../audit/audit.service.js';
import { badRequest, notFound } from '../shared/errors.js';
import { nowIso } from '../shared/id.js';
import { getAdminFeeSettings } from './admin-fees.service.js';
import { getLimitControls } from './admin-ops.service.js';
import { providerCapabilities } from '../providers/provider-routing.js';

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
  const results = [
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
  const data = await db.read();
  return (data.auditLogs ?? [])
    .filter((log) => log.action === 'admin.user_restricted' || log.action === 'admin.user_unrestricted')
    .filter((log) => !userId || log.resourceId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
  const completedWithdrawals = data.withdrawals.filter((item) => item.status === 'completed');
  const completedOnramps = (data.onrampOrders ?? []).filter((item) => item.status === 'completed');
  const offrampGross = completedWithdrawals.reduce((sum, item) => sum + Number(item.destinationAmount ?? item.sourceAmount ?? 0) + Number(item.feeAmount ?? 0), 0);
  const onrampGross = completedOnramps.reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
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
      { provider: 'bridge', currency: 'USD', status: 'not_connected', availableBalance: null, ledgerBalance: null, note: 'Balance API not connected yet; reconcile against Bridge dashboard/invoices.' }
    ],
    treasuryBalances: [
      { account: 'operating', currency: 'USD', status: 'manual_required', balance: null, note: 'Connect bank/treasury API or manual upload.' }
    ],
    limitControls: limits,
    findings: [
      ...(completedWithdrawals.length ? [] : [{ severity: 'info', message: 'No completed withdrawals in current data window.' }]),
      { severity: 'warning', message: 'Provider invoice/balance API is not connected; values are estimates until invoice import is enabled.' }
    ]
  };
}

export async function getDocumentVerificationQueue() {
  const data = await db.read();
  return data.customers.map((customer) => ({
    id: customer.id,
    userId: customer.userId,
    provider: customer.provider,
    providerCustomerId: customer.providerCustomerId,
    customerType: customer.customerType,
    kycStatus: customer.kycStatus,
    tosStatus: customer.tosStatus,
    documents: extractDocumentEvidence(customer.raw),
    updatedAt: customer.updatedAt
  })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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

function ageHours(iso: string) { return (Date.now() - new Date(iso).getTime()) / 36e5; }
function money(value: number) { return value.toFixed(2); }
