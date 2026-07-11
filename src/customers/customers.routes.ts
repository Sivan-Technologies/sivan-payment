import type { FastifyInstance } from 'fastify';
import { parseBody } from '../shared/validation.js';
import { createBridgeCustomer, createBridgeCustomerSchema, getCustomerByUserId, refreshKycStatus, simulateSandboxKycApproval, startKyc, startKycSchema } from './customers.service.js';

export async function customersRoutes(app: FastifyInstance) {
  app.post('/api/customers/kyc-link', async (request, reply) => {
    const body = parseBody(startKycSchema, request.body);
    const customer = await startKyc(body);
    return reply.code(201).send({ data: customer });
  });

  app.post('/api/customers', async (request, reply) => {
    const body = parseBody(createBridgeCustomerSchema, request.body);
    const customer = await createBridgeCustomer(body);
    return reply.code(201).send({ data: customer });
  });

  app.get('/api/customers/:userId', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await getCustomerByUserId(userId) };
  });

  app.get('/api/customers/:userId/kyc-status', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await refreshKycStatus(userId) };
  });

  app.post('/api/customers/:userId/sandbox/simulate-kyc-approval', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await simulateSandboxKycApproval(userId) };
  });
}
