import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { parseBody } from '../../shared/validation.js';
import { forbidden } from '../../shared/errors.js';
import { approveVirtualAccountRequest, checkVirtualAccountProviderByEmail, cleanupLegacyMockVirtualAccountData, listUserVirtualAccounts, listVirtualAccountEvents, listVirtualAccountRequests, listVirtualAccounts, listVirtualAccountTransactions, rejectVirtualAccountRequest, requestVirtualAccountReprovision, requestVirtualAccount } from '../service/virtual-account.service.js';
import { getVirtualAccountProviderSettings, updateVirtualAccountProviderSettings, virtualAccountProviderSettingsSchema } from '../service/virtual-account-provider-settings.service.js';

const requestSchema = z.object({
  currency: z.enum(['usd', 'gbp', 'eur']),
  country: z.string().min(2).max(8).optional(),
  useCase: z.string().max(240).optional(),
});

const rejectSchema = z.object({
  reason: z.string().min(3).max(500),
});

const cleanupMockSchema = z.object({
  dryRun: z.boolean().default(true),
  reason: z.string().min(5).max(500).optional(),
});

const providerCheckQuerySchema = z.object({
  email: z.string().email(),
});

function actor(request: any) {
  return request.adminActor?.email || request.adminActor?.role || 'admin_api_key';
}

export async function virtualAccountsRoutes(app: FastifyInstance) {
  app.get('/api/users/:userId/virtual-accounts', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await listUserVirtualAccounts(userId) };
  });

  app.post('/api/users/:userId/virtual-accounts/request', async (request) => {
    const { userId } = request.params as { userId: string };
    const authUser = (request as any).authUser?.sub;
    if (authUser && authUser !== userId) throw forbidden('You cannot request a virtual account for another user.');
    const body = parseBody(requestSchema, request.body);
    return { data: await requestVirtualAccount({ userId, ...body }, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.get('/api/admin/virtual-account-provider-settings', async () => ({ data: await getVirtualAccountProviderSettings() }));

  app.put('/api/admin/virtual-account-provider-settings', async (request) => {
    const body = parseBody(virtualAccountProviderSettingsSchema, request.body);
    return { data: await updateVirtualAccountProviderSettings(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.get('/api/admin/virtual-account-requests', async () => ({ data: await listVirtualAccountRequests() }));

  app.get('/api/admin/virtual-accounts', async () => ({ data: await listVirtualAccounts() }));

  app.get('/api/admin/virtual-account-events', async () => ({ data: await listVirtualAccountEvents() }));

  app.get('/api/admin/virtual-account-transactions', async () => ({ data: await listVirtualAccountTransactions() }));

  app.get('/api/admin/virtual-accounts/provider-check', async (request) => {
    const query = providerCheckQuerySchema.parse(request.query);
    return { data: await checkVirtualAccountProviderByEmail(query.email) };
  });

  app.post('/api/admin/virtual-accounts/cleanup-mock', async (request) => {
    const body = parseBody(cleanupMockSchema, request.body ?? {});
    return { data: await cleanupLegacyMockVirtualAccountData({ ...body, canceledBy: actor(request) }) };
  });

  app.post('/api/admin/virtual-account-requests/:requestId/approve', async (request) => {
    const { requestId } = request.params as { requestId: string };
    return { data: await approveVirtualAccountRequest(requestId, actor(request)) };
  });

  /**
   * Raises a maker-checker approval. Does NOT reprovision.
   *
   * This used to provision immediately, which meant one click created a real
   * bank account at Bridge, and a retried click created two. A second admin
   * must now approve from the Approvals tab before anything is created.
   */
  app.post('/api/admin/virtual-account-requests/:requestId/reprovision', async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const body = (request.body ?? {}) as { reason?: string };
    const approval = await requestVirtualAccountReprovision(requestId, actor(request), body.reason);

    // 202, not 200: nothing has been provisioned yet. A 200 previously meant
    // "a new account now exists", and the UI must not confuse the two.
    return reply.code(202).send({
      data: {
        ...approval,
        pendingApproval: true,
        message:
          'Reprovision requested. A second admin must approve this in the Approvals tab before a new virtual account is created.',
      },
    });
  });

  app.post('/api/admin/virtual-account-requests/:requestId/reject', async (request) => {
    const { requestId } = request.params as { requestId: string };
    const body = parseBody(rejectSchema, request.body);
    return { data: await rejectVirtualAccountRequest(requestId, actor(request), body.reason) };
  });
}
