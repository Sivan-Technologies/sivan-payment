import type { FastifyInstance } from 'fastify';
import { createOnrampOrder, getOnrampOrder, listOnrampOrders } from '../service/onramp-orders.service.js';
import { createOnrampOrderSchema } from '../types/onramp.schemas.js';
import { getOnrampFeePercent } from '../service/onramp-fees.service.js';
import { syncOnrampOrder } from '../service/onramp-sync.service.js';
import { parseBody } from '../../shared/validation.js';

export async function onrampOrdersRoutes(app: FastifyInstance) {
  app.get('/api/onramp/fees', async () => ({ data: { percent: await getOnrampFeePercent(), type: 'percentage' } }));

  app.post('/api/onramp/orders', async (request, reply) => {
    const body = parseBody(createOnrampOrderSchema, request.body);
    const order = await createOnrampOrder(body);
    return reply.code(201).send({ data: order });
  });

  app.get('/api/onramp/orders/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getOnrampOrder(id) };
  });

  app.post('/api/onramp/orders/:id/sync', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await syncOnrampOrder(id) };
  });

  app.get('/api/users/:userId/onramp-orders', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await listOnrampOrders(userId) };
  });
}
