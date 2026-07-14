import type { FastifyInstance } from 'fastify';
import { parseBody } from '../shared/validation.js';
import { listPaymentControls, updatePaymentControls, updatePaymentControlsSchema } from './payment-controls.service.js';

export async function paymentControlsRoutes(app: FastifyInstance) {
  app.get('/api/offramp/controls', async () => ({ data: await listPaymentControls() }));

  app.get('/api/admin/offramp/controls', async () => ({ data: await listPaymentControls() }));

  app.put('/api/admin/offramp/controls', async (request) => {
    const body = parseBody(updatePaymentControlsSchema, request.body);
    return { data: await updatePaymentControls(body) };
  });
}
