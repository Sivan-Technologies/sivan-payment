import type { FastifyInstance } from 'fastify';
import { createOnrampOrder, getOnrampOrder, listOnrampOrders } from '../service/onramp-orders.service.js';
import { createOnrampOrderSchema } from '../types/onramp.schemas.js';
import { getOnrampFeePercent } from '../service/onramp-fees.service.js';
import { syncOnrampOrder } from '../service/onramp-sync.service.js';
import { getOnrampControls, onrampControlsSchema, updateOnrampControls } from '../service/onramp-controls.service.js';
import { parseBody } from '../../shared/validation.js';

export async function onrampOrdersRoutes(app: FastifyInstance) {
  app.get('/api/onramp/fees', async () => ({ data: { percent: await getOnrampFeePercent(), type: 'percentage' } }));
  app.get('/api/onramp/controls', async () => ({ data: await getOnrampControls() }));
  app.get('/api/admin/onramp/controls', async () => ({ data: await getOnrampControls() }));
  app.put('/api/admin/onramp/controls', async (request) => {
    const body = parseBody(onrampControlsSchema, request.body);
    return { data: await updateOnrampControls(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

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
