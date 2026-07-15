import type { FastifyInstance } from 'fastify';
import { parseBody } from '../../shared/validation.js';
import {
  economicsEstimateSchema,
  estimateEconomics,
  estimateFee,
  feeEstimateSchema,
  getBridgeCostPolicy,
  getDefaultOfframpFeePolicy
} from '../service/fees.service.js';

export async function feesRoutes(app: FastifyInstance) {
  app.get('/api/fees/offramp', async () => {
    return { data: await getDefaultOfframpFeePolicy() };
  });

  app.post('/api/fees/offramp/estimate', async (request) => {
    const body = parseBody(feeEstimateSchema, request.body);
    return { data: await estimateFee(body) };
  });

  app.get('/api/fees/costs/bridge', async () => {
    return { data: await getBridgeCostPolicy() };
  });

  app.post('/api/fees/economics/estimate', async (request) => {
    const body = parseBody(economicsEstimateSchema, request.body);
    return { data: await estimateEconomics(body) };
  });
}
