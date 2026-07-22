import type { FastifyInstance } from 'fastify';
import { parseBody } from '../../shared/validation.js';
import { createExternalAccount, createExternalAccountSchema, getExternalAccount, listExternalAccounts, verifyExternalAccount } from '../service/external-accounts.service.js';

export async function externalAccountsRoutes(app: FastifyInstance) {
  app.post('/api/external-accounts', async (request, reply) => {
    const body = parseBody(createExternalAccountSchema, request.body);
    const account = await createExternalAccount(body);
    return reply.code(201).send({ data: account });
  });

  app.post('/api/users/:userId/external-accounts', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const rawBody = (request.body as Record<string, unknown>) || {};
    const body = parseBody(createExternalAccountSchema, { ...rawBody, userId });
    const account = await createExternalAccount(body);
    return reply.code(201).send({ data: account });
  });

  app.get('/api/users/:userId/external-accounts', async (request) => {

    const { userId } = request.params as { userId: string };
    return { data: await listExternalAccounts(userId) };
  });

  app.get('/api/external-accounts/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getExternalAccount(id) };
  });

  app.post('/api/external-accounts/:id/verify', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await verifyExternalAccount(id) };
  });
}
