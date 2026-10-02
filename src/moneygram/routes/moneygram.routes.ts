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
  fetchAssetLimits,
} from '../service/anchor-discovery.service.js';
import {
  createMoneyGramSep24WithdrawSession,
  getMoneyGramSep24Transaction,
  sendStellarUsdcPayment,
  resolveStellarKeypair,
  MONEYGRAM_DEFAULT_IDENTITY,
  MoneyGramTransactionNotFound,
} from '../service/moneygram-session.service.js';
import {
  getMoneyGramControls,
  recordMoneyGramTransaction,
} from '../../admin/feature-controls.service.js';
import { MONEYGRAM_GLOBAL_CORRIDORS } from '../data/corridors.data.js';
import { verifyUserJwt } from '../../auth/jwt.js';
import { StrKey } from '@stellar/stellar-sdk';
import { db } from '../../database/json-database.js';

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

/**
 * ONE resolver for "who is withdrawing", used by every MoneyGram route.
 *
 * Three call sites previously each decided this for themselves. The session
 * route defaulted to the string "anonymous", the signing route defaulted to
 * "anonymous_user", and the browser sent back a G address on retry. All three
 * derive valid but DIFFERENT Stellar accounts, so a session was opened
 * against one account, funded against a second and signed from a third. Every
 * one of those mismatches surfaces as an opaque Horizon error.
 *
 * The authenticated subject wins over anything in the request body. A body
 * supplied identity selects which user's wallet is spent, so trusting it on
 * an authenticated call would let any caller drain another user's Stellar
 * wallet. It is honoured only when there is no token to contradict it, which
 * is the unauthenticated sandbox and demo path.
 *
 * If a Stellar G address is provided in the body, it is looked up in the
 * user wallets database to resolve the user's authentic identity.
 */
export async function resolveMoneyGramIdentity(
  request: any,
  bodyIdentity?: string
): Promise<string | undefined> {
  if (request?.authUser?.sub) return String(request.authUser.sub);

  const header: string | undefined = request?.headers?.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (token) {
    try {
      const payload = verifyUserJwt(token);
      if (payload?.sub) return String(payload.sub);
    } catch {
      // An unverifiable token is not an identity. Fall through rather than
      // trusting the body, which would make a forged token an upgrade path.
    }
  }

  const supplied = (bodyIdentity || '').trim();
  if (supplied) {
    if (StrKey.isValidEd25519PublicKey(supplied)) {
      try {
        const wallet = await db.findWalletByAddress(supplied);
        if (wallet?.userId) return wallet.userId;
      } catch {
        // Fall through
      }
    }
    return supplied;
  }
  return undefined;
}

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

