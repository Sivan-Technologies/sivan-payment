import { z } from 'zod';
import { db } from '../database/json-database.js';
import type { AuditLogRecord, OnrampOrderRecord, SupportTicketRecord, WithdrawalRecord } from '../database/types.js';
import { createAuditLog } from '../audit/audit.service.js';
import { badRequest, notFound } from '../shared/errors.js';
import { id, nowIso } from '../shared/id.js';
import { updatePaymentControls } from '../controls/payment-controls.service.js';
import { updateSystemStatus } from '../system/system-status.service.js';
import { getTransactionTrace, syncPaymentTransactionReferencesForResource } from '../references/transaction-references.service.js';
import { listSupplierRiskCases } from '../suppliers/supplier.service.js';

export const adminNoteSchema = z.object({
  resourceType: z.string().min(1),
  resourceId: z.string().min(1),
  note: z.string().min(3).max(4000),
  visibility: z.enum(['internal', 'compliance', 'finance', 'engineering']).default('internal'),
  reason: z.string().max(500).optional()
});

export const riskReviewSchema = z.object({
  status: z.enum(['reviewed', 'false_positive', 'escalated', 'restricted', 'closed']),
  note: z.string().min(3).max(2000),
  reviewedBy: z.string().min(2).default('admin_api_key')
});

export const approvalRequestSchema = z.object({
  action: z.enum([
    'controls.update',
    'system_status.update',
    'fee_change.request',
    'admin_user_change.request',
    'manual_status_change.request',
    'refund_recovery.request',
    // Reprovisioning provisions a NEW virtual account at the provider. The old
    // one keeps accepting deposits (Bridge has no "close" that we call), and a
    // USD virtual account bills $2/month. On 2026-07-29 a single request ended
    // up with 16 live Bridge accounts for one user. It is a money-moving action
    // and now requires a second admin.
    'virtual_account.reprovision'
  ]),
  resourceType: z.string().min(1),
  resourceId: z.string().optional(),
  reason: z.string().min(5).max(2000),
  requestedBy: z.string().min(2).default('admin_api_key'),
  requestedChange: z.record(z.string(), z.unknown()),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']).default('high')
});

export const approvalReviewSchema = z.object({
  reviewer: z.string().min(2),
  reason: z.string().min(3).max(2000),
  apply: z.boolean().default(true),
  /**
   * The signed-in admin's ROLE, set by the route from the authenticated
   * session - never from the request body.
   *
   * A client-supplied role would make separation of duties self-certifying:
   * anyone could post `reviewerRole: 'superadmin'` and approve their own
   * request. admin.routes.ts overwrites this from `request.adminActor`, which
   * app.ts populates from the x-sivan-admin-role header behind the admin key.
   */
  reviewerRole: z.string().trim().toLowerCase().optional(),
});

/**
 * Normalise an admin identity for maker-checker comparison.
 *
 * Identities arrive from several places (authenticated admin email, admin role,
 * or a free-text name typed into the review form). Comparing them raw allowed
 * the same human to act as both maker and checker simply by changing case,
 * padding, or by typing a different label than the one the UI submitted.
 */
