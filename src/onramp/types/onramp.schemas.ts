import { z } from 'zod';

export const createOnrampOrderSchema = z.object({
  userId: z.string().min(1),
  sourceCurrency: z.enum(['usd', 'gbp', 'eur']).default('usd'),
  sourcePaymentRail: z.string().optional(),
  destinationCurrency: z.enum(['usdc', 'usdt']).default('usdc'),
  destinationChain: z.enum(['ethereum', 'polygon', 'base', 'solana', 'arbitrum', 'avalanche_c_chain']).default('base'),
  destinationAddress: z.string().min(8),
  amount: z.coerce.number().positive()
});

export type CreateOnrampOrderInput = z.infer<typeof createOnrampOrderSchema>;