async function resolveCorridorRate(corridorCurrency: string, numAmount: number, fallbackRate: number): Promise<number> {
  if (corridorCurrency.toUpperCase() === 'NGN') {
    try {
      const { getTextileFxQuote } = await import('../../wallets/celo/textile-fx.service.js');
      const fxQuote = await getTextileFxQuote('usdc_to_ngn', numAmount);
      if (fxQuote?.rate && Number.isFinite(fxQuote.rate) && fxQuote.rate > 0) {
        return Math.round(fxQuote.rate * 100) / 100;
      }
    } catch {
      // Fallback to corridor baseline
    }
  }
  return fallbackRate;
}

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

    /**
      * Limits come from the anchor, not from this file.
      *
      * This route used to hardcode a 5.00 minimum while MoneyGram enforces
      * 15. Quotes between 5 and 14.99 were accepted here, converted, shown
      * to the user, and only then rejected by the anchor with HTTP 400,
      * after the user had committed to the flow.
      */
    let limits;
    try {
      limits = await fetchAssetLimits('USDC', mode === 'deposit' ? 'deposit' : 'withdraw');
    } catch (err: any) {
      return reply.code(503).send({
        error: {
          code: 'MONEYGRAM_LIMITS_UNAVAILABLE',
          message:
            'Could not read MoneyGram\'s current amount limits, so this quote cannot be validated: ' +
            String(err?.message ?? err),
        },
      });
    }

    if (!limits.enabled) {
      return reply.code(503).send({
        error: {
          code: 'MONEYGRAM_ASSET_DISABLED',
          message: `MoneyGram has disabled USDC ${mode === 'deposit' ? 'cash-in' : 'cash-out'} right now.`,
        },
      });
    }

    const minAllowed = limits.minAmount;
    const maxAllowed = limits.maxAmount;

    if (!Number.isFinite(numAmount) || numAmount < minAllowed || numAmount > maxAllowed) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_AMOUNT',
          message: `Amount must be between $${minAllowed.toFixed(2)} and $${maxAllowed.toFixed(2)} USD for ${mode === 'deposit' ? 'cash-in' : 'cash-out'}. MoneyGram enforces this limit.`,
        },
      });
    }

    const queryKey = targetCurrency.toUpperCase().trim();
    const corridor =
      SUPPORTED_MONEYGRAM_CORRIDORS.find(
        (c) => c.currency === queryKey || c.code === queryKey || c.alpha3 === queryKey
      ) || SUPPORTED_MONEYGRAM_CORRIDORS[0]; // Default

    const exchangeRate = await resolveCorridorRate(corridor.currency, numAmount, corridor.rate);

    const targetAmount = (numAmount * exchangeRate).toFixed(
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
        exchangeRate,
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
      userAddressOrId,
    } = request.body || {};

    // Resolved once, here, so the session and the later signature agree.
    const identity = await resolveMoneyGramIdentity(request, userAddressOrId);

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
        userAddressOrId: identity,
      });

      return { data: session };
    } catch (err) {
      // Graceful fallback session generation using official MoneyGram XRamps widget URL
      const txId = `mg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const ramps = rampsApiKeys();
      const env = moneyGramEnvironment();

      let widgetUrl = `${ramps.baseUrl.replace('/api', '')}/sdk/widget.html?mode=${mode === 'deposit' ? 'on-ramp' : 'off-ramp'}&transaction_id=${txId}`;
      if (ramps.publicKey) {
        widgetUrl += `&key=${encodeURIComponent(ramps.publicKey)}`;
      }
      const moreInfoUrl = `${ramps.baseUrl.replace('/api', '')}/stellarsepservice/sep24/transaction/more_info?id=${txId}`;
      const interactiveUrl = widgetUrl;

      const corridor = SUPPORTED_MONEYGRAM_CORRIDORS.find((c) => c.currency === targetCurrency) || { rate: 1500 };
      const exchangeRate = await resolveCorridorRate(targetCurrency, numAmount, corridor.rate);
      const targetAmount = Math.round(numAmount * exchangeRate);

      await recordMoneyGramTransaction({
        id: txId,
        mode,
        amountUsdc: numAmount,
        targetCurrency,
        targetAmount,
        channel,
        // Same default the signer applies, so the degraded path records the
        // account it will actually pay from.
        userAddressOrId: identity ?? MONEYGRAM_DEFAULT_IDENTITY,
        status: 'pending_user_transfer_start',
        moreInfoUrl,
      });

      return {
        data: {
          id: txId,
          mode,
          /**
           * The fallback session must advertise the SAME account the signer
           * will use, otherwise the widget collects a payment from one
           * address while Sivan pays from another. Resolution can legitimately
           * throw in production when no institutional secret is configured, and
           * that must not turn a degraded session into a 500.
           */
          walletAddress: (() => {
            try {
              return resolveStellarKeypair(identity).publicKey();
            } catch {
              return undefined;
            }
          })(),
          rampsApiBaseUrl: ramps.baseUrl,
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
  }>('/api/moneygram/transactions/:id', async (request, reply) => {
    const { id } = request.params;
    const { userAddressOrId } = (request.query || {}) as { userAddressOrId?: string };
    try {
      const tx = await getMoneyGramSep24Transaction(
        id,
        await resolveMoneyGramIdentity(request, userAddressOrId)
      );
      return { data: tx };
    } catch (err) {
      /**
       * An unknown transaction is a 404, not a 200 with invented contents.
       * This endpoint previously answered every id with a "ready for pickup"
       * placeholder, so the client had no way to tell a real pickup from a
       * typo in the id.
       */
      if (err instanceof MoneyGramTransactionNotFound) {
        return reply.code(404).send({
          error: { code: 'MONEYGRAM_TRANSACTION_NOT_FOUND', message: err.message },
        });
      }
      throw err;
    }
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
      const resolvedIdentity = await resolveMoneyGramIdentity(request, userAddressOrId);
      const keypair = resolveStellarKeypair(resolvedIdentity);
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

