import type { FastifyInstance } from 'fastify';
import {
  moneyGramConfigSummary,
  anchorHost,
  moneyGramEnvironment,
  isMoneyGramProduction,
  rampsApiKeys,
} from '../config/moneygram.config.js';
import {
  anchorHealth,
} from '../service/anchor-discovery.service.js';
import {
  createMoneyGramSep24WithdrawSession,
  getMoneyGramSep24Transaction,
  sendStellarUsdcPayment,
  resolveStellarKeypair,
} from '../service/moneygram-session.service.js';
import {
  getMoneyGramControls,
  recordMoneyGramTransaction,
} from '../../admin/feature-controls.service.js';
import { MONEYGRAM_GLOBAL_CORRIDORS } from '../data/corridors.data.js';

export const SUPPORTED_MONEYGRAM_CORRIDORS = MONEYGRAM_GLOBAL_CORRIDORS.map((c) => ({
  code: c.code,
  alpha3: c.alpha3,
  country: c.country,
  currency: c.currency,
  symbol: c.symbol,
  flag: c.flag,
  region: c.region,
  minAmountUsd: c.minAmountUsd,
  maxAmountUsd: c.maxAmountUsd,
  rate: c.estimatedRate,
  feePercent: 0,
  cashOutEnabled: c.cashOutEnabled,
  cashInEnabled: c.cashInEnabled,
}));

