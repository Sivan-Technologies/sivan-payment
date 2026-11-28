import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  getTextileFxQuote,
  getEffectiveOfframpFeeConfig,
  requestFirmQuote,
  executeRedemption,
  getRedemptionStatus,
  listTextileBanks,
  resolveTextileBankAccount,
} from '../../wallets/celo/textile-fx.service.js';
import { celoRpc } from '../../wallets/celo/celo-rpc.js';
import { getAdminFeeSettings } from '../../admin/admin-fees.service.js';
import { offrampRegistry } from '../provider/offramp-registry.js';
import {
  verifyFastifyAgentRequest,
  assertSelfAgentLimit,
} from '../../security/self-agent-verifier.service.js';

interface CashoutQuoteQuery {
  token?: string;
  amount?: string | number;
  bankAccount?: string;
  bankCode?: string;
}

interface CashoutExecuteBody {
  quoteId?: string;
  celoTxHash?: string;
  token: string;
  amount: number;
  bankAccount: string;
  bankCode: string;
  senderAddress?: string;
}

// Canonical Textile Swap settlement contract on Celo Mainnet (UniswapX LimitOrderReactor)
const TEXTILE_CELO_LIMIT_ORDER_REACTOR = process.env.TEXTILE_SWAP_ROUTER_ADDRESS || '0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3';

// Official Sivan Agent #10089 Celo Mainnet Treasury for Off-Ramp Liquidity Collection
const SIVAN_CELO_OFFRAMP_VAULT = process.env.SIVAN_CELO_AGENT_ADDRESS || '0x46eFfe0409BFE99b0435e7bb7219DC6586612345';

function getTextileOfframpDepositAddress(): string {
  const addr = process.env.TEXTILE_CELO_DEPOSIT_ADDRESS;
  if (addr && addr.toLowerCase() !== TEXTILE_CELO_LIMIT_ORDER_REACTOR.toLowerCase()) {
    return addr;
  }
  return SIVAN_CELO_OFFRAMP_VAULT;
}

