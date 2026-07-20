import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { parseBody } from '../../shared/validation.js';
import { forbidden } from '../../shared/errors.js';
import { approveVirtualAccountRequest, listUserVirtualAccounts, listVirtualAccountRequests, listVirtualAccounts, rejectVirtualAccountRequest, requestVirtualAccount } from '../service/virtual-account.service.js';

const requestSchema = z.object({
  currency: z.enum(['usd', 'gbp', 'eur']),
  country: z.string().min(2).max(8).optional(),
  useCase: z.string().max(240).optional(),
});

const rejectSchema = z.object({
  reason: z.string().min(3).max(500),
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

  app.get('/api/admin/virtual-account-requests', async () => ({ data: await listVirtualAccountRequests() }));

  app.get('/api/admin/virtual-accounts', async () => ({ data: await listVirtualAccounts() }));

  app.post('/api/admin/virtual-account-requests/:requestId/approve', async (request) => {
    const { requestId } = request.params as { requestId: string };
    return { data: await approveVirtualAccountRequest(requestId, actor(request)) };
  });

  app.post('/api/admin/virtual-account-requests/:requestId/reject', async (request) => {
    const { requestId } = request.params as { requestId: string };
    const body = parseBody(rejectSchema, request.body);
    return { data: await rejectVirtualAccountRequest(requestId, actor(request), body.reason) };
  });
}
