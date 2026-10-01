import type { FastifyInstance } from 'fastify';
import {
  moneyGramConfigSummary,
  anchorHost,
  moneyGramEnvironment,
} from '../config/moneygram.config.js';

export const SUPPORTED_MONEYGRAM_CORRIDORS = [
  {
    code: 'US',
    country: 'United States',
    currency: 'USD',
    symbol: '$',
    minAmountUsd: 10,
    maxAmountUsd: 2500,
    rate: 1.00,
    feePercent: 0,
  },
  {
    code: 'NG',
    country: 'Nigeria',
    currency: 'NGN',
    symbol: '₦',
    minAmountUsd: 10,
    maxAmountUsd: 1000,
    rate: 1620,
    feePercent: 0,
  },
  {
    code: 'KE',
    country: 'Kenya',
    currency: 'KES',
    symbol: 'KSh',
    minAmountUsd: 10,
    maxAmountUsd: 1500,
    rate: 129.8,
    feePercent: 0,
  },
  {
    code: 'GH',
    country: 'Ghana',
    currency: 'GHS',
    symbol: 'GH₵',
    minAmountUsd: 10,
    maxAmountUsd: 1000,
    rate: 15.5,
    feePercent: 0,
  },
  {
    code: 'EU',
    country: 'Eurozone',
    currency: 'EUR',
    symbol: '€',
    minAmountUsd: 10,
    maxAmountUsd: 2500,
    rate: 0.92,
    feePercent: 0,
  },
  {
    code: 'GB',
    country: 'United Kingdom',
    currency: 'GBP',
    symbol: '£',
    minAmountUsd: 10,
    maxAmountUsd: 2500,
    rate: 0.79,
    feePercent: 0,
  },
  {
    code: 'CA',
    country: 'Canada',
    currency: 'CAD',
    symbol: 'CA$',
    minAmountUsd: 10,
    maxAmountUsd: 2500,
    rate: 1.36,
    feePercent: 0,
  },
  {
    code: 'PH',
    country: 'Philippines',
    currency: 'PHP',
    symbol: '₱',
    minAmountUsd: 10,
    maxAmountUsd: 1500,
    rate: 58.4,
    feePercent: 0,
  },
];

export async function moneygramRoutes(app: FastifyInstance) {
  // Health & Gateway Readiness Probe
  app.get('/api/moneygram/health', async () => {
    return {
      status: 'healthy',
      service: 'sivan-moneygram-api',
      protocol: 'Sivan Ai Stellar Native Ramps',
      network: 'Stellar USDC',
      config: moneyGramConfigSummary(),
      timestamp: new Date().toISOString(),
    };
  });

  // Corridors & FX Rates Endpoint
  app.get('/api/moneygram/corridors', async () => {
    return {
      data: {
        corridors: SUPPORTED_MONEYGRAM_CORRIDORS,
        settlementAsset: 'USDC',
        settlementNetwork: 'Stellar',
        locationsWorldwide: '400,000+',
      },
    };
  });

  // RFQ Quote Generator for Cash Pickup or Cash In
  app.post<{
    Body: {
      amount: string | number;
      targetCurrency?: string;
      mode?: 'withdraw' | 'deposit';
    };
  }>('/api/moneygram/quote', async (request, reply) => {
    const { amount, targetCurrency = 'NGN', mode = 'withdraw' } = request.body || {};
    const numAmount = Number(amount);

    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_AMOUNT',
          message: 'Amount must be a positive number (between 5 and 50 USDC for testing)',
        },
      });
    }

    const corridor =
      SUPPORTED_MONEYGRAM_CORRIDORS.find((c) => c.currency.toUpperCase() === targetCurrency.toUpperCase()) ||
      SUPPORTED_MONEYGRAM_CORRIDORS[1]; // Default NGN

    const targetAmount = (numAmount * corridor.rate).toFixed(
      ['USD', 'EUR', 'GBP', 'CAD'].includes(corridor.currency) ? 2 : 0
    );

    return {
      data: {
        quoteId: `mg_quote_${Date.now()}`,
        mode,
        amountIn: numAmount.toFixed(2),
        assetIn: 'USDC',
        targetCurrency: corridor.currency,
        targetAmount,
        exchangeRate: corridor.rate,
        platformFeeUsd: '0.00',
        networkFeeUsd: '0.00',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    };
  });

  // SEP-24 Interactive Session Initiator
  app.post<{
    Body: {
      amount: string | number;
      targetCurrency?: string;
      mode?: 'withdraw' | 'deposit';
      recipientName?: string;
      recipientPhone?: string;
    };
  }>('/api/moneygram/session', async (request, reply) => {
    const {
      amount,
      targetCurrency = 'NGN',
      mode = 'withdraw',
      recipientName,
      recipientPhone,
    } = request.body || {};

    const numAmount = Number(amount) || 25;
    const txId = `mg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const host = anchorHost();
    const env = moneyGramEnvironment();

    const interactiveUrl = `${host}/stellarsepservice/sep24/interactive?transaction_id=${txId}&asset_code=USDC&amount=${numAmount}&currency=${targetCurrency}`;
    const moreInfoUrl = `${host}/stellarsepservice/sep24/transaction/more_info?id=${txId}`;

    return {
      data: {
        id: txId,
        mode,
        amount: numAmount.toFixed(2),
        asset: 'USDC',
        targetCurrency,
        recipientName: recipientName || 'Valued Customer',
        recipientPhone,
        interactiveUrl,
        moreInfoUrl,
        environment: env,
        status: 'pending_user_transfer_start',
        createdAt: new Date().toISOString(),
      },
    };
  });

  // Query Transaction Status by ID
  app.get<{
    Params: { id: string };
  }>('/api/moneygram/transactions/:id', async (request) => {
    const { id } = request.params;
    const host = anchorHost();

    return {
      data: {
        id,
        status: 'ready_for_pickup',
        statusLabel: 'Ready for Counter Pickup',
        externalTransactionId: '48291049',
        referencePin: '4829-1049',
        amountIn: '25.00',
        assetIn: 'USDC',
        moreInfoUrl: `${host}/stellarsepservice/sep24/transaction/more_info?id=${id}`,
        updatedAt: new Date().toISOString(),
      },
    };
  });
}
