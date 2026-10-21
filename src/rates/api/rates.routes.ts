import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env.js';
import { getNgnControls } from '../../ngn/service/ngn-controls.service.js';
import { getNgnProvider } from '../../ngn/provider/ngn-provider-registry.js';
import { createGhsQuote } from '../../ghs/service/ghs-quotes.service.js';
import { getAdminFeeSettings } from '../../admin/admin-fees.service.js';

interface CachedRateEntry {
  data: any;
  cachedAt: number;
}

const SERVER_CACHE_TTL_MS = 60_000;
let cachedRates: CachedRateEntry | null = null;

async function fetchLiveMarketRates(): Promise<any> {
  const now = Date.now();
  if (cachedRates && now - cachedRates.cachedAt < SERVER_CACHE_TTL_MS) {
    return cachedRates.data;
  }

  const result: any = {};
  const timestamp = new Date().toISOString();

  // 1. Fetch NGN live rate
  try {
    const controls = await getNgnControls();
    if (controls.offrampEnabled) {
      const breetConfigured = Boolean(env.BREET_APP_ID && env.BREET_APP_SECRET);
      const providerName = breetConfigured ? 'breet' : (controls.activeProvider ?? 'breet');
      const provider = getNgnProvider(providerName);

      const rawQuoteUsdc = await provider.createQuote({
        userId: 'rate_query',
        direction: 'offramp',
        sourceCurrency: 'usdc',
        destinationCurrency: 'ngn',
        sourceAmount: '10',
        network: 'solana',
      });

      let rawQuoteUsdt = rawQuoteUsdc;
      try {
        rawQuoteUsdt = await provider.createQuote({
          userId: 'rate_query',
          direction: 'offramp',
          sourceCurrency: 'usdt',
          destinationCurrency: 'ngn',
          sourceAmount: '10',
          network: 'solana',
        });
      } catch {
        rawQuoteUsdt = rawQuoteUsdc;
      }

      const grossRate = Number(rawQuoteUsdc.rate);
      const usdtGross = Number(rawQuoteUsdt.rate) || grossRate;

      if (Number.isFinite(grossRate) && grossRate > 0) {
        const settings = await getAdminFeeSettings();
        const ngnOfframpPercent = Number(settings.ngnOfframpFeePercent ?? 0);
        const baseOfframpPercent = Number(settings.offrampFeePercent ?? 0);
        const sivanPercent = ngnOfframpPercent > 0 ? ngnOfframpPercent : (baseOfframpPercent > 0 ? baseOfframpPercent : 1);
        const providerPercent = Number(env.BREET_FEE_PERCENT ?? 0.5);
        const totalPercent = sivanPercent + providerPercent;

        const netRate = Math.round(grossRate * (1 - totalPercent / 100));
        const usdtSell = Math.round(usdtGross * (1 - totalPercent / 100));

        result.ngn = {
          usdc: {
            sell: netRate,
            buy: Math.round(grossRate * 0.99),
            mid: Math.round((grossRate + netRate) / 2),
          },
          usdt: {
            sell: usdtSell,
            buy: Math.round(usdtGross * 0.99),
            mid: Math.round((usdtGross + usdtSell) / 2),
          },
          grossRate: Math.round(grossRate),
          netRate,
          sivanMarginPercent: sivanPercent,
          providerFeePercent: providerPercent,
          totalPercent,
          source: providerName,
          updatedAt: timestamp,
        };
      }
    }
  } catch (err: any) {
    console.warn('[rates/live] NGN rate query failed:', err?.message || err);
  }

  // 2. Fetch GHS live rate
  try {
    const ghsQuote = await createGhsQuote({
      userId: 'rate_query',
      direction: 'offramp',
      sourceCurrency: 'usdc',
      destinationCurrency: 'ghs',
      sourceAmount: '10',
    });

    if (ghsQuote) {
      const dest = parseFloat(String(ghsQuote.destinationAmount));
      const src = parseFloat(String(ghsQuote.sourceAmount));
      const netGhsRate =
        Number.isFinite(dest) && Number.isFinite(src) && src > 0
          ? dest / src
          : Number(ghsQuote.rate);

      if (Number.isFinite(netGhsRate) && netGhsRate > 0) {
        const roundedGhs = parseFloat(netGhsRate.toFixed(2));
        result.ghs = {
          usdc: {
            sell: roundedGhs,
            buy: parseFloat((roundedGhs * 0.99).toFixed(2)),
            mid: roundedGhs,
          },
          usdt: {
            sell: roundedGhs,
            buy: parseFloat((roundedGhs * 0.99).toFixed(2)),
            mid: roundedGhs,
          },
          grossRate: parseFloat(Number(ghsQuote.rate).toFixed(2)),
          netRate: roundedGhs,
          source: 'breet',
          updatedAt: timestamp,
        };
      }
    }
  } catch (err: any) {
    console.warn('[rates/live] GHS rate query failed:', err?.message || err);
  }

  if (Object.keys(result).length > 0) {
    cachedRates = { data: result, cachedAt: now };
  }

  return result;
}

export async function ratesRoutes(app: FastifyInstance) {
  const handler = async (request: any) => {
    const query = request.query ?? {};
    const corridorsParam = String(query.corridors ?? query.corridor ?? 'both').toLowerCase();
    const needNgn = corridorsParam.includes('ngn') || corridorsParam === 'both';
    const needGhs = corridorsParam.includes('ghs') || corridorsParam === 'both';

    const allRates = await fetchLiveMarketRates();
    const filtered: any = {};
    if (needNgn && allRates.ngn) filtered.ngn = allRates.ngn;
    if (needGhs && allRates.ghs) filtered.ghs = allRates.ghs;

    return { data: filtered };
  };

  app.get('/api/rates/live', handler);
  app.get('/rates/live', handler);
  app.get('/api/payment/rates/live', handler);
}
