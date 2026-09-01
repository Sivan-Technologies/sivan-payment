import type { FastifyInstance } from 'fastify';
import { fraudClient, type FraudEvaluationInput } from './fraud-client.js';

export async function fraudSecurityRoutes(app: FastifyInstance) {
  app.get('/api/v1/security/fraud/status', async () => ({
    status: 'ok',
    fraudEngineIntegrated: true,
    mode: 'active_radar',
    timestamp: new Date().toISOString(),
  }));

  app.post('/api/v1/security/fraud/evaluate', async (request, reply) => {
    const body = (request.body || {}) as FraudEvaluationInput;
    if (!body.userId || body.amount == null || !body.currency) {
      return reply.code(400).send({
        error: { message: 'Missing required fraud evaluation fields' },
      });
    }

    try {
      const evaluation = await fraudClient.evaluate(body);
      return { data: evaluation };
    } catch (err: any) {
      return reply.code(500).send({ error: { message: err.message } });
    }
  });

  app.post('/api/v1/security/fraud/feedback', async (request, reply) => {
    const body = (request.body || {}) as any;
    if (!body.outcome) {
      return reply.code(400).send({
        error: { message: 'Missing outcome in feedback payload' },
      });
    }

    try {
      const success = await fraudClient.sendFeedback(body);
      return { data: { success } };
    } catch (err: any) {
      return reply.code(500).send({ error: { message: err.message } });
    }
  });
}
