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
  const regGet = (path: string, handler: (request: any, reply?: any) => Promise<any>) => {
    const fullPath = path.startsWith('/') ? path : `/${path}`;
    app.get(`/api/admin${fullPath}`, handler);
    app.get(fullPath, handler);
  };

  const regPost = (path: string, handler: (request: any, reply?: any) => Promise<any>) => {
    const fullPath = path.startsWith('/') ? path : `/${path}`;
    app.post(`/api/admin${fullPath}`, handler);
    app.post(fullPath, handler);
  };

  const regPut = (path: string, handler: (request: any, reply?: any) => Promise<any>) => {
    const fullPath = path.startsWith('/') ? path : `/${path}`;
    app.put(`/api/admin${fullPath}`, handler);
    app.put(fullPath, handler);
  };

  const regDelete = (path: string, handler: (request: any, reply?: any) => Promise<any>) => {
    const fullPath = path.startsWith('/') ? path : `/${path}`;
    app.delete(`/api/admin${fullPath}`, handler);
    app.delete(fullPath, handler);
  };

  const healthHandler = async () => ({ status: 'ok', service: 'sivan-payments-admin', timestamp: new Date().toISOString() });
  regGet('/health', healthHandler);
  regGet('/payment/health', healthHandler);
  app.get('/api/admin/payment/health', healthHandler);
  regGet('/overview', async () => ({ data: await getAdminOverview() }));
  regGet('/users', async (request) => ({ data: await listAdminUsers(listOptions(request)) }));

  regGet('/users/:id/details', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getAdminUserDetails(id) };
  });
  regGet('/users/:id/account-controls', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getAccountRecoveryControls(id) };
  });

  regPost('/users/:id/account-controls/username', async (request) => {
    const { id } = request.params as { id: string };
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role || 'admin_api_key';
    const body = parseBody(adminChangeUsernameSchema, { ...(request.body as any), actorId: (request.body as any)?.actorId || actor });
    return { data: await adminChangeUsername(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  regPost('/users/:id/account-controls/remove-avatar', async (request) => {
    const { id } = request.params as { id: string };
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role || 'admin_api_key';
    const body = parseBody(adminRemoveAvatarSchema, { ...(request.body as any), actorId: (request.body as any)?.actorId || actor });
    return { data: await adminRemoveAvatar(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  regPost('/users/:id/account-controls/reset-2fa', async (request) => {
    const { id } = request.params as { id: string };
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role || 'admin_api_key';
    const body = parseBody(adminResetTwoFactorSchema, { ...(request.body as any), actorId: (request.body as any)?.actorId || actor });
    return { data: await adminResetTwoFactor(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  regPost('/users/:id/account-controls/name-correction-request', async (request) => {
    const { id } = request.params as { id: string };
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role || 'admin_api_key';
    const body = parseBody(adminNameCorrectionRequestSchema, { ...(request.body as any), actorId: (request.body as any)?.actorId || actor });
    return { data: await adminRequestNameCorrection(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  regPost('/users/:id/account-controls/email-change-request', async (request) => {
    const { id } = request.params as { id: string };
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role || 'admin_api_key';
    const body = parseBody(adminEmailChangeRequestSchema, { ...(request.body as any), actorId: (request.body as any)?.actorId || actor });
    return { data: await adminStartEmailChange(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  regPost('/users/:id/account-controls/unlink-whatsapp', async (request) => {
    const { id } = request.params as { id: string };
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role || 'admin_api_key';
    const body = parseBody(adminUnlinkWhatsappSchema, { ...(request.body as any), actorId: (request.body as any)?.actorId || actor });
    return { data: await adminUnlinkWhatsapp(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  regGet('/users/:id/timeline', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getUserTimeline(id) };
  });

  regGet('/users/:id/restrictions', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await listUserRestrictions(id) };
  });

  regPost('/users/:id/restrictions', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(userRestrictionSchema, request.body);
    return { data: await restrictUser(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  regDelete('/users/:id/restrictions', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(z.object({ reason: z.string().optional(), actorId: z.string().optional() }), request.body ?? {});
    return { data: await unrestrictUser(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  regGet('/search', async (request) => {
    const query = (request.query ?? {}) as Record<string, string>;
    return { data: await getGlobalSearch(query.q ?? '', listOptions(request)) };
  });

  regGet('/limits', async () => ({ data: await getLimitControls() }));

  regPut('/limits', async (request) => {
    const body = parseBody(limitControlsSchema, request.body);
    return { data: await updateLimitControls(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  const handleGetUserLimits = async (request: any) => {
    const userId = (request.params as any).id || (request.params as any).userId;
    return { data: await getUserLimitControls(userId) };
  };
  regGet('/users/:id/limits', handleGetUserLimits);
  regGet('/users/:id/limits/override', handleGetUserLimits);

  const handleUpdateUserLimits = async (request: any) => {
    const userId = (request.params as any).id || (request.params as any).userId;
    const body = parseBody(userLimitOverrideSchema, request.body);
    return { data: await updateUserLimitOverride(userId, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  };
  regPost('/users/:id/limits', handleUpdateUserLimits);
  regPost('/users/:id/limits/override', handleUpdateUserLimits);

  const handleRemoveUserLimits = async (request: any) => {
    const userId = (request.params as any).id || (request.params as any).userId;
    const body = (request.body ?? {}) as { updatedBy?: string; reason?: string };
    return { data: await removeUserLimitOverride(userId, body.updatedBy, body.reason, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  };
  regDelete('/users/:id/limits', handleRemoveUserLimits);
  regDelete('/users/:id/limits/override', handleRemoveUserLimits);

  regPost('/users/:id/kyc/approve', async (request) => {
    const userId = (request.params as any).id || (request.params as any).userId;
    const body = (request.body ?? {}) as { approvedBy?: string; reason?: string; customerType?: 'individual' | 'business' };
    return { data: await manuallyApproveCustomerKyc(userId, { approvedBy: body.approvedBy || 'admin', reason: body.reason || 'Admin manual KYC approval and tier upgrade', customerType: body.customerType }, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  regGet('/risk/cases', async (request) => {
    const query = (request.query ?? {}) as Record<string, string>;
    return { data: await listRiskCases({ status: query.status, severity: query.severity }) };
  });

  regPost('/risk/cases/:id/review', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(riskReviewSchema, request.body);
    return { data: await reviewRiskCase(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  regGet('/approvals', async () => ({ data: await listApprovalRequests() }));

  regPost('/approvals', async (request) => {
    const body = parseBody(approvalRequestSchema, request.body);
    // Trust the authenticated admin identity over any client-supplied value.
    // The admin hub previously hardcoded requestedBy: 'ops', which both
    // falsified the audit trail and broke maker/checker separation.
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role;
    const payload = actor ? { ...body, requestedBy: actor } : body;
    return { data: await createApprovalRequest(payload, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  regPost('/approvals/:id/approve', async (request) => {
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

  regPost('/approvals/:id/reject', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(approvalReviewSchema, request.body);
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role;
    const payload = actor ? { ...body, reviewer: actor } : body;
    return { data: await rejectRequest(id, payload, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  regPost('/notes', async (request) => {
    const body = parseBody(adminNoteSchema, request.body);
    return { data: await addAdminNote(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  regGet('/finance/dashboard', async () => ({ data: await getFinanceDashboard() }));
  regGet('/business-kpis', async () => ({ data: await getBusinessKpis() }));
  regGet('/finance/settlements', async () => ({ data: await getSettlementReconciliation() }));
  regGet('/provider-health', async () => ({ data: await getProviderHealth() }));
  regGet('/queue/status', async () => ({ data: await getQueueDashboard() }));
  regGet('/compliance/documents', async () => ({ data: await getDocumentVerificationQueue() }));

  regPost('/customers/:userId/kyc-diagnostics', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await getCustomerKycDiagnostics(userId) };
  });
  regPost('/refunds/request', async (request) => {
    const body = parseBody(refundRequestSchema, request.body);
    return { data: await requestRefund(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });
  regPost('/withdrawals/:id/retry-payout', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(payoutRetrySchema, request.body);
    return { data: await requestPayoutRetry(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  regGet('/legal/evidence', async () => ({ data: await getLegalEvidenceSummary() }));
  regGet('/fees/settings', async () => ({ data: await getAdminFeeSettings() }));
  regPut('/fees/settings', async (request) => {
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
  regPost('/fees/preview', async (request) => {
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

  regGet('/settings/platform', async () => ({ data: await getAdminPlatformSettings() }));
  regPut('/settings/platform', async (request) => {
    const body = parseBody(adminPlatformSettingsSchema, request.body);
    return { data: await updateAdminPlatformSettings(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });
  regGet('/settings/team', async () => ({ data: await getAdminTeamMembers() }));
  regPost('/settings/team/invite', async (request) => {
    const body = parseBody(z.object({ name: z.string().min(2), email: z.string().email(), role: z.string().min(2), invitedBy: z.string().optional(), reason: z.string().optional() }), request.body);
    return { data: await inviteAdminTeamMember(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });
  regGet('/settings/api-keys', async () => ({ data: await getAdminApiKeyInventory() }));
  regPost('/settings/api-keys/:key/rotate', async (request) => {
    const { key } = request.params as { key: string };
    const body = parseBody(z.object({ requestedBy: z.string().optional(), reason: z.string().optional() }), request.body ?? {});
    return { data: await requestApiKeyRotation({ key, ...body }, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  regGet('/exports/all.json', async (request, reply) => {
    return reply.header('Content-Type', 'application/json; charset=utf-8').header('Content-Disposition', 'attachment; filename="sivan-admin-export.json"').send(await buildAllAdminExport());
  });

  regGet('/exports/:type.csv', async (request, reply) => {
    const { type } = request.params as { type: string };
    const csv = await buildExport(type);
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="sivan-${type}.csv"`).send(csv);
  });

  regGet('/withdrawals/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getWithdrawal(id) };
  });

  regGet('/withdrawals/:id/details', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getAdminWithdrawalDetails(id) };
  });

  regPost('/withdrawals/:id/sync', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await syncWithdrawalDrains(id) };
  });

  regPost('/withdrawals/:id/complete', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await markWithdrawalCompleted(id) };
  });

  regPost('/withdrawals/reconcile-all-completed', async () => {
    return { data: await reconcileAllPendingWithdrawals() };
  });

  regGet('/onramp/orders/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getOnrampOrder(id) };
  });

  regGet('/onramp/orders/:id/details', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getAdminOnrampOrderDetails(id) };
  });

  regPost('/onramp/orders/:id/sync', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await syncOnrampOrder(id) };
  });

  regPost('/customers/:userId/kyc-status', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await refreshKycStatus(userId) };
  });

  regPost('/customers/import-bridge-customer', async (request) => {
    const body = parseBody(importBridgeCustomerSchema, request.body);
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role || body.importedBy || 'admin_api_key';
    return { data: await importExistingBridgeCustomer({ ...body, importedBy: actor }, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  regPost('/customers/:userId/sandbox/force-kyc-approval', async (request) => {
    const { userId } = request.params as { userId: string };
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role || 'admin_api_key';
    return { data: await forceSandboxKycApproval(userId, actor) };
  });

  regGet('/withdrawals', async (request) => ({ data: await listAdminWithdrawals(listOptions(request)) }));
  regGet('/onramp/orders', async (request) => ({ data: await listAdminOnrampOrders(listOptions(request)) }));
  regGet('/webhooks', async (request) => ({ data: await listAdminWebhookEvents(listOptions(request)) }));
  regPost('/webhooks/:id/reprocess', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await reprocessBridgeWebhookEvent(id) };
  });
  regGet('/audit-logs', async (request) => ({ data: await listAdminAuditLogs(listOptions(request)) }));
  regGet('/reconciliation/runs', async (request) => ({ data: await listAdminReconciliationRuns(listOptions(request)) }));
  regGet('/reconciliation/findings/dashboard', async (request) => {
    const query = (request.query ?? {}) as Record<string, string>;
    return { data: await buildReferenceReconciliationDashboard({ limit: query.limit ? Number(query.limit) : undefined }) };
  });
  regPost('/reconciliation/findings/run', async (request) => {
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
  regGet('/analytics', async () => ({ data: await getAdminAnalytics() }));

  regPost('/onramp/reconciliation/run', async (request) => {
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

  regPost('/reconciliation/run', async (request) => {
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
