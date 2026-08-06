import type { FastifyInstance } from 'fastify';
import { parseBody } from '../../shared/validation.js';
import { bvnAccountMatchSchema, bvnInfoMatchSchema, getNgnKycProviderHealth, verifyNgnBvnBankAccount, verifyNgnBvnIdentity } from '../service/ngn-kyc-level.service.js';

export async function kycLevelRoutes(app: FastifyInstance) {
  app.get('/api/admin/kyc/ngn/provider-health', async () => ({ data: await getNgnKycProviderHealth() }));

  app.post('/api/users/:userId/kyc/ngn-bvn/verify', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(bvnInfoMatchSchema, request.body);
    return { data: await verifyNgnBvnIdentity(userId, body) };
  });

  app.post('/api/users/:userId/kyc/ngn-bank-account/match', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(bvnAccountMatchSchema, request.body);
    return { data: await verifyNgnBvnBankAccount(userId, body) };
  });
}
