import type { FastifyInstance } from 'fastify';
import { defaultMetaMapProvider } from '../providers/metamap-kyc.provider.js';
import { unauthorized, badRequest } from '../../shared/errors.js';
import { db } from '../../database/json-database.js';

export async function metamapKycRoutes(app: FastifyInstance) {
  /**
   * Generates a MetaMap verification session for a user.
   */
  app.post('/api/users/:userId/kyc/metamap/session', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = (request.body || {}) as { phone?: string; email?: string; flowId?: string };

    const session = await defaultMetaMapProvider.createVerificationSession({
      userId,
      phone: body.phone,
      email: body.email,
      flowId: body.flowId,
    });

    return { data: session };
  });

  /**
   * Webhook endpoint for MetaMap identity verification results.
   */
  app.post('/api/webhooks/metamap', async (request, reply) => {
    const rawBody = typeof request.body === 'string' ? request.body : JSON.stringify(request.body || {});
    const signature = request.headers['x-signature'] as string | undefined;

    const isValid = defaultMetaMapProvider.verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
      throw unauthorized('Invalid MetaMap webhook signature');
    }

    const payload = (typeof request.body === 'object' ? request.body : JSON.parse(rawBody)) as any;
    const parsed = defaultMetaMapProvider.parseWebhookResult(payload);

    if (parsed.userId) {
      const customer = await db.findCustomerByUserId(parsed.userId);

      if (parsed.isApproved) {
        if (customer) {
          customer.kycStatus = 'kyc_approved';
          customer.updatedAt = new Date().toISOString();
          await db.updateCustomerRecord(customer);
        }
      } else if (parsed.isRejected) {
        if (customer) {
          customer.kycStatus = 'kyc_rejected';
          customer.updatedAt = new Date().toISOString();
          await db.updateCustomerRecord(customer);
        }
      }
    }

    return reply.status(200).send({ received: true });
  });
}
