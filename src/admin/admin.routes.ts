import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody } from '../shared/validation.js';
import { adminChangeUsername, adminChangeUsernameSchema, adminEmailChangeRequestSchema, adminRemoveAvatar, adminRemoveAvatarSchema, adminNameCorrectionRequestSchema, adminRequestNameCorrection, adminResetTwoFactor, adminResetTwoFactorSchema, adminStartEmailChange, adminUnlinkWhatsapp, adminUnlinkWhatsappSchema, getAccountRecoveryControls } from './account-recovery.service.js';
import { getAdminOverview, listAdminUsers, listAdminWebhookEvents, listAdminWithdrawals, listAdminAuditLogs, listAdminReconciliationRuns, listAdminOnrampOrders } from './admin.service.js';
import { getAdminAnalytics } from './analytics.service.js';
import { runOfframpReconciliation } from '../reconciliation/reconciliation.service.js';
import { buildReferenceReconciliationDashboard, persistReferenceReconciliationRun } from '../reconciliation/reference-reconciliation.service.js';
import { getWithdrawal, syncWithdrawalDrains } from '../offramp/service/withdrawals.service.js';
import { getOnrampOrder } from '../onramp/service/onramp-orders.service.js';
import { syncOnrampOrder } from '../onramp/service/onramp-sync.service.js';
import { forceSandboxKycApproval, importBridgeCustomerSchema, importExistingBridgeCustomer, manuallyApproveCustomerKyc, refreshKycStatus } from '../customers/customers.service.js';
import { createAuditLog } from '../audit/audit.service.js';
import { runOnrampReconciliation } from '../onramp/service/onramp-reconciliation.service.js';
import { addAdminNote, adminNoteSchema, approvalRequestSchema, approvalReviewSchema, approveRequest, buildExport, createApprovalRequest, getAdminOnrampOrderDetails, getAdminUserDetails, getAdminWithdrawalDetails, getFinanceDashboard, getLegalEvidenceSummary, getLimitControls, getUserLimitControls, limitControlsSchema, listApprovalRequests, listRiskCases, markWithdrawalCompleted, reconcileAllPendingWithdrawals, rejectRequest, removeUserLimitOverride, reviewRiskCase, riskReviewSchema, updateLimitControls, updateUserLimitOverride, userLimitOverrideSchema } from './admin-ops.service.js';
import { reprocessBridgeWebhookEvent } from '../webhooks/webhooks.service.js';
import { adminPlatformSettingsSchema, buildAllAdminExport, getAdminApiKeyInventory, getAdminPlatformSettings, getAdminTeamMembers, inviteAdminTeamMember, requestApiKeyRotation, updateAdminPlatformSettings } from './admin-settings.service.js';
import { feeSettingsSchema, getAdminFeeSettings, updateAdminFeeSettings } from './admin-fees.service.js';
import { previewOnrampFees, validateTiers } from './fee-policy.js';
import { getCustomerKycDiagnostics, getDocumentVerificationQueue, getGlobalSearch, getProviderHealth, getQueueDashboard, getSettlementReconciliation, getUserTimeline, getBusinessKpis, listUserRestrictions, payoutRetrySchema, refundRequestSchema, requestPayoutRetry, requestRefund, restrictUser, unrestrictUser, userRestrictionSchema } from './admin-hardening.service.js';


function listOptions(request: any) {
  const query = (request.query ?? {}) as Record<string, string>;
  const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 500);
  const offset = Math.max(Number(query.offset ?? 0), 0);
  return { limit, offset, status: query.status || undefined };
}

const reconciliationRunSchema = z.object({
  dryRun: z.boolean().default(true),
  provider: z.string().optional(),
  userId: z.string().optional(),
  liquidationAddressId: z.string().optional()
});

const referenceReconciliationRunSchema = z.object({
  dryRun: z.boolean().default(true),
  limit: z.coerce.number().int().min(1).max(1000).default(1000)
});

