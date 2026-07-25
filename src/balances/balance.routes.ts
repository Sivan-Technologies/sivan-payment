import type { FastifyInstance } from 'fastify';
import { parseBody } from '../shared/validation.js';
import { adminBalanceAdjustmentSchema, balanceTransferControlsSchema, createAdminBalanceAdjustment, createBalanceTransferSchema, getBalanceTransferControls, getUserBalance, listAllBalanceTransfers, listUserBalanceLedger, listUserBalanceTransfers, requestBalanceTransfer, updateBalanceTransferControls } from './balance.service.js';

function actor(request: any) {
  return request.adminActor?.email || request.adminActor?.role || 'admin_api_key';
}

export async function balanceRoutes(app: FastifyInstance) {
  app.get('/api/users/:userId/balance', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await getUserBalance(userId) };
  });

  app.get('/api/users/:userId/balance/ledger', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await listUserBalanceLedger(userId) };
  });

  app.get('/api/users/:userId/balance/transfers', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await listUserBalanceTransfers(userId) };
  });

  app.post('/api/users/:userId/balance/transfers', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(createBalanceTransferSchema, request.body);
    return { data: await requestBalanceTransfer(userId, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.get('/api/admin/balance/controls', async () => ({ data: await getBalanceTransferControls() }));

  app.put('/api/admin/balance/controls', async (request) => {
    const body = parseBody(balanceTransferControlsSchema, request.body);
    return { data: await updateBalanceTransferControls({ ...body, updatedBy: actor(request) }, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.get('/api/admin/balance/transfers', async () => ({ data: await listAllBalanceTransfers() }));

  app.post('/api/admin/balance/adjustments', async (request) => {
    const body = parseBody(adminBalanceAdjustmentSchema, request.body);
    return { data: await createAdminBalanceAdjustment({ ...body, adjustedBy: actor(request) }, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });
}
