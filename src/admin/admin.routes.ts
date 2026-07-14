import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody } from '../shared/validation.js';
import { getAdminOverview, listAdminUsers, listAdminWebhookEvents, listAdminWithdrawals, listAdminAuditLogs, listAdminReconciliationRuns, listAdminOnrampOrders } from './admin.service.js';
import { getAdminAnalytics } from './analytics.service.js';
import { runOfframpReconciliation } from '../reconciliation/reconciliation.service.js';
import { getWithdrawal, syncWithdrawalDrains } from '../offramp/service/withdrawals.service.js';
import { getOnrampOrder } from '../onramp/service/onramp-orders.service.js';
import { syncOnrampOrder } from '../onramp/service/onramp-sync.service.js';
import { refreshKycStatus } from '../customers/customers.service.js';
import { createAuditLog } from '../audit/audit.service.js';
import { runOnrampReconciliation } from '../onramp/service/onramp-reconciliation.service.js';
import { addAdminNote, adminNoteSchema, approvalRequestSchema, approvalReviewSchema, approveRequest, buildExport, createApprovalRequest, getAdminOnrampOrderDetails, getAdminUserDetails, getAdminWithdrawalDetails, getFinanceDashboard, getLegalEvidenceSummary, getLimitControls, limitControlsSchema, listApprovalRequests, listRiskCases, rejectRequest, reviewRiskCase, riskReviewSchema, updateLimitControls } from './admin-ops.service.js';
import { reprocessBridgeWebhookEvent } from '../webhooks/webhooks.service.js';
import { adminPlatformSettingsSchema, buildAllAdminExport, getAdminApiKeyInventory, getAdminPlatformSettings, getAdminTeamMembers, requestApiKeyRotation, updateAdminPlatformSettings } from './admin-settings.service.js';
import { feeSettingsSchema, getAdminFeeSettings, updateAdminFeeSettings } from './admin-fees.service.js';


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

export async function adminRoutes(app: FastifyInstance) {
  app.get('/api/admin/overview', async () => ({ data: await getAdminOverview() }));
  app.get('/api/admin/users', async (request) => ({ data: await listAdminUsers(listOptions(request)) }));

  app.get('/api/admin/users/:id/details', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getAdminUserDetails(id) };
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
    return { data: await createApprovalRequest(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/admin/approvals/:id/approve', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(approvalReviewSchema, request.body);
    return { data: await approveRequest(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/admin/approvals/:id/reject', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(approvalReviewSchema, request.body);
    return { data: await rejectRequest(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
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

  app.get('/api/admin/finance/dashboard', async () => ({ data: await getFinanceDashboard() }));
  app.get('/api/admin/legal/evidence', async () => ({ data: await getLegalEvidenceSummary() }));
  app.get('/api/admin/fees/settings', async () => ({ data: await getAdminFeeSettings() }));
  app.put('/api/admin/fees/settings', async (request) => {
    const body = parseBody(feeSettingsSchema, request.body);
    return { data: await updateAdminFeeSettings(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });
  app.get('/api/admin/settings/platform', async () => ({ data: await getAdminPlatformSettings() }));
  app.put('/api/admin/settings/platform', async (request) => {
    const body = parseBody(adminPlatformSettingsSchema, request.body);
    return { data: await updateAdminPlatformSettings(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });
  app.get('/api/admin/settings/team', async () => ({ data: await getAdminTeamMembers() }));
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

  app.get('/api/admin/withdrawals', async (request) => ({ data: await listAdminWithdrawals(listOptions(request)) }));
  app.get('/api/admin/onramp/orders', async (request) => ({ data: await listAdminOnrampOrders(listOptions(request)) }));
  app.get('/api/admin/webhooks', async (request) => ({ data: await listAdminWebhookEvents(listOptions(request)) }));
  app.post('/api/admin/webhooks/:id/reprocess', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await reprocessBridgeWebhookEvent(id) };
  });
  app.get('/api/admin/audit-logs', async (request) => ({ data: await listAdminAuditLogs(listOptions(request)) }));
  app.get('/api/admin/reconciliation/runs', async (request) => ({ data: await listAdminReconciliationRuns(listOptions(request)) }));
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
