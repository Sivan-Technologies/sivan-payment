import type { FastifyInstance } from 'fastify';
import { processBridgeWebhook } from './webhooks.service.js';
import { processPaystackWebhook, PaystackWebhookError } from './paystackWebhookHandler.js';
import { processMoneyGramWebhook, MoneyGramWebhookError } from './moneygramWebhookHandler.js';
import { getBankingRailAdapter } from '../banking-rail/banking-rail-registry.js';
import { sivanCheckoutService } from '../ngn/service/sivan-checkout.service.js';

export async function webhooksRoutes(app: FastifyInstance) {
  app.post('/api/webhooks/bridge', async (request, reply) => {
    const rawBody = (request as any).rawBody as Buffer | undefined;
    const signature = request.headers['x-webhook-signature'];
    const signatureHeader = Array.isArray(signature) ? signature[0] : signature;
    const result = await processBridgeWebhook(
      (request.body ?? {}) as any,
      rawBody ?? Buffer.from(JSON.stringify(request.body ?? {})),
      signatureHeader
    );
    return reply.code(200).send({ data: result });
  });

  const handlePaystackWebhook = async (request: any, reply: any) => {
    const rawBody = request.rawBody as Buffer | undefined;
    const signature = request.headers['x-paystack-signature'];
    const signatureHeader = Array.isArray(signature) ? signature[0] : signature;

    try {
      const result = await processPaystackWebhook(
        request.body ?? {},
        rawBody ?? Buffer.from(JSON.stringify(request.body ?? {})),
        signatureHeader
      );
      return reply.code(200).send({ data: result });
    } catch (error) {
      if (error instanceof PaystackWebhookError) {
        return reply.code(error.statusCode).send({
          error: {
            name: error.name,
            message: error.message,
          },
        });
      }
      throw error;
    }
  };

  const handleMoneyGramWebhook = async (request: any, reply: any) => {
    const rawBody = request.rawBody as Buffer | undefined;
    const raw = rawBody ?? Buffer.from(JSON.stringify(request.body ?? {}));

    try {
      await processMoneyGramWebhook(
        request.body ?? {},
        raw,
        request.headers
      );
      // MoneyGram specification requires HTTP 200 with an EMPTY body.
      return reply.code(200).type('text/plain').send('');
    } catch (error) {
      if (error instanceof MoneyGramWebhookError) {
        return reply.code(error.statusCode).send({
          error: {
            name: error.name,
            message: error.message,
          },
        });
      }
      throw error;
    }
  };

  app.post('/api/webhooks/paystack', handlePaystackWebhook);
  app.post('/webhooks/paystack', handlePaystackWebhook);

  const handleNombaWebhook = async (request: any, reply: any) => {
    const rawBody = request.rawBody as Buffer | undefined;
    const raw = rawBody ?? Buffer.from(JSON.stringify(request.body ?? {}));
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers[key.toLowerCase()] = value;
      else if (Array.isArray(value) && typeof value[0] === 'string') headers[key.toLowerCase()] = value[0];
    }

    try {
      const adapter = getBankingRailAdapter('nomba');
      const isValid = adapter.verifyWebhookSignature(raw, headers);

      if (!isValid && process.env.APP_ENV === 'production') {
        console.warn('[nomba-webhook] Signature verification failed in production');
        return reply.code(401).send({ error: 'invalid_signature' });
      }

      const event = adapter.parseWebhookEvent(raw);
      console.log(`[nomba-webhook] Ingested event: ${event.type}`);

      if (event.type === 'deposit.received') {
        const orderRef = event.reference || '';
        // If reference indicates a Sivan checkout order (deposit or agreement funding)
        if (orderRef.startsWith('sivan_') || orderRef.startsWith('agr_') || String(event.providerCustomerId || '').startsWith('sivan_')) {
          const verification = await sivanCheckoutService.verifyCheckoutTransaction(orderRef, 'nomba').catch(() => null);
          if (verification && verification.verified) {
            await sivanCheckoutService.processCheckoutSuccess(verification).catch((err) => {
              console.warn('[nomba-webhook] Checkout success auto-processing notice:', err.message);
            });
          }
        }

        // If reference or userId matches an agreement, notify agreement sync
        const targetId = event.userId.startsWith('agr_') ? event.userId : event.providerCustomerId;
        if (targetId.startsWith('agr_') && !orderRef.startsWith('sivan_agr_')) {
          const agreementId = targetId.replace(/^agr_/, '');
          console.log(`[nomba-webhook] Agreement deposit received for agreementId: ${agreementId}, amount: ${event.amountKobo}`);
          const escrowUrl = process.env.CORE_API_BASE_URL || process.env.ESCROW_AGENT_URL;
          const coreSecret = process.env.CORE_API_SECRET;
          if (escrowUrl && coreSecret) {
            void fetch(`${escrowUrl.replace(/\/$/, '')}/api/escrows/${encodeURIComponent(agreementId)}/fund`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-core-api-key': coreSecret },
              body: JSON.stringify({ amountKobo: event.amountKobo, providerRef: event.reference, provider: 'nomba' }),
              signal: AbortSignal.timeout(4000),
            }).catch((err) => console.warn('[nomba-webhook] Agreement funding notification failed:', err.message));
          }
        }
      }

      return reply.code(200).send({ status: 'received', eventType: event.type });
    } catch (err: any) {
      console.error('[nomba-webhook] Webhook processing error:', err.message);
      return reply.code(200).send({ status: 'error_handled', message: err.message });
    }
  };

  app.post('/api/webhooks/nomba', handleNombaWebhook);
  app.post('/webhooks/nomba', handleNombaWebhook);
  app.get('/api/webhooks/nomba', async (_req, reply) => reply.code(200).send({ status: 'ok', service: 'nomba-webhook-receiver' }));
  app.get('/webhooks/nomba', async (_req, reply) => reply.code(200).send({ status: 'ok', service: 'nomba-webhook-receiver' }));

  app.post('/api/webhooks/moneygram', handleMoneyGramWebhook);
  app.post('/webhooks/moneygram', handleMoneyGramWebhook);
  app.post('/api/webhooks/ramps-sandbox', handleMoneyGramWebhook);
  app.post('/webhooks/ramps-sandbox', handleMoneyGramWebhook);
  app.post('/api/webhooks/ramps', handleMoneyGramWebhook);
  app.post('/webhooks/ramps', handleMoneyGramWebhook);
  app.get('/api/webhooks/moneygram', async (_req, reply) => {
    return reply.code(200).send({ status: 'ok', service: 'moneygram-webhook-receiver' });
  });
  app.get('/api/webhooks/ramps-sandbox', async (_req, reply) => {
    return reply.code(200).send({ status: 'ok', service: 'moneygram-webhook-receiver' });
  });
  app.get('/api/webhooks/ramps', async (_req, reply) => {
    return reply.code(200).send({ status: 'ok', service: 'moneygram-webhook-receiver' });
  });
}