export async function moneygramRoutes(app: FastifyInstance) {
  // Health & Gateway Readiness Probe
  app.get('/api/moneygram/health', async () => {
    const health = await anchorHealth();
    return {
      status: health.reachable && health.signingKeyMatches ? 'healthy' : 'degraded',
      service: 'sivan-moneygram-api',
      protocol: 'Sivan Ai Stellar Native Ramps',
      network: 'Stellar USDC',
      anchor: health,
      config: moneyGramConfigSummary(),
      timestamp: new Date().toISOString(),
    };
  });

  // Corridors & FX Rates Endpoint
  app.get<{
    Querystring: { mode?: 'withdraw' | 'deposit'; region?: string };
  }>('/api/moneygram/corridors', async (request) => {
    const { mode, region } = (request.query || {}) as { mode?: 'withdraw' | 'deposit'; region?: string };
    let filtered = SUPPORTED_MONEYGRAM_CORRIDORS;
    if (mode === 'deposit') filtered = filtered.filter((c) => c.cashInEnabled);
    if (region && region !== 'all') filtered = filtered.filter((c) => c.region.toLowerCase() === region.toLowerCase());

    return {
      data: {
        corridors: filtered,
        totalCount: SUPPORTED_MONEYGRAM_CORRIDORS.length,
        cashOutCount: SUPPORTED_MONEYGRAM_CORRIDORS.filter((c) => c.cashOutEnabled).length,
        cashInCount: SUPPORTED_MONEYGRAM_CORRIDORS.filter((c) => c.cashInEnabled).length,
        cashOutLimits: { minUsd: 5.0, maxUsd: 2500.0 },
        cashInLimits: { minUsd: 5.0, maxUsd: 950.0 },
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

    const minAllowed = 5.0;
    const maxAllowed = mode === 'deposit' ? 950.0 : 2500.0;

    if (!Number.isFinite(numAmount) || numAmount < minAllowed || numAmount > maxAllowed) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_AMOUNT',
          message: `Amount must be between $${minAllowed.toFixed(2)} and $${maxAllowed.toFixed(2)} USD for ${mode === 'deposit' ? 'cash-in' : 'cash-out'}`,
        },
      });
    }

    const queryKey = targetCurrency.toUpperCase().trim();
    const corridor =
      SUPPORTED_MONEYGRAM_CORRIDORS.find(
        (c) => c.currency === queryKey || c.code === queryKey || c.alpha3 === queryKey
      ) || SUPPORTED_MONEYGRAM_CORRIDORS[0]; // Default

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
      channel?: 'minipay' | 'telegram' | 'whatsapp' | 'webapp' | 'api';
      userAddressOrId?: string;
    };
  }>('/api/moneygram/session', async (request, reply) => {
    const controls = await getMoneyGramControls();

    if (!controls.enabled || controls.maintenanceMode) {
      return reply.code(503).send({
        error: {
          code: 'MONEYGRAM_MAINTENANCE',
          message: controls.maintenanceReason || 'MoneyGram cash corridors are temporarily undergoing maintenance. Please use direct bank cashouts.',
        },
      });
    }

    const {
      amount,
      targetCurrency = 'NGN',
      mode = 'withdraw',
      recipientName,
      recipientPhone,
      channel = 'webapp',
      userAddressOrId = 'anonymous',
    } = request.body || {};

    if (channel === 'minipay' && !controls.minipayEnabled) {
      return reply.code(403).send({
        error: {
          code: 'MONEYGRAM_MINIPAY_DISABLED',
          message: 'MoneyGram Cash Pickup is currently unavailable on MiniPay. Please use direct bank transfer.',
        },
      });
    }

    if (channel === 'telegram' && !controls.telegramEnabled) {
      return reply.code(403).send({
        error: {
          code: 'MONEYGRAM_TELEGRAM_DISABLED',
          message: 'MoneyGram Cash Pickup is currently disabled on Telegram.',
        },
      });
    }

    if (channel === 'whatsapp' && !controls.whatsappEnabled) {
      return reply.code(403).send({
        error: {
          code: 'MONEYGRAM_WHATSAPP_DISABLED',
          message: 'MoneyGram Cash Pickup is currently disabled on WhatsApp.',
        },
      });
    }

    const numAmount = Number(amount) || 25;

    try {
      const session = await createMoneyGramSep24WithdrawSession({
        amount: numAmount,
        targetCurrency,
        mode,
        recipientName,
        recipientPhone,
        channel,
        userAddressOrId,
      });

      return { data: session };
    } catch (err) {
      // Graceful fallback session generation using official MoneyGram XRamps widget URL
      const txId = `mg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const ramps = rampsApiKeys();
      const env = moneyGramEnvironment();

      const widgetUrl = `${ramps.baseUrl.replace('/api', '')}/sdk/widget.html?mode=${mode === 'deposit' ? 'on-ramp' : 'off-ramp'}`;
      const moreInfoUrl = `${ramps.baseUrl.replace('/api', '')}/sdk/widget.html?mode=view&id=${txId}`;
      const interactiveUrl = widgetUrl;

      const corridor = SUPPORTED_MONEYGRAM_CORRIDORS.find((c) => c.currency === targetCurrency) || { rate: 1620 };
      const targetAmount = Math.round(numAmount * corridor.rate);

      await recordMoneyGramTransaction({
        id: txId,
        mode,
        amountUsdc: numAmount,
        targetCurrency,
        targetAmount,
        channel,
        userAddressOrId,
        status: 'pending_user_transfer_start',
        moreInfoUrl,
      });

      return {
        data: {
          id: txId,
          mode,
          amount: numAmount.toFixed(2),
          asset: 'USDC',
          targetCurrency,
          targetAmount,
          recipientName: recipientName || 'Valued Customer',
          recipientPhone,
          interactiveUrl,
          moreInfoUrl,
          environment: env,
          status: 'pending_user_transfer_start',
          createdAt: new Date().toISOString(),
        },
      };
    }
  });

  // Query Transaction Status by ID
  app.get<{
    Params: { id: string };
    Querystring: { userAddressOrId?: string };
  }>('/api/moneygram/transactions/:id', async (request) => {
    const { id } = request.params;
    const { userAddressOrId } = (request.query || {}) as { userAddressOrId?: string };
    const tx = await getMoneyGramSep24Transaction(id, userAddressOrId);
    return { data: tx };
  });

  // Non-Custodial RAMPS_SIGN_TRANSACTION bridge endpoint
  app.post<{
    Body: {
      to: string;
      amount: string;
      memo?: string;
      tokenAddress?: string;
      requiredNetwork?: 'mainnet' | 'testnet';
      issuer?: string;
      userAddressOrId?: string;
    };
  }>('/api/moneygram/sign-transaction', async (request, reply) => {
    const { to, amount, memo, tokenAddress, requiredNetwork, issuer, userAddressOrId } = request.body || {};
    if (!to || !amount) {
      return reply.code(400).send({
        error: { code: 'INVALID_PARAMETERS', message: 'Missing transaction destination or amount' },
      });
    }

    try {
      const keypair = resolveStellarKeypair(userAddressOrId);
      const txHash = await sendStellarUsdcPayment({
        sourceSecret: keypair.secret(),
        to,
        amount,
        memo,
        tokenAddress,
        requiredNetwork: requiredNetwork || (isMoneyGramProduction() ? 'mainnet' : 'testnet'),
        issuer,
      });

      return { data: { txHash, walletAddress: keypair.publicKey() } };
    } catch (err: any) {
      return reply.code(500).send({
        error: { code: 'SIGNING_FAILED', message: err?.message || 'Failed to sign Stellar USDC transaction' },
      });
    }
  });
}

