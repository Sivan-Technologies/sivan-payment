import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody } from '../shared/validation.js';
import { getAdminOverview, listAdminUsers, listAdminWebhookEvents, listAdminWithdrawals } from './admin.service.js';
import { getAdminAnalytics } from './analytics.service.js';
import { runOfframpReconciliation } from '../reconciliation/reconciliation.service.js';

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
  app.get('/api/admin/analytics', async () => ({ data: await getAdminAnalytics() }));

  app.post('/api/admin/reconciliation/run', async (request) => {
    const body = parseBody(reconciliationRunSchema, request.body);
    return { data: await runOfframpReconciliation(body) };
  });
}
