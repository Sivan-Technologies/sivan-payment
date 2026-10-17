import { z } from 'zod';
import { db } from '../../database/json-database.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { id, nowIso } from '../../shared/id.js';
import { env } from '../../config/env.js';
import { BreetNgnProvider } from '../../ngn/provider/breet.provider.js';
import type { GhsQuoteRecord } from '../../database/types.js';

export const createGhsQuoteSchema = z.object({
  userId: z.string().min(1),
  direction: z.enum(['onramp', 'offramp']),
  sourceCurrency: z.enum(['ghs', 'usdc', 'usdt']),
  destinationCurrency: z.enum(['ghs', 'usdc', 'usdt']),
  sourceAmount: z.string().min(1),
  network: z.string().optional(),
  payoutAccountId: z.string().min(1).optional(),
});

function fixedMoney(value: number, dp: number): string {
  if (!Number.isFinite(value)) return (0).toFixed(dp);
  return value.toFixed(dp);
}

export async function createGhsQuote(input: z.infer<typeof createGhsQuoteSchema>): Promise<GhsQuoteRecord> {
  const source = Number(input.sourceAmount);
  if (!Number.isFinite(source) || source <= 0) {
    throw badRequest('Invalid source amount');
  }

  // Cross-corridor validation: onramp is GHS -> Crypto, offramp is Crypto -> GHS
  if (input.direction === 'offramp') {
    if (input.sourceCurrency === 'ghs' || input.destinationCurrency !== 'ghs') {
      throw badRequest('Off-ramp requires crypto source (USDC/USDT) and GHS destination.');
    }
  } else {
    if (input.sourceCurrency !== 'ghs' || input.destinationCurrency === 'ghs') {
      throw badRequest('On-ramp requires GHS source and crypto destination (USDC/USDT).');
    }
  }

  // Default exchange rate fallback if live provider is offline: 1 USD = 19.50 GHS
  let rate = 19.5;
  const breetConfigured = Boolean(env.BREET_APP_ID && env.BREET_APP_SECRET);

  if (breetConfigured) {
    try {
      const provider = new BreetNgnProvider();
      const assets = await provider.loadAssets();
      const asset = assets.find((a: any) => /USDC|USDT/i.test(a.identifier));
      if (asset) {
        const response = await fetch(`https://api.breet.io/v1/trades/pbc/sell/rate-calculator/${encodeURIComponent(asset.id)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-app-id': String(env.BREET_APP_ID),
            'x-app-secret': String(env.BREET_APP_SECRET),
            'X-Breet-Env': env.BREET_ENV === 'production' ? 'production' : 'development',
          },
          body: JSON.stringify({ amountInUSD: 1, currency: 'ghs' }),
        });
        const body: any = await response.json().catch(() => ({}));
        const parsedRate = Number(body?.data?.rate);
        if (Number.isFinite(parsedRate) && parsedRate > 0) {
          rate = parsedRate;
        }
      }
    } catch {
      // Graceful fallback to default rate in test / offline mode
    }
  }

  // Sivan fee: 0.5% platform routing fee
  const feePercent = 0.005;
  let destinationAmount: number;
  let feeAmount: number;

  if (input.direction === 'offramp') {
    // Crypto in -> GHS out
    feeAmount = source * feePercent;
    const netCrypto = Math.max(source - feeAmount, 0);
    destinationAmount = netCrypto * rate;
  } else {
    // GHS in -> Crypto out
    const grossCrypto = source / rate;
    feeAmount = grossCrypto * feePercent;
    destinationAmount = Math.max(grossCrypto - feeAmount, 0);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

  const quote: GhsQuoteRecord = {
    id: id('ghsqu'),
    userId: input.userId,
    provider: 'breet',
    providerQuoteId: `breet_ghs_${id('quote')}`,
    direction: input.direction,
    sourceCurrency: input.sourceCurrency,
    destinationCurrency: input.destinationCurrency,
    sourceAmount: fixedMoney(source, input.sourceCurrency === 'ghs' ? 2 : 6),
    destinationAmount: fixedMoney(destinationAmount, input.destinationCurrency === 'ghs' ? 2 : 6),
    rate: fixedMoney(rate, 4),
    feeAmount: fixedMoney(feeAmount, 6),
    network: input.network ?? 'base',
    payoutAccountId: input.payoutAccountId,
    expiresAt,
    metadata: {
      provider: 'breet',
      currency: 'ghs',
      feePercent: '0.5%',
    },
    createdAt: now.toISOString(),
  };

  await db.upsertGhsQuoteRecord(quote);
  return quote;
}

export async function listGhsQuotes(userId?: string): Promise<GhsQuoteRecord[]> {
  return db.listGhsQuotes(userId);
}

export async function findGhsQuoteById(id: string): Promise<GhsQuoteRecord | null> {
  return db.findGhsQuoteById(id);
}
