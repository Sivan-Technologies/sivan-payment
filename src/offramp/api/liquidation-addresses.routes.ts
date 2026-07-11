import type { FastifyInstance } from 'fastify';
import { getLiquidationAddress, listLiquidationAddresses } from '../service/liquidation-addresses.service.js';

export async function liquidationAddressesRoutes(app: FastifyInstance) {
  app.get('/api/users/:userId/deposit-addresses', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await listLiquidationAddresses(userId) };
  });

  app.get('/api/deposit-addresses/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getLiquidationAddress(id) };
  });
}
