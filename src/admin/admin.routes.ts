import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody } from '../shared/validation.js';
import { getAdminOverview, listAdminUsers, listAdminWebhookEvents, listAdminWithdrawals, listAdminAuditLogs, listAdminReconciliationRuns } from './admin.service.js';
import { getAdminAnalytics } from './analytics.service.js';
import { runOfframpReconciliation } from '../reconciliation/reconciliation.service.js';
import { createAuditLog } from '../audit/audit.service.js';

const reconciliationRunSchema = z.object({
  dryRun: z.boolean().default(true),
  provider: z.string().optional(),
  userId: z.string().optional(),
  liquidationAddressId: z.string().optional()
});

export async function adminRoutes(app: FastifyInstance) {
  app.get('/api/admin/overview', async () => ({ data: await getAdminOverview() }));
  app.get('/api/admin/users', async () => ({ data: await listAdminUsers() }));
  app.get('/api/admin/withdrawals', async () => ({ data: await listAdminWithdrawals() }));
  app.get('/api/admin/webhooks', async () => ({ data: await listAdminWebhookEvents() }));
  app.get('/api/admin/audit-logs', async () => ({ data: await listAdminAuditLogs() }));
  app.get('/api/admin/reconciliation/runs', async () => ({ data: await listAdminReconciliationRuns() }));
  app.get('/api/admin/analytics', async () => ({ data: await getAdminAnalytics() }));

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
