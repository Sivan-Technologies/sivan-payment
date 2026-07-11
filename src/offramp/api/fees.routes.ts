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
    return { data: getDefaultOfframpFeePolicy() };
  });

  app.post('/api/fees/offramp/estimate', async (request) => {
    const body = parseBody(feeEstimateSchema, request.body);
    return { data: estimateFee(body) };
  });

  app.get('/api/fees/costs/bridge', async () => {
    return { data: getBridgeCostPolicy() };
  });

  app.post('/api/fees/economics/estimate', async (request) => {
    const body = parseBody(economicsEstimateSchema, request.body);
    return { data: estimateEconomics(body) };
  });
}