export async function adminRoutes(app: FastifyInstance) {
  app.get('/api/admin/overview', async () => ({ data: await getAdminOverview() }));
  app.get('/api/admin/users', async (request) => ({ data: await listAdminUsers(listOptions(request)) }));

  app.get('/api/admin/users/:id/details', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getAdminUserDetails(id) };
  });
  app.get('/api/admin/users/:id/account-controls', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getAccountRecoveryControls(id) };
  });

  app.post('/api/admin/users/:id/account-controls/username', async (request) => {
    const { id } = request.params as { id: string };
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role || 'admin_api_key';
    const body = parseBody(adminChangeUsernameSchema, { ...(request.body as any), actorId: (request.body as any)?.actorId || actor });
    return { data: await adminChangeUsername(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/admin/users/:id/account-controls/remove-avatar', async (request) => {
    const { id } = request.params as { id: string };
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role || 'admin_api_key';
    const body = parseBody(adminRemoveAvatarSchema, { ...(request.body as any), actorId: (request.body as any)?.actorId || actor });
    return { data: await adminRemoveAvatar(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/admin/users/:id/account-controls/reset-2fa', async (request) => {
    const { id } = request.params as { id: string };
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role || 'admin_api_key';
    const body = parseBody(adminResetTwoFactorSchema, { ...(request.body as any), actorId: (request.body as any)?.actorId || actor });
    return { data: await adminResetTwoFactor(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/admin/users/:id/account-controls/name-correction-request', async (request) => {
    const { id } = request.params as { id: string };
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role || 'admin_api_key';
    const body = parseBody(adminNameCorrectionRequestSchema, { ...(request.body as any), actorId: (request.body as any)?.actorId || actor });
    return { data: await adminRequestNameCorrection(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/admin/users/:id/account-controls/email-change-request', async (request) => {
    const { id } = request.params as { id: string };
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role || 'admin_api_key';
    const body = parseBody(adminEmailChangeRequestSchema, { ...(request.body as any), actorId: (request.body as any)?.actorId || actor });
    return { data: await adminStartEmailChange(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/admin/users/:id/account-controls/unlink-whatsapp', async (request) => {
    const { id } = request.params as { id: string };
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role || 'admin_api_key';
    const body = parseBody(adminUnlinkWhatsappSchema, { ...(request.body as any), actorId: (request.body as any)?.actorId || actor });
    return { data: await adminUnlinkWhatsapp(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.get('/api/admin/users/:id/timeline', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getUserTimeline(id) };
  });

  app.get('/api/admin/users/:id/restrictions', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await listUserRestrictions(id) };
  });

  app.post('/api/admin/users/:id/restrictions', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(userRestrictionSchema, request.body);
    return { data: await restrictUser(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.delete('/api/admin/users/:id/restrictions', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(z.object({ reason: z.string().optional(), actorId: z.string().optional() }), request.body ?? {});
    return { data: await unrestrictUser(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.get('/api/admin/search', async (request) => {
    const query = (request.query ?? {}) as Record<string, string>;
    return { data: await getGlobalSearch(query.q || query.search || '', { limit: Number(query.limit || 50) }) };
  });

  app.get('/api/admin/risk/cases', async (request) => {
    const query = (request.query ?? {}) as Record<string, string>;
    return { data: await listRiskCases({ status: query.status, severity: query.severity }) };
  });

  app.post('/api/admin/risk/cases/:id/review', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(riskReviewSchema, request.body);
    return { data: await reviewRiskCase(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.get('/api/admin/approvals', async () => ({ data: await listApprovalRequests() }));

  app.post('/api/admin/approvals', async (request) => {
    const body = parseBody(approvalRequestSchema, request.body);
    // Trust the authenticated admin identity over any client-supplied value.
    // The admin hub previously hardcoded requestedBy: 'ops', which both
    // falsified the audit trail and broke maker/checker separation.
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role;
    const payload = actor ? { ...body, requestedBy: actor } : body;
    return { data: await createApprovalRequest(payload, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/admin/approvals/:id/approve', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(approvalReviewSchema, request.body);
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role;
    /**
     * The role comes from the AUTHENTICATED SESSION, and overwrites anything
     * in the body. A self-approval right that a client could claim for itself
     * would not be a right, it would be a hole: any caller could post
     * `reviewerRole: 'superadmin'` and approve their own request.
     */
    const payload = {
      ...body,
      ...(actor ? { reviewer: actor } : {}),
      reviewerRole: (request as any).adminActor?.role,
    };
    return { data: await approveRequest(id, payload, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/admin/approvals/:id/reject', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(approvalReviewSchema, request.body);
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role;
    const payload = actor ? { ...body, reviewer: actor } : body;
    return { data: await rejectRequest(id, payload, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/admin/notes', async (request) => {
    const body = parseBody(adminNoteSchema, request.body);
    return { data: await addAdminNote(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.get('/api/admin/limits', async () => ({ data: await getLimitControls() }));

  app.put('/api/admin/limits', async (request) => {
    const body = parseBody(limitControlsSchema, request.body);
    return { data: await updateLimitControls(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.get('/api/admin/users/:userId/limits/override', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await getUserLimitControls(userId) };
  });

  app.post('/api/admin/users/:userId/limits/override', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(userLimitOverrideSchema, request.body);
    return { data: await updateUserLimitOverride(userId, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.delete('/api/admin/users/:userId/limits/override', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = (request.body ?? {}) as { updatedBy?: string; reason?: string };
    return { data: await removeUserLimitOverride(userId, body.updatedBy, body.reason, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/admin/users/:userId/kyc/approve', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = (request.body ?? {}) as { approvedBy?: string; reason?: string; customerType?: 'individual' | 'business' };
    return { data: await manuallyApproveCustomerKyc(userId, { approvedBy: body.approvedBy || 'admin', reason: body.reason || 'Admin manual KYC approval and tier upgrade', customerType: body.customerType }, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.get('/api/admin/finance/dashboard', async () => ({ data: await getFinanceDashboard() }));
  app.get('/api/admin/business-kpis', async () => ({ data: await getBusinessKpis() }));
  app.get('/api/admin/finance/settlements', async () => ({ data: await getSettlementReconciliation() }));
  app.get('/api/admin/provider-health', async () => ({ data: await getProviderHealth() }));
  app.get('/api/admin/queue/status', async () => ({ data: await getQueueDashboard() }));
  app.get('/api/admin/compliance/documents', async () => ({ data: await getDocumentVerificationQueue() }));
  app.post('/api/admin/customers/:userId/kyc-diagnostics', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await getCustomerKycDiagnostics(userId) };
  });
  app.post('/api/admin/refunds/request', async (request) => {
    const body = parseBody(refundRequestSchema, request.body);
    return { data: await requestRefund(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });
  app.post('/api/admin/withdrawals/:id/retry-payout', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(payoutRetrySchema, request.body);
    return { data: await requestPayoutRetry(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });
  app.get('/api/admin/legal/evidence', async () => ({ data: await getLegalEvidenceSummary() }));
  app.get('/api/admin/fees/settings', async () => ({ data: await getAdminFeeSettings() }));
  app.put('/api/admin/fees/settings', async (request) => {
    const body = parseBody(feeSettingsSchema, request.body);
    return { data: await updateAdminFeeSettings(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });
  /**
   * Preview what a fee configuration would charge, without saving it.
   *
   * A tier table is easy to get subtly wrong, and the failure mode is real
   * customers charged the wrong amount. This lets the Admin Hub show the
   * consequences before anyone commits.
   */
  app.post('/api/admin/fees/preview', async (request) => {
    const body = (request.body ?? {}) as {
      basePercent?: number;
      minimumFeeUsd?: number;
      tiers?: Array<{ minAmount: number; maxAmount: number | null; percent: number }>;
      amounts?: number[];
    };
    const current = await getAdminFeeSettings();
    const tiers = body.tiers ?? current.onrampFeeTiers ?? [];
    const errors = validateTiers(tiers);
    return {
      data: {
        valid: errors.length === 0,
        errors,
        rows: errors.length
          ? []
          : previewOnrampFees(
              {
                basePercent: body.basePercent ?? current.onrampFeePercent,
                minimumFeeUsd: body.minimumFeeUsd ?? current.onrampMinimumFeeUsd ?? 0,
                tiers,
                transactionMinimumUsd: 1,
              },
              body.amounts
            ),
      },
    };
  });

  app.get('/api/admin/settings/platform', async () => ({ data: await getAdminPlatformSettings() }));
  app.put('/api/admin/settings/platform', async (request) => {
    const body = parseBody(adminPlatformSettingsSchema, request.body);
    return { data: await updateAdminPlatformSettings(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });
  app.get('/api/admin/settings/team', async () => ({ data: await getAdminTeamMembers() }));
  app.post('/api/admin/settings/team/invite', async (request) => {
    const body = parseBody(z.object({ name: z.string().min(2), email: z.string().email(), role: z.string().min(2), invitedBy: z.string().optional(), reason: z.string().optional() }), request.body);
    return { data: await inviteAdminTeamMember(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });
  app.get('/api/admin/settings/api-keys', async () => ({ data: await getAdminApiKeyInventory() }));
  app.post('/api/admin/settings/api-keys/:key/rotate', async (request) => {
    const { key } = request.params as { key: string };
    const body = parseBody(z.object({ requestedBy: z.string().optional(), reason: z.string().optional() }), request.body ?? {});
    return { data: await requestApiKeyRotation({ key, ...body }, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.get('/api/admin/exports/all.json', async (request, reply) => {
    return reply.header('Content-Type', 'application/json; charset=utf-8').header('Content-Disposition', 'attachment; filename="sivan-admin-export.json"').send(await buildAllAdminExport());
  });

  app.get('/api/admin/exports/:type.csv', async (request, reply) => {
    const { type } = request.params as { type: string };
    const csv = await buildExport(type);
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="sivan-${type}.csv"`).send(csv);
  });

  app.get('/api/admin/withdrawals/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getWithdrawal(id) };
  });

  app.get('/api/admin/withdrawals/:id/details', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getAdminWithdrawalDetails(id) };
  });

  app.post('/api/admin/withdrawals/:id/sync', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await syncWithdrawalDrains(id) };
  });

  app.post('/api/admin/withdrawals/:id/complete', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await markWithdrawalCompleted(id) };
  });

  app.post('/api/admin/withdrawals/reconcile-all-completed', async () => {
    return { data: await reconcileAllPendingWithdrawals() };
  });

  app.get('/api/admin/onramp/orders/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getOnrampOrder(id) };
  });

  app.get('/api/admin/onramp/orders/:id/details', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getAdminOnrampOrderDetails(id) };
  });

  app.post('/api/admin/onramp/orders/:id/sync', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await syncOnrampOrder(id) };
  });

  app.post('/api/admin/customers/:userId/kyc-status', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await refreshKycStatus(userId) };
  });

  app.post('/api/admin/customers/import-bridge-customer', async (request) => {
    const body = parseBody(importBridgeCustomerSchema, request.body);
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role || body.importedBy || 'admin_api_key';
    return { data: await importExistingBridgeCustomer({ ...body, importedBy: actor }, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/admin/customers/:userId/sandbox/force-kyc-approval', async (request) => {
    const { userId } = request.params as { userId: string };
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role || 'admin_api_key';
    return { data: await forceSandboxKycApproval(userId, actor) };
  });

  app.get('/api/admin/withdrawals', async (request) => ({ data: await listAdminWithdrawals(listOptions(request)) }));
  app.get('/api/admin/onramp/orders', async (request) => ({ data: await listAdminOnrampOrders(listOptions(request)) }));
  app.get('/api/admin/webhooks', async (request) => ({ data: await listAdminWebhookEvents(listOptions(request)) }));
  app.post('/api/admin/webhooks/:id/reprocess', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await reprocessBridgeWebhookEvent(id) };
  });
  app.get('/api/admin/audit-logs', async (request) => ({ data: await listAdminAuditLogs(listOptions(request)) }));
  app.get('/api/admin/reconciliation/runs', async (request) => ({ data: await listAdminReconciliationRuns(listOptions(request)) }));
  app.get('/api/admin/reconciliation/findings/dashboard', async (request) => {
    const query = (request.query ?? {}) as Record<string, string>;
    return { data: await buildReferenceReconciliationDashboard({ limit: query.limit ? Number(query.limit) : undefined }) };
  });
  app.post('/api/admin/reconciliation/findings/run', async (request) => {
    const body = parseBody(referenceReconciliationRunSchema, request.body);
    const result = await persistReferenceReconciliationRun(body);
    await createAuditLog({
      actorType: 'admin',
      actorId: 'admin_api_key',
      action: body.dryRun ? 'reference_reconciliation.dry_run' : 'reference_reconciliation.live_run',
      resourceType: 'reconciliation_run',
      resourceId: result.runId,
      severity: result.summary.errors > 0 ? 'warning' : 'info',
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { summary: result.summary }
    });
    return { data: result };
  });
  app.get('/api/admin/analytics', async () => ({ data: await getAdminAnalytics() }));

  app.post('/api/admin/onramp/reconciliation/run', async (request) => {
    const body = parseBody(z.object({ dryRun: z.boolean().default(true), provider: z.string().optional(), userId: z.string().optional() }), request.body);
    const result = await runOnrampReconciliation(body);
    await createAuditLog({
      actorType: 'admin',
      actorId: 'admin_api_key',
      action: body.dryRun ? 'onramp.reconciliation.dry_run' : 'onramp.reconciliation.live_run',
      resourceType: 'payments_onramp_order',
      severity: result.summary.providerErrors > 0 ? 'warning' : 'info',
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { summary: result.summary, filters: body }
    });
    return { data: result };
  });

  app.post('/api/admin/reconciliation/run', async (request) => {
    const body = parseBody(reconciliationRunSchema, request.body);
    const result = await runOfframpReconciliation(body);
    await createAuditLog({
      actorType: 'admin',
      actorId: 'admin_api_key',
      action: body.dryRun ? 'reconciliation.dry_run' : 'reconciliation.live_run',
      resourceType: 'reconciliation_run',
      resourceId: result.runId,
      severity: result.summary.providerErrors > 0 ? 'warning' : 'info',
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { summary: result.summary, filters: body }
    });
    return { data: result };
  });
}
