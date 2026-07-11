import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody } from '../shared/validation.js';
import { providerCapabilities } from './provider-routing.js';
import { routeOfframpProvider } from './provider-registry.js';

const routeOfframpProviderSchema = z.object({
  sourceCurrency: z.literal('usdc').optional(),
  sourceChain: z.enum(['ethereum', 'polygon', 'base', 'solana', 'arbitrum', 'optimism']).optional(),
  destinationCurrency: z.enum(['usd', 'gbp', 'eur']).optional(),
  destinationCountry: z.string().min(2).optional(),
  destinationPaymentRail: z.string().min(1).optional(),
  amountUsd: z.string().optional(),
  complianceModel: z.enum(['first_party_withdrawal', 'third_party_payout', 'b2b_supplier_payout']).optional(),
  requiredSpeed: z.enum(['standard', 'same_day', 'instant']).optional(),
  preferredProvider: z.string().optional()
});

export async function providersRoutes(app: FastifyInstance) {
  app.get('/api/providers/offramp/capabilities', async () => {
    return { data: providerCapabilities };
  });

  app.post('/api/providers/offramp/route', async (request) => {
    const body = parseBody(routeOfframpProviderSchema, request.body);
    return { data: routeOfframpProvider(body) };
  });
}
