import type { FastifyInstance } from 'fastify';
import { parseBody } from '../../shared/validation.js';
import { createWithdrawal, createWithdrawalSchema, getWithdrawal, getWithdrawalDeposit, listWithdrawals, syncWithdrawalDrains } from '../service/withdrawals.service.js';

export async function withdrawalsRoutes(app: FastifyInstance) {
  app.post('/api/withdrawals', async (request, reply) => {
    const body = parseBody(createWithdrawalSchema, request.body);
    const result = await createWithdrawal(body);
    return reply.code(201).send({ data: result });
  });

  app.get('/api/users/:userId/withdrawals', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await listWithdrawals(userId) };
  });

  app.get('/api/withdrawals/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getWithdrawal(id) };
  });

  app.get('/api/withdrawals/:id/deposit-address', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getWithdrawalDeposit(id) };
  });

  app.post('/api/withdrawals/:id/sync-drains', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await syncWithdrawalDrains(id) };
  });
}
