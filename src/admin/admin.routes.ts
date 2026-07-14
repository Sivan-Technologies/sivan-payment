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

  app.get('/api/admin/withdrawals/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getWithdrawal(id) };
  });

  app.post('/api/admin/withdrawals/:id/sync', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await syncWithdrawalDrains(id) };
  });

  app.get('/api/admin/onramp/orders/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getOnrampOrder(id) };
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