function normaliseAdminIdentity(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/** Identities that never represent a specific human and so can never satisfy separation of duties. */
const NON_ATTRIBUTABLE_IDENTITIES = new Set(['', 'admin_api_key', 'admin', 'ops', 'unknown', 'system']);

/**
 * Roles permitted to approve their OWN request.
 *
 * A set rather than `role === 'superadmin'` so 'owner' - which app.ts already
 * treats as equivalent everywhere else - does not silently behave differently
 * here.
 */
const SELF_APPROVAL_ROLES = new Set(['superadmin', 'owner']);

/**
 * Actions that still require two people, even from a superadmin.
 *
 * The dividing line is REVERSIBILITY, not importance. Turning a network off is
 * undone by turning it back on; a refund is not undone by regretting it. These
 * four move money or grant access, so they keep the control that stops one
 * compromised or mistaken account acting alone.
 */
const HIGH_RISK_ACTIONS = new Set([
  'refund_recovery.request',
  'manual_status_change.request',
  'admin_user_change.request',
  'virtual_account.reprovision',
]);

/**
 * Changes that no longer need an approval request at all.
 *
 * "this is a control settings no need for a maker" - agreed, for the two
 * actions whose entire content is a reversible setting. Requiring a
 * maker-checker dance to flip a chain off makes the queue noisy, and a noisy
 * approval queue is one nobody reads - which costs more safety than it buys.
 *
 * Deliberately a small, explicit list. Everything absent from it still routes
 * through approvals, so adding a money-moving action here has to be a
 * deliberate edit rather than an accident of category.
 */
export const APPROVAL_EXEMPT_ACTIONS = new Set(['controls.update', 'system_status.update']);

function isAttributableIdentity(value: string): boolean {
  return !NON_ATTRIBUTABLE_IDENTITIES.has(value);
}

export const limitControlsSchema = z.object({
  newUserDailyLimitUsd: z.coerce.number().positive().default(500),
  verifiedUserDailyLimitUsd: z.coerce.number().positive().default(5000),
  businessDailyLimitUsd: z.coerce.number().nonnegative().default(0),
  minTransactionAmountUsd: z.coerce.number().positive().default(10),
  maxOnrampAmountUsd: z.coerce.number().positive().default(5000),
  maxOfframpAmountUsd: z.coerce.number().positive().default(5000),
  highValueApprovalThresholdUsd: z.coerce.number().positive().default(10000),
  monthlyUserLimitUsd: z.coerce.number().positive().default(25000),
  updatedBy: z.string().min(2).default('admin_api_key'),
  reason: z.string().min(3).max(1000).default('Update transaction limits')
});

const defaultLimitControls = {
  newUserDailyLimitUsd: 500,
  verifiedUserDailyLimitUsd: 5000,
  businessDailyLimitUsd: 0,
  minTransactionAmountUsd: 10,
  maxOnrampAmountUsd: 5000,
  maxOfframpAmountUsd: 5000,
  highValueApprovalThresholdUsd: 10000,
  monthlyUserLimitUsd: 25000,
  updatedBy: 'system',
  updatedAt: nowIso()
};

export async function getAdminUserDetails(userId: string) {
  const data = await db.read();
  const user = data.users.find((item) => item.id === userId);
  if (!user) throw notFound('User');
  const customer = data.customers.find((item) => item.userId === user.id) ?? null;
  const externalAccounts = data.externalAccounts.filter((item) => item.userId === user.id);
  const withdrawals = data.withdrawals.filter((item) => item.userId === user.id).sort(descCreated);
  const onrampOrders = (data.onrampOrders ?? []).filter((item) => item.userId === user.id).sort(descCreated);
  const supportTickets = (data.supportTickets ?? []).filter((item) => item.userId === user.id).sort(descCreated);
  const legalAcceptances = (data.legalAcceptances ?? []).filter((item) => item.userId === user.id).sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
  const auditTimeline = (data.auditLogs ?? []).filter((log) => log.actorId === user.id || log.resourceId === user.id || String((log.metadata as any)?.userId ?? '') === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
  return {
    user,
    customer,
    legalAcceptances,
    externalAccounts,
    withdrawals,
    onrampOrders,
    supportTickets,
    riskFlags: buildUserRiskFlags(data, user.id),
    notes: getNotes(data.auditLogs ?? [], 'user', user.id),
    auditTimeline
  };
}

export async function getAdminWithdrawalDetails(withdrawalId: string) {
  const data = await db.read();
  const withdrawal = data.withdrawals.find((item) => item.id === withdrawalId);
  if (!withdrawal) throw notFound('Withdrawal');
  const user = data.users.find((item) => item.id === withdrawal.userId) ?? null;
  const customer = data.customers.find((item) => item.id === withdrawal.customerId) ?? null;
  const externalAccount = data.externalAccounts.find((item) => item.id === withdrawal.externalAccountId) ?? null;
  const liquidationAddress = data.liquidationAddresses.find((item) => item.id === withdrawal.liquidationAddressId) ?? null;
  const webhooks = (data.webhookEvents ?? []).filter((event) => event.eventObjectId === withdrawal.providerDrainId || event.eventObjectId === liquidationAddress?.providerLiquidationAddressId || JSON.stringify(event.payload ?? {}).includes(withdrawal.providerDrainId ?? liquidationAddress?.providerLiquidationAddressId ?? withdrawal.id)).sort(descCreated);
  const supportTickets = (data.supportTickets ?? []).filter((ticket) => ticket.resourceId === withdrawal.id || ticket.userId === withdrawal.userId).sort(descCreated);
  const reconciliationFindings = (data.reconciliationFindings ?? []).filter((finding) => finding.withdrawalId === withdrawal.id || finding.liquidationAddressId === withdrawal.liquidationAddressId || finding.providerDrainId === withdrawal.providerDrainId).sort(descCreated);
  await syncPaymentTransactionReferencesForResource('withdrawal', withdrawal);
  const transactionTrace = await getTransactionTrace('withdrawal', withdrawal.id);
  return {
    transactionTrace,
    withdrawal,
    user,
    customer,
    externalAccount,
    liquidationAddress,
    webhooks,
    supportTickets,
    reconciliationFindings,
    economics: estimateWithdrawalEconomics(withdrawal),
    timeline: buildWithdrawalTimeline(withdrawal, webhooks),
    notes: getNotes(data.auditLogs ?? [], 'withdrawal', withdrawal.id),
    raw: withdrawal.raw ?? liquidationAddress?.raw
  };
}

export async function getAdminOnrampOrderDetails(orderId: string) {
  const data = await db.read();
  const order = (data.onrampOrders ?? []).find((item) => item.id === orderId);
  if (!order) throw notFound('On-ramp order');
  const user = data.users.find((item) => item.id === order.userId) ?? null;
  const customer = data.customers.find((item) => item.id === order.customerId) ?? null;
  const webhooks = (data.webhookEvents ?? []).filter((event) => event.eventObjectId === order.providerTransferId || JSON.stringify(event.payload ?? {}).includes(order.providerTransferId ?? order.id)).sort(descCreated);
  const supportTickets = (data.supportTickets ?? []).filter((ticket) => ticket.resourceId === order.id || ticket.userId === order.userId).sort(descCreated);
  await syncPaymentTransactionReferencesForResource('onramp_order', order);
  const transactionTrace = await getTransactionTrace('onramp_order', order.id);
  return {
    transactionTrace,
    order,
    user,
    customer,
    webhooks,
    supportTickets,
    timeline: buildOnrampTimeline(order, webhooks),
    notes: getNotes(data.auditLogs ?? [], 'onramp_order', order.id),
    raw: order.raw,
    receipt: order.receipt
  };
}

export async function listRiskCases(options: { status?: string; severity?: string } = {}) {
  /**
   * SIX TABLES, NOT FORTY.
   *
   * Reported from the console:
   *   GET /api/admin/payment/api/admin/risk/cases 503 (Service Unavailable)
   *
   * Measured rather than guessed - the endpoint is not broken, it is SLOW:
   *   direct to the API   7.4s, 7.7s, 7.9s
   *   through the proxy   8.1s, 8.4s
   * all returning 200. The 503 is a proxy giving up, and on a cold Render
   * instance the same call goes past every timeout in front of it.
   *
   * The cause was `db.read()`, which issues ~40 sequential `select *` queries -
   * one per table, including the ENTIRE audit log - to build a page that reads
   * six of them. buildRiskCases touches customers, withdrawals, onrampOrders,
   * supportTickets and externalAccounts; getRiskReviews wants exactly one
   * action out of the audit log.
   *
   * So: fetch those six, in parallel, and pull the review rows through the
   * indexed action query that already exists. The audit log is the important
   * one - it is the table that grows without bound, so a `select *` against it
   * gets slower every day the platform runs.
   */
  const [customers, withdrawals, onrampOrders, supportTickets, externalAccounts, reviewLogs] = await Promise.all([
    db.listCustomers(),
    db.listWithdrawals(),
    db.listOnrampOrders(),
    db.listSupportTickets(),
    db.listExternalAccounts(),
    db.listAuditLogsByActions(['risk.case_reviewed']),
  ]);

  const data = { customers, withdrawals, onrampOrders, supportTickets, externalAccounts };
  const reviews = getRiskReviews(reviewLogs);
  const coreCases = buildRiskCases(data).map((riskCase) => ({ ...riskCase, review: reviews.get(riskCase.id) ?? null, status: reviews.get(riskCase.id)?.status ?? 'open' }));
  const supplierCases = await listSupplierRiskCases();
  const cases = [...coreCases, ...supplierCases];
  return cases
    .filter((item) => !options.status || item.status === options.status)
    .filter((item) => !options.severity || item.severity === options.severity)
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.createdAt.localeCompare(a.createdAt));
}

export async function reviewRiskCase(caseId: string, input: z.infer<typeof riskReviewSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const cases = await listRiskCases();
  const riskCase = cases.find((item) => item.id === caseId);
  if (!riskCase) throw notFound('Risk case');
  await createAuditLog({
    actorType: 'admin',
    actorId: input.reviewedBy,
    action: 'risk.case_reviewed',
    resourceType: 'risk_case',
    resourceId: caseId,
    severity: input.status === 'restricted' || input.status === 'escalated' ? 'warning' : 'info',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { caseId, status: input.status, note: input.note, riskCase }
  });
  return { ...riskCase, review: { ...input, reviewedAt: nowIso() }, status: input.status };
}

export async function addAdminNote(input: z.infer<typeof adminNoteSchema>, context: { ipAddress?: string; userAgent?: string; actorId?: string } = {}) {
  await createAuditLog({
    actorType: 'admin',
    actorId: context.actorId ?? 'admin_api_key',
    action: 'admin.note_added',
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    severity: input.visibility === 'compliance' ? 'warning' : 'info',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { note: input.note, visibility: input.visibility, reason: input.reason }
  });
  return { ok: true };
}

export async function listApprovalRequests() {
  const data = await db.read();
  const logs = data.auditLogs ?? [];
  const requests = logs.filter((log) => log.action === 'admin.approval_requested').map((log) => {
    const review = logs.find((item) => ['admin.approval_approved', 'admin.approval_rejected'].includes(item.action) && (item.metadata as any)?.approvalId === log.resourceId);
    return {
      id: log.resourceId,
      status: review ? (review.action === 'admin.approval_approved' ? 'approved' : 'rejected') : 'pending',
      requestedAt: log.createdAt,
      requestedBy: log.actorId,
      request: log.metadata,
      review: review ? { reviewedAt: review.createdAt, reviewer: review.actorId, ...((review.metadata as any) ?? {}) } : null
    };
  });
  return requests.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

export async function createApprovalRequest(input: z.infer<typeof approvalRequestSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const approvalId = id('apr');
  await createAuditLog({
    actorType: 'admin',
    actorId: input.requestedBy,
    action: 'admin.approval_requested',
    resourceType: 'admin_approval_request',
    resourceId: approvalId,
    severity: input.riskLevel === 'critical' ? 'error' : 'warning',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: input
  });
  return { id: approvalId, status: 'pending', request: input };
}

export async function approveRequest(approvalId: string, input: z.infer<typeof approvalReviewSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const requests = await listApprovalRequests();
  const request = requests.find((item) => item.id === approvalId);
  if (!request) throw notFound('Approval request');
  // Names the current status. "No longer pending" leaves an admin wondering
  // whether it was approved, rejected, or applied by someone else - and the
  // list they are looking at may simply be stale.
  if (request.status !== 'pending') {
    throw badRequest(
      `This request is already "${request.status}" and cannot be reviewed again. Refresh the queue to see its outcome.`,
      { approvalId, status: request.status, reason: 'not_pending' }
    );
  }

  // --- Separation of duties -------------------------------------------------
  // Compare every identity we know about for the maker against the checker, so
  // a single admin cannot approve their own request by relabelling themselves.
  const makerIdentities = [
    (request.request as any)?.requestedBy,
    (request.request as any)?.requestedByEmail,
    (request as any).requestedBy
  ].map(normaliseAdminIdentity).filter(Boolean);

  const checkerIdentity = normaliseAdminIdentity(input.reviewer);

  /**
   * SAY WHICH RULE REFUSED, AND WHO THE MAKER WAS.
   *
   * Reported from live: POST /approvals/:id/approve returns 400 and the admin
   * cannot tell why. Five different conditions produce a 400 here - not
   * pending, unattributable checker, maker == checker, a failed apply, and
   * schema validation - and the messages did not distinguish the two that an
   * admin can actually do something about.
   *
   * "Maker and checker must be different admins" is correct but useless
   * without naming the maker: the checker is signed in as themselves and has
   * no way to see who raised the request, so the natural reading is that the
   * system is broken rather than that they are the wrong person to approve it.
   *
   * `details` carries the identities for support; the message names the maker
   * because that is the one fact that resolves it.
   */
  if (!isAttributableIdentity(checkerIdentity)) {
    throw badRequest(
      `Checker "${input.reviewer}" is not a specific named admin, so it cannot satisfy separation of duties. `
      + 'Sign in with your own admin account - generic identities such as "ops", "admin" or "admin_api_key" are refused.',
      { checker: checkerIdentity, reason: 'checker_not_attributable' }
    );
  }
  /**
   * SELF-APPROVAL, ALLOWED FOR A SUPERADMIN ONLY.
   *
   * Reported: apr_3787d617 was "Disable ETHEREUM for network controls", raised
   * and reviewed by sup_ola - the only admin account that exists - and refused
   * with maker_equals_checker. Twice, from the console. The rule was correct
   * and the product was unusable: with one admin, EVERY approval is
   * permanently unapprovable, which is not a control, it is a deadlock.
   *
   * The requested behaviour: "sup_ola is the super admin so one request should
   * turn it off... no need for two user admin and this is a control settings".
   *
   * Two thirds of that is implemented, and one third deliberately is not.
   *
   *   DONE - a superadmin may approve their own request.
   *   DONE - approvals are no longer required for reversible control changes
   *          (see APPROVAL_EXEMPT_ACTIONS below).
   *   NOT DONE - removing maker-checker outright. It still binds every other
   *          role, and it still binds a superadmin on the actions that move
   *          money: refunds, recoveries, manual status changes and admin-user
   *          changes. Deleting it for everyone would remove the only control
   *          preventing one compromised or mistaken account from paying itself
   *          out, and that is a different thing from unblocking a config flag.
   *
   * Recorded as `selfApproved: true` on the audit log rather than passed over
   * in silence, so the weakened control is visible to anyone reviewing later.
   */
  const checkerIsSuperadmin = SELF_APPROVAL_ROLES.has(String(input.reviewerRole ?? '').trim().toLowerCase());
  const selfApproved = makerIdentities.includes(checkerIdentity);

  if (selfApproved && !checkerIsSuperadmin) {
    const maker = makerIdentities[0] ?? 'the same admin';
    throw badRequest(
      `You raised this request (as "${maker}"), so you cannot also approve it. `
      + 'A DIFFERENT admin must review it, or a superadmin can approve it directly.',
      { maker, checker: checkerIdentity, reason: 'maker_equals_checker' }
    );
  }

  if (selfApproved && HIGH_RISK_ACTIONS.has(String((request.request as any)?.action ?? ''))) {
    /**
     * THE LINE A SUPERADMIN DOES NOT CROSS ALONE.
     *
     * A config flag is reversible in one click and its blast radius is a
     * setting. A refund, a recovery, a manual status change or an admin-user
     * change moves money or grants access, and neither is undone by toggling
     * it back. Those keep needing two people even for a superadmin - it is the
     * only remaining protection against one compromised account.
     */
    throw badRequest(
      `"${(request.request as any)?.action}" moves money or changes access, so it needs a second admin `
      + 'even for a superadmin. Ask another admin to review it.',
      {
        maker: makerIdentities[0],
        checker: checkerIdentity,
        action: (request.request as any)?.action,
        reason: 'high_risk_requires_second_admin',
      }
    );
  }

  let applied: unknown = undefined;
  let applyError: string | undefined;
  if (input.apply) {
    // Apply BEFORE writing the audit log. Previously a failure here still
    // recorded the request as "approved", leaving the control unchanged with
    // no indication anything had gone wrong.
    try {
      applied = await applyApprovalChange(request.request as any, input.reviewer);
    } catch (error) {
      applyError = error instanceof Error ? error.message : String(error);
      await createAuditLog({
        actorType: 'admin',
        actorId: input.reviewer,
        action: 'admin.approval_apply_failed',
        resourceType: 'admin_approval_request',
        resourceId: approvalId,
        severity: 'error',
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: { approvalId, reason: input.reason, error: applyError }
      });
      throw badRequest(`Approval could not be applied: ${applyError}`);
    }
  }
  await createAuditLog({
    actorType: 'admin',
    actorId: input.reviewer,
    action: 'admin.approval_approved',
    resourceType: 'admin_approval_request',
    resourceId: approvalId,
    severity: 'warning',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: {
      approvalId,
      reason: input.reason,
      applied: input.apply,
      result: applied,
      // Never omitted when true. A self-approval is a weakened control, and a
      // log that does not distinguish it from a two-person approval cannot be
      // used to answer "was this reviewed by anyone else".
      selfApproved,
      checkerRole: input.reviewerRole ?? null,
      maker: makerIdentities[0] ?? null,
    }
  });
  return {
    id: approvalId,
    status: 'approved',
    // `applied` is the raw result of the change; `changeApplied` states plainly
    // whether anything was actually mutated so callers/UI cannot mistake an
    // "approved but not applied" outcome for a completed change.
    applied,
    changeApplied: Boolean(input.apply),
    message: input.apply
      ? 'Approval applied. The requested change is now live.'
      : 'Approval recorded WITHOUT applying. The requested change has NOT taken effect.'
  };
}

export async function rejectRequest(approvalId: string, input: z.infer<typeof approvalReviewSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const requests = await listApprovalRequests();
  const request = requests.find((item) => item.id === approvalId);
  if (!request) throw notFound('Approval request');
  if (request.status !== 'pending') throw badRequest('Approval request is no longer pending');
  await createAuditLog({
    actorType: 'admin',
    actorId: input.reviewer,
    action: 'admin.approval_rejected',
    resourceType: 'admin_approval_request',
    resourceId: approvalId,
    severity: 'info',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { approvalId, reason: input.reason }
  });
  return { id: approvalId, status: 'rejected' };
}

export async function getLimitControls() {
  const data = await db.read();
  const latest = (data.auditLogs ?? []).filter((log) => log.action === 'limit_controls.updated').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return latest ? { ...defaultLimitControls, ...((latest.metadata as any)?.limits ?? {}), updatedBy: latest.actorId, updatedAt: latest.createdAt } : defaultLimitControls;
}

export async function updateLimitControls(input: z.infer<typeof limitControlsSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const { updatedBy, reason, ...limits } = input;
  await createAuditLog({
    actorType: 'admin',
    actorId: updatedBy,
    action: 'limit_controls.updated',
    resourceType: 'limit_controls',
    resourceId: 'global',
    severity: 'warning',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { limits, reason }
  });
  return { ...defaultLimitControls, ...limits, updatedBy, updatedAt: nowIso() };
}

export async function getLegalEvidenceSummary() {
  const data = await db.read();
  const acceptances = data.legalAcceptances ?? [];
  const byVersion = acceptances.reduce<Record<string, number>>((acc, item) => {
    const key = `${item.termsVersion} / ${item.privacyVersion} / ${item.riskDisclosureVersion}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  return { total: acceptances.length, byVersion, recent: acceptances.slice().sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt)).slice(0, 200) };
}

export async function getFinanceDashboard() {
  const data = await db.read();
  const completedWithdrawals = data.withdrawals.filter((item) => item.status === 'completed');
  const completedOnrampOrders = (data.onrampOrders ?? []).filter((item) => item.status === 'completed');
  const offrampVolume = sum(completedWithdrawals.map((item) => Number(item.destinationAmount ?? item.sourceAmount ?? 0)));
  const onrampVolume = sum(completedOnrampOrders.map((item) => Number(item.amount ?? 0)));
  const withdrawalFees = sum(completedWithdrawals.map((item) => Number(item.feeAmount ?? 0)));
  const onrampFees = sum(completedOnrampOrders.map((item) => Number(item.feeAmount ?? 0)));
  const kycKybCosts = sum(data.customers.map((item) => Number(item.onboardingCostUsd ?? 0)));
  const grossFees = withdrawalFees + onrampFees;
  const estimatedProviderVariableCost = offrampVolume * 0.005;
  return {
    generatedAt: nowIso(),
    volume: { totalUsd: money(offrampVolume + onrampVolume), offrampUsd: money(offrampVolume), onrampUsd: money(onrampVolume) },
    fees: { grossFeesUsd: money(grossFees), offrampFeesUsd: money(withdrawalFees), onrampFeesUsd: money(onrampFees) },
    costs: { providerVariableCostUsd: money(estimatedProviderVariableCost), kycKybCostsUsd: money(kycKybCosts), failedTransactionCount: data.withdrawals.filter((item) => item.status === 'failed').length + completedOnrampOrders.filter((item) => item.status === 'failed').length },
    margin: { netRevenueUsd: money(grossFees - estimatedProviderVariableCost - kycKybCosts), grossMarginUsd: money(grossFees - estimatedProviderVariableCost) },
    byCurrency: groupVolumeByCurrency(completedWithdrawals, completedOnrampOrders),
    byChain: groupVolumeByChain(data.withdrawals, data.onrampOrders ?? [])
  };
}

export async function buildExport(type: string) {
  const data = await db.read();
  const rows = (() => {
    if (type === 'users') return data.users;
    if (type === 'legal-acceptances') return data.legalAcceptances ?? [];
    if (type === 'withdrawals') return data.withdrawals;
    if (type === 'onramp-orders') return data.onrampOrders ?? [];
    if (type === 'support-tickets') return data.supportTickets ?? [];
    if (type === 'audit-logs') return data.auditLogs ?? [];
    if (type === 'reconciliation-findings') return data.reconciliationFindings ?? [];
    throw badRequest('Unsupported export type');
  })();
  return toCsv(rows as any[]);
}

async function applyApprovalChange(request: any, reviewer: string) {
  if (request.action === 'controls.update') return updatePaymentControls(request.requestedChange as any, reviewer);
  if (request.action === 'system_status.update') return updateSystemStatus(request.requestedChange as any, reviewer);
  if (request.action === 'virtual_account.reprovision') {
    const requestId = request.resourceId || (request.requestedChange as any)?.requestId;
    if (!requestId) {
      throw new Error('virtual_account.reprovision approval is missing the virtual account request id');
    }
    // Imported lazily: virtual-account.service imports admin-ops for approval
    // helpers, so a top-level import here would be circular.
    const { executeVirtualAccountReprovision } = await import(
      '../virtual-accounts/service/virtual-account.service.js'
    );
    return executeVirtualAccountReprovision(requestId, reviewer);
  }
  return { queuedOnly: true, message: 'This approval was recorded. The requested action requires manual execution by the relevant ops owner.' };
}

function buildRiskCases(data: any) {
  const now = Date.now();
  const cases: any[] = [];
  for (const customer of data.customers ?? []) {
    if (customer.kycStatus === 'kyc_rejected') cases.push(risk('kyc_rejected', 'high', customer.userId, 'customer', customer.id, 'KYC rejected', customer.updatedAt));
    if (customer.kycStatus === 'kyc_under_review' && ageHours(customer.updatedAt, now) > 48) cases.push(risk('kyc_stale_review', 'medium', customer.userId, 'customer', customer.id, 'KYC has been under review for more than 48 hours', customer.updatedAt));
  }
  for (const withdrawal of data.withdrawals ?? []) {
    if (['pending_deposit', 'deposit_received', 'payout_processing'].includes(withdrawal.status) && ageHours(withdrawal.createdAt, now) > 24) cases.push(risk('stale_withdrawal', 'high', withdrawal.userId, 'withdrawal', withdrawal.id, `Withdrawal stuck in ${withdrawal.status} for over 24 hours`, withdrawal.createdAt));
    if (withdrawal.status === 'failed') cases.push(risk('failed_withdrawal', 'high', withdrawal.userId, 'withdrawal', withdrawal.id, 'Withdrawal failed', withdrawal.updatedAt));
  }
  for (const order of data.onrampOrders ?? []) {
    if (['awaiting_payment', 'processing', 'requires_action'].includes(order.status) && ageHours(order.createdAt, now) > 24) cases.push(risk('stale_onramp', 'medium', order.userId, 'onramp_order', order.id, `On-ramp order stuck in ${order.status} for over 24 hours`, order.createdAt));
    if (order.status === 'failed') cases.push(risk('failed_onramp', 'high', order.userId, 'onramp_order', order.id, 'On-ramp order failed', order.updatedAt));
  }
  for (const ticket of data.supportTickets ?? []) {
    if (ticket.type === 'wrong_token_or_network' && !['resolved', 'closed'].includes(ticket.status)) cases.push(risk('wrong_network_ticket', 'critical', ticket.userId, 'support_ticket', ticket.id, 'Open wrong-token/wrong-network support ticket', ticket.createdAt));
  }
  addDuplicateCases(cases, data.onrampOrders ?? [], 'destinationAddress', 'duplicate_wallet_address', 'medium', 'onramp_order');
  addDuplicateCases(cases, data.externalAccounts ?? [], 'accountLast4', 'duplicate_bank_last4', 'medium', 'external_account');
  return cases;
}

function risk(type: string, severity: string, userId: string, resourceType: string, resourceId: string, title: string, createdAt: string) {
  return { id: `risk_${type}_${resourceId}`, type, severity, userId, resourceType, resourceId, title, createdAt };
}

function addDuplicateCases(cases: any[], records: any[], field: string, type: string, severity: string, resourceType: string) {
  const map = new Map<string, any[]>();
  for (const record of records) {
    const value = String(record[field] ?? '').toLowerCase();
    if (!value || value === 'undefined') continue;
    map.set(value, [...(map.get(value) ?? []), record]);
  }
  for (const [value, items] of map) {
    const userCount = new Set(items.map((item) => item.userId)).size;
    if (userCount > 1) {
      for (const item of items) cases.push(risk(type, severity, item.userId, resourceType, item.id, `Shared ${field}: ${value}`, item.createdAt));
    }
  }
}

function buildUserRiskFlags(data: any, userId: string) {
  return buildRiskCases(data).filter((item) => item.userId === userId);
}

function getRiskReviews(logs: AuditLogRecord[]) {
  const map = new Map<string, any>();
  for (const log of logs.filter((item) => item.action === 'risk.case_reviewed').sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (!map.has(log.resourceId ?? '')) map.set(log.resourceId ?? '', { ...((log.metadata as any) ?? {}), reviewedBy: log.actorId, reviewedAt: log.createdAt });
  }
  return map;
}

function getNotes(logs: AuditLogRecord[], resourceType: string, resourceId: string) {
  return logs.filter((log) => log.action === 'admin.note_added' && log.resourceType === resourceType && log.resourceId === resourceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((log) => ({ id: log.id, actorId: log.actorId, createdAt: log.createdAt, ...((log.metadata as any) ?? {}) }));
}

function buildWithdrawalTimeline(withdrawal: WithdrawalRecord, webhooks: any[]) {
  return [
    { label: 'Created', at: withdrawal.createdAt, done: true },
    { label: 'Deposit address issued', at: withdrawal.createdAt, done: true },
    { label: 'Provider webhook received', at: webhooks[0]?.createdAt, done: webhooks.length > 0 },
    { label: 'Deposit received', at: withdrawal.depositTxHash ? withdrawal.updatedAt : undefined, done: Boolean(withdrawal.depositTxHash) },
    { label: 'Payout processing', at: ['payout_processing', 'completed'].includes(withdrawal.status) ? withdrawal.updatedAt : undefined, done: ['payout_processing', 'completed'].includes(withdrawal.status) },
    { label: 'Completed', at: withdrawal.completedAt, done: withdrawal.status === 'completed' }
  ];
}

function buildOnrampTimeline(order: OnrampOrderRecord, webhooks: any[]) {
  return [
    { label: 'Created', at: order.createdAt, done: true },
    { label: 'Awaiting payment', at: order.createdAt, done: true },
    { label: 'Provider webhook received', at: webhooks[0]?.createdAt, done: webhooks.length > 0 },
    { label: 'Processing', at: ['processing', 'completed'].includes(order.status) ? order.updatedAt : undefined, done: ['processing', 'completed'].includes(order.status) },
    { label: 'Completed', at: order.completedAt, done: order.status === 'completed' }
  ];
}

function estimateWithdrawalEconomics(withdrawal: WithdrawalRecord) {
  const volume = Number(withdrawal.destinationAmount ?? withdrawal.sourceAmount ?? 0);
  const fee = Number(withdrawal.feeAmount ?? 0);
  const providerCost = volume * 0.005;
  return { volumeUsd: money(volume), sivanFeeUsd: money(fee), providerCostUsd: money(providerCost), estimatedNetRevenueUsd: money(fee - providerCost) };
}

function groupVolumeByCurrency(withdrawals: WithdrawalRecord[], orders: OnrampOrderRecord[]) {
  const out: Record<string, number> = {};
  for (const item of withdrawals) out[item.destinationCurrency] = (out[item.destinationCurrency] ?? 0) + Number(item.destinationAmount ?? item.sourceAmount ?? 0);
  for (const item of orders) out[item.sourceCurrency] = (out[item.sourceCurrency] ?? 0) + Number(item.amount ?? 0);
  return Object.fromEntries(Object.entries(out).map(([key, value]) => [key, money(value)]));
}

function groupVolumeByChain(withdrawals: WithdrawalRecord[], orders: OnrampOrderRecord[]) {
  const out: Record<string, number> = {};
  for (const item of withdrawals) out[item.raw ? String((item.raw as any)?.chain ?? 'unknown') : 'unknown'] = (out[item.raw ? String((item.raw as any)?.chain ?? 'unknown') : 'unknown'] ?? 0) + Number(item.destinationAmount ?? item.sourceAmount ?? 0);
  for (const item of orders) out[item.destinationChain] = (out[item.destinationChain] ?? 0) + Number(item.amount ?? 0);
  return Object.fromEntries(Object.entries(out).map(([key, value]) => [key, money(value)]));
}

function toCsv(rows: Record<string, any>[]) {
  if (!rows.length) return '';
  const keySet = rows.reduce<Set<string>>((set, row) => { Object.keys(row).forEach((key) => set.add(key)); return set; }, new Set<string>());
  const keys = Array.from(keySet);
  return [keys.join(','), ...rows.map((row) => keys.map((key) => csvCell(row[key])).join(','))].join('\n');
}

function csvCell(value: unknown) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function ageHours(iso: string, now = Date.now()) { return (now - new Date(iso).getTime()) / 36e5; }
function severityRank(value: string) { return { info: 1, low: 1, medium: 2, warning: 2, high: 3, error: 3, critical: 4 }[value] ?? 0; }
function descCreated(a: { createdAt: string }, b: { createdAt: string }) { return b.createdAt.localeCompare(a.createdAt); }
function sum(values: number[]) { return values.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0); }
function money(value: number) { return value.toFixed(2); }