export async function celoCashoutRoutes(app: FastifyInstance) {
  /**
   * GET /api/v1/cashout/quote
   * Fetches live off-ramp quote for USDC, USDT, cUSD, or cNGN on Celo to Nigerian Bank.
   */
  app.get('/api/v1/cashout/quote', async (request: FastifyRequest<{ Querystring: CashoutQuoteQuery }>, reply: FastifyReply) => {
    try {
      const token = (request.query.token || 'USDC').toUpperCase();
      const amount = parseFloat(String(request.query.amount || '10'));
      const bankAccount = request.query.bankAccount || '';
      const bankCode = request.query.bankCode || '';

      if (isNaN(amount) || amount <= 0) {
        return reply.code(400).send({ error: 'Invalid cashout amount. Must be greater than 0.' });
      }

      // If bankAccount and bankCode are provided and token is USDC, get firm quote from Textile
      if (bankAccount && bankCode && (token === 'USDC' || token === 'USDT')) {
        try {
          const firmQuote = await requestFirmQuote(amount, bankAccount, bankCode);
          return reply.send({
            status: 'ok',
            quoteType: 'firm',
            token,
            inputAmount: amount,
            rate: firmQuote.lockedRate,
            grossNgn: firmQuote.grossNgn,
            sivanFeeNgn: firmQuote.sivanFeeNgn,
            netNgn: firmQuote.netNgn,
            quoteId: firmQuote.quoteId,
            depositAddress: firmQuote.depositAddress || getTextileOfframpDepositAddress(),
            validForSeconds: firmQuote.validForSeconds,
            expiresAt: firmQuote.expiresAt,
          });
        } catch (firmErr: any) {
          // Fall back to indicative RFQ quote if firm request encounters non-fatal configuration gap
          request.log.warn({ err: firmErr }, 'Firm quote fallback to RFQ');
        }
      }

      // Default indicative RFQ quote: cNGN has strict 1:1 parity with physical Nigerian Naira
      if (token === 'CNGN' || token === 'cNGN') {
        const feeConfig = await getEffectiveOfframpFeeConfig();
        const grossNgn = amount; // 1:1 Parity
        let rawFee = grossNgn * (feeConfig.percent / 100);
        let sivanFeeNgn = Math.min(Math.max(rawFee, feeConfig.minFeeFloorNgn), feeConfig.maxFeeCapNgn);
        if (sivanFeeNgn >= grossNgn) {
          sivanFeeNgn = Math.round(grossNgn * 0.05 * 100) / 100;
        }
        sivanFeeNgn = Math.round(sivanFeeNgn * 100) / 100;
        const netNgn = Math.round((grossNgn - sivanFeeNgn) * 100) / 100;

        return reply.send({
          status: 'ok',
          quoteType: 'indicative',
          token: 'cNGN',
          inputAmount: amount,
          rate: 1.0,
          grossNgn,
          sivanFeeNgn,
          netNgn,
          depositAddress: getTextileOfframpDepositAddress(),
          eta: 'typically under 1 to 2 minutes via NIBSS / NIP',
        });
      }

      // USDC, USDT, or cUSD indicative quote via Textile Credit
      try {
        const fxQuote = await getTextileFxQuote('usdc_to_cngn', amount);
        return reply.send({
          status: 'ok',
          quoteType: 'indicative',
          token,
          inputAmount: amount,
          rate: fxQuote.rate,
          grossNgn: fxQuote.outputAmount,
          sivanFeeNgn: fxQuote.sivanFee,
          netNgn: fxQuote.netOutput,
          depositAddress: getTextileOfframpDepositAddress(),
          quotedAt: fxQuote.quotedAt,
          expiresAt: fxQuote.expiresAt,
          eta: 'typically under 1 to 2 minutes via NIBSS / NIP',
        });
      } catch (quoteErr: any) {
        request.log.error({ err: quoteErr, token, amount }, 'Live Textile FX quote failed');
        return reply.code(503).send({
          status: 'error',
          error: 'Live FX quote is temporarily unavailable from Textile FX. Please try again.',
        });
      }
    } catch (err: any) {
      request.log.error({ err }, 'Cashout quote failed');
      return reply.code(500).send({ error: err.message || 'Failed to generate cashout quote' });
    }
  });

  /**
   * POST /api/v1/cashout/execute
   * Confirms the on-chain Celo transaction and initiates bank payout via Textile Credit.
   */
  app.post('/api/v1/cashout/execute', async (request: FastifyRequest<{ Body: CashoutExecuteBody }>, reply: FastifyReply) => {
    try {
      const { quoteId, celoTxHash, token, amount, bankAccount, bankCode, senderAddress } = request.body || {};

      const resolvedTxHash = (celoTxHash || '').trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(resolvedTxHash)) {
        return reply.code(400).send({ error: 'Valid 66-character Celo transaction hash (celoTxHash) is required.' });
      }

      if (!bankAccount || bankAccount.length !== 10) {
        return reply.code(400).send({ error: 'Valid 10-digit Nigerian NUBAN bank account is required.' });
      }

      // Enforce Self Agent ID verification for Celo Off-Ramp
      const selfVerification = await verifyFastifyAgentRequest(request);
      const limitCheck = assertSelfAgentLimit(selfVerification, Number(amount || 0), 'CeloFiatOfframp');
      if (!limitCheck.allowed) {
        return reply.code(403).send(limitCheck.errorResponse);
      }

      // Verify on-chain Celo transaction receipt before initiating any fiat redemption
      const receipt = await celoRpc<any>('eth_getTransactionReceipt', [resolvedTxHash]).catch((rpcErr: any) => {
        request.log.error({ err: rpcErr, celoTxHash: resolvedTxHash }, 'Celo RPC receipt lookup failed');
        return undefined;
      });

      if (receipt === undefined) {
        return reply.code(502).send({ error: 'Unable to verify Celo transaction receipt on-chain. Please retry.' });
      }
      if (!receipt) {
        return reply.code(409).send({ error: 'Celo transaction receipt not found on-chain yet. Wait for confirmation.' });
      }
      if (receipt.status !== '0x1') {
        return reply.code(400).send({ error: 'Celo transaction reverted or failed on-chain (status != 0x1).' });
      }
      if (
        senderAddress &&
        typeof receipt.from === 'string' &&
        receipt.from.toLowerCase() !== senderAddress.trim().toLowerCase()
      ) {
        return reply.code(400).send({ error: 'On-chain transaction sender does not match senderAddress.' });
      }

      request.log.info({
        event: 'cashout_execution_initiated',
        token,
        amount,
        bankAccount,
        bankCode,
        celoTxHash: resolvedTxHash,
        blockNumber: receipt.blockNumber,
        senderAddress: receipt.from || senderAddress,
      }, 'Verified Celo transaction receipt; initiating off-ramp redemption');

      if (!quoteId) {
        return reply.code(400).send({ error: 'A valid provider quoteId is required to execute fiat redemption.' });
      }

      const apiKey = (process.env.TEXTILE_CREDIT_API_KEY || '').trim();
      if (!apiKey) {
        request.log.error({ event: 'textile_api_key_missing' }, 'TEXTILE_CREDIT_API_KEY is not configured');
        return reply.code(503).send({ error: 'Textile FX is not configured on this environment.' });
      }

      try {
        const redemption = await executeRedemption(quoteId, resolvedTxHash);
        return reply.code(200).send({
          status: 'processing',
          provider: 'textile_credit',
          redemptionId: redemption.redemptionId,
          celoTxHash: resolvedTxHash,
          blockNumber: receipt.blockNumber,
          eta: 'typically under 1 to 2 minutes via NIBSS / NIP',
        });
      } catch (textileErr: any) {
        request.log.error({ err: textileErr, celoTxHash: resolvedTxHash, quoteId }, 'Textile redemption dispatch failed');
        return reply.code(502).send({
          status: 'error',
          settlementStatus: 'pending',
          celoTxHash: resolvedTxHash,
          error: textileErr?.message || 'Provider redemption dispatch failed; settlement remains pending until confirmed.',
        });
      }
    } catch (err: any) {
      request.log.error({ err }, 'Cashout execution failed');
      return reply.code(500).send({ error: err.message || 'Failed to execute cashout redemption' });
    }
  });

  /**
   * GET /api/v1/cashout/status/:redemptionId
   * Checks the status of an ongoing redemption.
   */
  app.get('/api/v1/cashout/status/:redemptionId', async (request: FastifyRequest<{ Params: { redemptionId: string } }>, reply: FastifyReply) => {
    const { redemptionId } = request.params;
    if (!redemptionId || !redemptionId.startsWith('TXT-')) {
      return reply.code(404).send({
        status: 'error',
        error: 'Unknown redemption reference. Only provider-tracked TXT- redemptions can be queried.',
        data: {
          redemptionId,
          settlementStatus: 'unknown',
          confirmed: false,
        },
      });
    }

    if (!process.env.TEXTILE_CREDIT_API_KEY) {
      request.log.error({ event: 'textile_api_key_missing', redemptionId }, 'TEXTILE_CREDIT_API_KEY is not configured');
      return reply.code(503).send({
        status: 'error',
        error: 'Provider status lookup is unavailable on this environment.',
        data: {
          redemptionId,
          settlementStatus: 'pending',
          confirmed: false,
        },
      });
    }

    try {
      const result = await getRedemptionStatus(redemptionId);
      return reply.send({ status: 'ok', data: result });
    } catch (err: any) {
      request.log.error({ err, redemptionId }, 'Failed to fetch authoritative redemption status');
      return reply.code(502).send({
        status: 'error',
        error: err?.message || 'Unable to verify redemption status with provider.',
        data: {
          redemptionId,
          settlementStatus: 'pending',
          confirmed: false,
        },
      });
    }
  });

  /**
   * GET /api/v1/cashout/banks
   * Official Textile FX API v2 Ramp bank directory.
   */
  app.get('/api/v1/cashout/banks', async (_request, reply: FastifyReply) => {
    try {
      const banks = await listTextileBanks('busha');
      return reply.send({
        status: 'ok',
        source: 'textile_credit_ramp_v2',
        data: banks.map(b => ({
          code: b.code,
          name: b.name,
          id: b.code,
        })),
      });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message || 'Failed to fetch banks from Textile' });
    }
  });

  /**
   * POST /api/v1/cashout/resolve-account
   * Official Textile FX API v2 Ramp account resolution.
   * POST /v2/ramp/banks/resolve
   */
  app.post('/api/v1/cashout/resolve-account', async (request: FastifyRequest<{ Body: { accountNumber: string; bankCode: string } }>, reply: FastifyReply) => {
    try {
      const { accountNumber, bankCode } = request.body || {};
      if (!accountNumber || accountNumber.length < 6 || accountNumber.length > 12) {
        return reply.code(400).send({ error: 'Valid account number is required (6-12 digits)' });
      }
      if (!bankCode) {
        return reply.code(400).send({ error: 'Bank code is required' });
      }

      const res = await resolveTextileBankAccount(accountNumber, bankCode, 'busha');
      return reply.send({
        status: 'ok',
        valid: res.valid,
        source: 'textile_credit_ramp_v2',
        accountName: res.accountName,
        accountNumber: res.accountNumber,
        bankCode: res.bankCode,
      });
    } catch (err: any) {
      return reply.code(400).send({
        status: 'error',
        valid: false,
        error: err.message || 'Could not verify account details with Textile',
      });
    }
  });

  /**
   * POST /api/v1/swap/rfq
   * Solicits a firm RFQ swap quote from Textile Credit Market Maker on Celo.
   * Returns exact unsigned approval and swap execution transactions.
   */
  app.post('/api/v1/swap/rfq', async (request: FastifyRequest<{ Body: { fromToken: string; toToken: string; amount: number; takerAddress: string; chainId?: number } }>, reply: FastifyReply) => {
    try {
      const { fromToken, toToken, amount, takerAddress, chainId = 42220 } = request.body || {};

      if (!fromToken || !toToken || !amount || amount <= 0 || !takerAddress || !takerAddress.startsWith('0x')) {
        return reply.code(400).send({ error: 'Valid fromToken, toToken, positive amount, and takerAddress are required.' });
      }

      const CELO_TOKENS: Record<string, { address: string; decimals: number }> = {
        USDT: { address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', decimals: 6 },
        USDC: { address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', decimals: 6 },
        CUSD: { address: '0x765DE816845861e75A25fCA122bb6898B8B1282a', decimals: 18 },
        CNGN: { address: '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f', decimals: 6 },
        WARS: { address: '0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D', decimals: 18 },
        WBRL: { address: '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0', decimals: 18 },
        IDRX: { address: '0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22', decimals: 2 },
      };

      const sellDef = CELO_TOKENS[fromToken.toUpperCase()];
      const buyDef = CELO_TOKENS[toToken.toUpperCase()];

      if (!sellDef || !buyDef) {
        return reply.code(400).send({ error: `Unsupported swap pair: ${fromToken} to ${toToken}` });
      }

      const rawSellAmount = BigInt(Math.round(amount * (10 ** sellDef.decimals))).toString();
      const apiKey = (process.env.TEXTILE_CREDIT_API_KEY || '').trim();
      if (!apiKey) {
        request.log.error({ event: 'textile_api_key_missing' }, 'TEXTILE_CREDIT_API_KEY is not configured');
        return reply.code(503).send({ error: 'Textile FX is not configured on this environment.' });
      }

      const textileRes = await fetch('https://api.textilecredit.com/v2/rfq/request', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          chainId,
          sellToken: sellDef.address,
          buyToken: buyDef.address,
          sellAmount: rawSellAmount,
          taker: takerAddress,
        }),
        signal: AbortSignal.timeout(10000),
      });

      const data: any = await textileRes.json();

      if (!textileRes.ok || !data?.data?.transactions?.swap) {
        return reply.code(textileRes.status || 502).send({
          error: data?.error?.message || 'Textile market makers were unable to provide a firm quote for this amount.',
          details: data?.error,
        });
      }

      const q = data.data.quote;
      const rawBuyAmount = Number(q.buyAmount) / (10 ** buyDef.decimals);

      return reply.send({
        status: 'ok',
        rfqId: data.data.rfqId,
        quote: {
          fromToken,
          toToken,
          inputAmount: amount,
          outputAmount: rawBuyAmount,
          rate: rawBuyAmount / amount,
          reactor: q.reactor || '0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3',
          expiresAt: q.expiresAt,
        },
        transactions: data.data.transactions,
      });
    } catch (err: any) {
      request.log.error({ err }, 'Swap RFQ request failed');
      return reply.code(500).send({ error: err.message || 'Swap RFQ failed' });
    }
  });

  /**
   * POST /api/v1/swap/rfq/:id/submit
   * Submits broadcasted swap txHash to Textile RFQ engine for settlement indexing.
   */
  app.post('/api/v1/swap/rfq/:id/submit', async (request: FastifyRequest<{ Params: { id: string }; Body: { txHash: string } }>, reply: FastifyReply) => {
    try {
      const { id } = request.params;
      const { txHash } = request.body || {};

      if (!id || !txHash) {
        return reply.code(400).send({ error: 'Missing required parameters: id and txHash are required.' });
      }

      const apiKey = (process.env.TEXTILE_CREDIT_API_KEY || '').trim();
      if (!apiKey) {
        request.log.error({ event: 'textile_api_key_missing' }, 'TEXTILE_CREDIT_API_KEY is not configured');
        return reply.code(503).send({ error: 'Textile FX is not configured on this environment.' });
      }

      const textileRes = await fetch(`https://api.textilecredit.com/v2/rfq/${encodeURIComponent(id)}/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ txHash }),
        signal: AbortSignal.timeout(10000),
      });

      const data: any = await textileRes.json().catch(() => ({}));

      if (!textileRes.ok) {
        request.log.warn({ rfqId: id, txHash, status: textileRes.status, data }, 'Textile RFQ submit rejected by provider');
        return reply.code(textileRes.status >= 400 ? textileRes.status : 502).send({
          status: 'error',
          rfqId: id,
          txHash,
          settled: false,
          settlementStatus: 'pending',
          textileResponse: data,
        });
      }

      return reply.send({
        status: 'ok',
        rfqId: id,
        txHash,
        settled: Boolean(data?.settled ?? data?.status === 'settled'),
        settlementStatus: data?.status || 'submitted',
        textileResponse: data,
      });
    } catch (err: any) {
      request.log.error({ err, rfqId: request.params.id }, 'Textile RFQ submit failed');
      return reply.code(502).send({
        status: 'error',
        rfqId: request.params.id,
        txHash: request.body?.txHash,
        settled: false,
        settlementStatus: 'pending',
        error: err?.message || 'Textile RFQ submit failed; settlement status remains pending until confirmed.',
      });
    }
  });

  /**
   * GET /api/v1/agreement/limits
   * Exposes canonical Sivan system Service Agreement limits and fee configuration.
   */
  app.get('/api/v1/agreement/limits', async (_request, reply: FastifyReply) => {
    return reply.send({
      status: 'ok',
      source: 'sivan_system_agreement_limits',
      minNairaAmount: 5000,
      maxNairaAmount: 5000000,
      minUsdcAmount: 5,
      maxUsdcAmount: 5000,
      usdcFeePercent: 3.0,
      usdcFeeFixed: 0.50,
      nairaFeePercent: 2.5,
      nairaFeeFixed: 50,
      nairaFeeTiers: [
        { max: 10000, fee: 500 },
        { max: 20000, fee: 900 },
        { max: 25000, fee: 1000 },
        { max: 50000, rate: 3.75 },
        { max: null, rate: 3.5 },
      ],
    });
  });

  /**
   * GET /api/v1/agreement/fee
   * Calculates official Sivan system Service Agreement fee directly from core rules.
   */
  app.get('/api/v1/agreement/fee', async (request: FastifyRequest<{ Querystring: { currency?: string; amount?: string | number } }>, reply: FastifyReply) => {
    const currency = (request.query.currency || 'USDC').toUpperCase();
    const amount = parseFloat(String(request.query.amount || '10'));

    if (isNaN(amount) || amount <= 0) {
      return reply.code(400).send({ error: 'Invalid agreement amount. Must be greater than 0.' });
    }

    const isNaira = currency === 'CNGN' || currency === 'NGN' || currency === 'NAIRA';
    let fee = 0;
    let formula = '';

    if (isNaira) {
      if (amount <= 10000) {
        fee = 500;
        formula = 'Tier 1: Flat ₦500';
      } else if (amount <= 20000) {
        fee = 900;
        formula = 'Tier 2: Flat ₦900';
      } else if (amount <= 25000) {
        fee = 1000;
        formula = 'Tier 3: Flat ₦1,000';
      } else if (amount <= 50000) {
        fee = Math.round(amount * 0.0375);
        formula = 'Tier 4: 3.75%';
      } else {
        fee = Math.round(amount * 0.035);
        formula = 'Tier 5: 3.50%';
      }
    } else {
      const percentRate = 0.03; // 3.0%
      const fixedFee = 0.50; // $0.50
      fee = parseFloat((amount * percentRate + fixedFee).toFixed(2));
      formula = '3.0% + $0.50 fixed';
    }

    const netAmount = Math.max(0, parseFloat((amount - fee).toFixed(2)));

    return reply.send({
      status: 'ok',
      source: 'sivan_system_agreement_engine',
      currency,
      amount,
      protocolFee: fee,
      netAmount,
      feeFormula: formula,
    });
  });

  /**
   * GET /api/v1/cashout/swap-quote
   * Official Textile RFQ v2 Swap engine proxy with Sivan fee separation.
   * Protects TEXTILE_CREDIT_API_KEY from frontend exposure.
   * Spec: POST /v2/rfq/preview with EVM token addresses + atomic-unit sellAmount.
   * rateRay response is RAY-scaled (1e27): rate = rateRay / 1e27.
   */
  app.get('/api/v1/cashout/swap-quote', async (request: FastifyRequest<{ Querystring: { fromToken?: string; toToken?: string; amount?: string | number; userAddress?: string } }>, reply: FastifyReply) => {
    try {
      const fromToken = (request.query.fromToken || 'USDT').toUpperCase();
      const toToken = (request.query.toToken || 'CNGN').toUpperCase();
      const amount = parseFloat(String(request.query.amount || '10'));
      const userTaker = request.query.userAddress || (request.headers['x-user-address'] as string) || '0x0000000000000000000000000000000000000000';

      if (isNaN(amount) || amount <= 0) {
        return reply.code(400).send({ error: 'Invalid swap amount.' });
      }

      if (fromToken === toToken) {
        return reply.send({
          status: 'ok',
          fromToken,
          toToken,
          inputAmount: amount,
          outputAmount: amount,
          rate: 1.0,
          inverseRate: 1.0,
          protocolFee: 0,
          minimumReceived: amount,
          source: '1:1 Direct',
          depositAddress: TEXTILE_CELO_LIMIT_ORDER_REACTOR,
        });
      }

      // -----------------------------------------------------------------------
      // Textile RFQ v2 token address map
      // Test keys (tx_test_*): BSC Testnet (chainId 97) - only cNGN/USDT corridor
      // Production keys:       Celo Mainnet (chainId 42220) - full token set
      // -----------------------------------------------------------------------
      const textileKey = process.env.TEXTILE_CREDIT_API_KEY;
      const configuredTextile = process.env.TEXTILE_CREDIT_API_URL || 'https://api.textilecredit.com/v2';
      const rawTextileBase = configuredTextile.replace(/\/ramp\/?$/, '').replace(/\/v2\/?$/, '').replace(/\/+$/, '');
      const textileBaseUrl = `${rawTextileBase}/v2`;

      const isTestKey = textileKey?.startsWith('tx_test_') ?? false;

      // Celo Mainnet (42220) token addresses
      const CELO_TOKENS: Record<string, { address: string; decimals: number }> = {
        USDC: { address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', decimals: 6 },
        USDT: { address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', decimals: 6 },
        CUSD: { address: '0x765DE816845861e75A25fCA122bb6898B8B1282a', decimals: 18 },
        CNGN: { address: '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f', decimals: 6 },
      };

      // BSC Testnet (97) — Textile sandbox cNGN/USDT corridor only
      const BSC_TESTNET_TOKENS: Record<string, { address: string; decimals: number }> = {
        CNGN: { address: '0x8a078b182bA9649c03982c2a80CDcc81cdc99dA8', decimals: 6 },
        USDT: { address: '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd', decimals: 6 },
        USDC: { address: '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd', decimals: 6 }, // USDT proxy on testnet
        CUSD: { address: '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd', decimals: 6 }, // USDT proxy on testnet
      };

      const tokenMap = isTestKey ? BSC_TESTNET_TOKENS : CELO_TOKENS;
      const chainId  = isTestKey ? 97 : 42220;

      // Normalise: cNGN → CNGN, cUSD → CUSD
      const normalise = (t: string) => t.replace(/^c/i, 'C').toUpperCase();
      const fromKey = normalise(fromToken);
      const toKey   = normalise(toToken);

      const sellInfo = tokenMap[fromKey];
      const buyInfo  = tokenMap[toKey];

      const isUsdStable = (tok: string) => tok === 'USDT' || tok === 'USDC' || tok === 'CUSD';

      // 1:1 USD-to-USD Direct Parity (USDT <-> USDC <-> cUSD)
      if (isUsdStable(fromKey) && isUsdStable(toKey)) {
        return reply.send({
          status: 'ok',
          fromToken,
          toToken,
          inputAmount: amount,
          outputAmount: amount,
          rate: 1.0,
          inverseRate: 1.0,
          protocolFee: 0,
          textileFee: 0,
          minimumReceived: amount,
          source: '1:1 Direct Parity',
          chainId,
          depositAddress: TEXTILE_CELO_LIMIT_ORDER_REACTOR,
        });
      }

      // Determine corridor token addresses for Textile RFQ
      // On Celo Mainnet, Textile's active market maker liquidity pool is strictly USDT <-> cNGN.
      // We route USDC and cUSD via USDT (1:1 USD parity) so users get authentic live DEX market rates.
      let rfqSellAddress = sellInfo?.address;
      let rfqSellDecimals = sellInfo?.decimals ?? 6;
      let rfqBuyAddress = buyInfo?.address;
      let rfqBuyDecimals = buyInfo?.decimals ?? 6;

      if (!isTestKey) {
        if (isUsdStable(fromKey) && toKey === 'CNGN') {
          rfqSellAddress = CELO_TOKENS.USDT.address;
          rfqSellDecimals = CELO_TOKENS.USDT.decimals; // 6
          rfqBuyAddress = CELO_TOKENS.CNGN.address;
          rfqBuyDecimals = CELO_TOKENS.CNGN.decimals; // 6
        } else if (fromKey === 'CNGN' && isUsdStable(toKey)) {
          rfqSellAddress = CELO_TOKENS.CNGN.address;
          rfqSellDecimals = CELO_TOKENS.CNGN.decimals; // 6
          rfqBuyAddress = CELO_TOKENS.USDT.address;
          rfqBuyDecimals = CELO_TOKENS.USDT.decimals; // 6
        }
      }

      let rawOutput: number | null = null;
      let source = 'Textile Credit RFQ (calibrated)';
      let textileFeeAmount = 0;

      if (textileKey && rfqSellAddress && rfqBuyAddress) {
        try {
          const sellAmountAtomic = String(Math.round(amount * Math.pow(10, rfqSellDecimals)));

          const rfqRes = await fetch(`${textileBaseUrl}/rfq/preview`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${textileKey}`,
              'Accept': 'application/json',
            },
            body: JSON.stringify({
              chainId,
              sellToken:  rfqSellAddress,
              buyToken:   rfqBuyAddress,
              sellAmount: sellAmountAtomic,
              taker:      userTaker,
            }),
            signal: AbortSignal.timeout(6000),
          }).catch(() => null);

          if (rfqRes && rfqRes.ok) {
            const data: any = await rfqRes.json();
            const preview = data?.data || data;

            if (preview?.status === 'preview' && preview.buyAmount) {
              const buyAmountHuman = Number(preview.buyAmount) / Math.pow(10, rfqBuyDecimals);
              if (buyAmountHuman > 0) {
                rawOutput = buyAmountHuman;
                source = 'Textile Credit RFQ (Live Preview)';
                if (preview.feeAmount) {
                  textileFeeAmount = Number(preview.feeAmount) / Math.pow(10, rfqBuyDecimals);
                }
              }
            }
          }
        } catch (rfqErr: any) {
          request.log.warn({ err: rfqErr }, 'Textile RFQ v2 preview failed; using calibrated rate');
        }
      }

      // If Textile RFQ preview is not available, obtain live rate directly from Textile FX tickers
      if (rawOutput === null) {
        const fxQuote = await getTextileFxQuote('usdc_to_cngn', amount);
        if (fromKey === 'CNGN' && isUsdStable(toKey)) {
          rawOutput = amount / fxQuote.rate;
        } else {
          rawOutput = amount * fxQuote.rate;
        }
        source = 'Textile Credit RFQ (Live)';
      }

      // Sivan On-Chain DEX Swap Protocol Fee (default: 0.0% from Admin Settings)
      const settings = await getAdminFeeSettings().catch(() => null);
      const swapFeePercent = Number(settings?.swapFeePercent ?? 0.0);
      const sivanFee = rawOutput * (swapFeePercent / 100);
      const outputAmount = Math.max(0, rawOutput - sivanFee - textileFeeAmount);
      const effectiveRate = amount > 0 ? outputAmount / amount : (rawOutput / (amount || 1));

      return reply.send({
        status: 'ok',
        fromToken,
        toToken,
        inputAmount: amount,
        outputAmount: parseFloat(outputAmount.toFixed(6)),
        rate: parseFloat(effectiveRate.toFixed(6)),
        inverseRate: effectiveRate > 0 ? parseFloat((1 / effectiveRate).toFixed(6)) : 0,
        protocolFee: parseFloat(sivanFee.toFixed(6)),
        textileFee: parseFloat(textileFeeAmount.toFixed(6)),
        minimumReceived: parseFloat((outputAmount * 0.995).toFixed(6)),
        source,
        chainId,
        depositAddress: TEXTILE_CELO_LIMIT_ORDER_REACTOR,
      });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message || 'Swap quote failed' });
    }
  });
}


