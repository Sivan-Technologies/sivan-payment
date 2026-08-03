import type { FastifyInstance } from 'fastify';
import { parseBody } from '../shared/validation.js';
import { AppError } from '../shared/errors.js';
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
    try {
      return { data: await getCustomerByUserId(userId) };
    } catch (error) {
      // A newly created account does not have a customer/KYC record until the
      // user starts verification. Return a customer-safe empty state instead of
      // a noisy 404 that appears as an error in the browser console.
      if (error instanceof AppError && error.code === 'not_found') return { data: null };
      throw error;
    }
  });

  /**
   * "NO BRIDGE CUSTOMER" IS AN ABSENCE, NOT AN ERROR.
   *
   * A Nigerian who verifies by bank check never has a Bridge customer record,
   * so this 404'd for every single one of them - twice per visit, because the
   * KYC view polls. It shows up in the browser console as
   *
   *   GET /api/customers/usr_.../kyc-status 404 (Not Found)
   *
   * which is the normal, correct state of the largest user group in the
   * product being reported as a failure. It also trains everyone to ignore red
   * lines in the console, which is how a real 404 gets missed.
   *
   * The sibling route GET /api/customers/:userId already made exactly this
   * decision and returns null; this one did not, and the inconsistency was the
   * bug. The frontend was compensating with a regex on the error MESSAGE
   * (/customer not found/i) - a string match on prose, which breaks the day
   * the wording changes.
   *
   * A user who genuinely does not exist is still a 404: that comes from the
   * auth layer, which has already rejected a token that does not match
   * :userId before this handler runs.
   */
  app.get('/api/customers/:userId/kyc-status', async (request) => {
    const { userId } = request.params as { userId: string };
    try {
      return { data: await refreshKycStatus(userId) };
    } catch (error) {
      if (error instanceof AppError && error.code === 'not_found') return { data: null };
      throw error;
    }
  });

  app.post('/api/customers/:userId/sandbox/simulate-kyc-approval', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await simulateSandboxKycApproval(userId) };
  });
}
