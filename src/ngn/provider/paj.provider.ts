import { env } from '../../config/env.js';
import { forbidden } from '../../shared/errors.js';
import type { NgnProviderAdapter } from './ngn-provider.js';
import type { NgnProviderHealth, NgnQuoteInput, NgnQuoteRecord, NgnTransferRecord, NgnWebhookRecord } from '../types/ngn.types.js';

type PajRate = { baseCurrency: string; targetCurrency: string; isActive?: boolean; rate: number; type?: string };
type PajAllRate = { onRampRate?: PajRate; offRampRate?: PajRate };

type PajOnrampOrder = { id: string; accountNumber: string; accountName: string; amount: number; fiatAmount: number; bank: string; rate: number; recipient: string; currency: string; mint: string; fee?: number };
type PajOfframpOrder = { id: string; address: string; mint: string; currency: string; amount: number; fiatAmount: number; rate: number; fee?: number };

type PajWebhookPayload = {
  id?: string;
  status?: string;
  transactionType?: string;
  address?: string;
  signature?: string;
  mint?: string;
  currency?: string;
  amount?: number;
  usdcAmount?: number;
  fiatAmount?: number;
  sender?: string;
  recipient?: string;
  rate?: number;
};

function money(value: number, decimals = value >= 100 ? 2 : 6) {
  if (!Number.isFinite(value)) return '0';
  return value.toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function baseUrl() {
  return (env.PAJ_RAMP_BASE_URL || (env.PAJ_RAMP_ENV === 'production' ? 'https://api.paj.cash' : 'https://api-staging.paj.cash')).replace(/\/$/, '');
}

function merchantToken() {
  if (env.PAJ_RAMP_SESSION_MODE === 'merchant') return env.PAJ_RAMP_MERCHANT_TOKEN || env.PAJ_RAMP_API_KEY;
  return env.PAJ_RAMP_MERCHANT_TOKEN;
}

function pajChain() {
  return env.PAJ_RAMP_DEFAULT_CHAIN || 'SOLANA';
}

function pajMint() {
  if (!env.PAJ_RAMP_USDC_MINT) throw forbidden('PAJ USDC mint is not configured.');
  return env.PAJ_RAMP_USDC_MINT;
}

function pajWebhookUrl() {
  if (!env.PAJ_RAMP_WEBHOOK_URL) throw forbidden('PAJ webhook URL is not configured.');
  return env.PAJ_RAMP_WEBHOOK_URL;
}

function pajFee() {
  const value = Number(env.PAJ_RAMP_BUSINESS_USDC_FEE || 0);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function pajRequest<T>(path: string, options: { method?: string; body?: unknown; token?: string; apiKey?: boolean } = {}): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.apiKey && env.PAJ_RAMP_API_KEY ? { 'x-api-key': env.PAJ_RAMP_API_KEY } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`PAJ returned ${response.status}: ${JSON.stringify(json).slice(0, 500)}`);
  return json as T;
}

function mapStatus(direction: 'onramp' | 'offramp', raw?: string): NgnTransferRecord['status'] {
  const status = String(raw || '').toUpperCase();
  if (status === 'COMPLETED') return 'completed';
  if (status === 'FAILED') return 'failed';
  if (status === 'CANCELLED') return 'expired';
  if (status === 'PAID') return direction === 'onramp' ? 'deposit_received' : 'settlement_processing';
  return direction === 'onramp' ? 'awaiting_deposit' : 'awaiting_crypto_deposit';
}

function providerMode(): NgnProviderHealth['mode'] {
  return env.PAJ_RAMP_ENV === 'production' ? 'live' : 'sandbox';
}

export class PajNgnProvider implements NgnProviderAdapter {
  name = 'paj' as const;


  async getBanks(token = merchantToken()) {
    if (!token) throw forbidden('PAJ merchant/session token is not configured.');
    return pajRequest<Array<{ id: string; code: string; name: string; logo?: string; country?: string }>>('/pub/bank', { token });
  }

  async resolveBankAccount(bankId: string, accountNumber: string, token = merchantToken()) {
    if (!token) throw forbidden('PAJ merchant/session token is not configured.');
    const params = new URLSearchParams({ bankId, accountNumber });
    return pajRequest<{ accountName: string; accountNumber: string; bank: { id: string; name: string; code?: string; country?: string } }>(`/pub/bank-account/confirm?${params.toString()}`, { token });
  }

  async createQuote(input: NgnQuoteInput) {
    const rates = await pajRequest<PajAllRate>('/pub/rate');
    const rate = input.direction === 'onramp' ? rates.onRampRate?.rate : rates.offRampRate?.rate;
    if (!rate || !Number.isFinite(Number(rate))) throw new Error('PAJ rate is unavailable.');
    const source = Number(input.sourceAmount);
    const fee = pajFee() || 0;
    const destination = input.direction === 'onramp' ? Math.max(source / Number(rate) - fee, 0) : Math.max(source * Number(rate), 0);
    return {
      provider: this.name,
      providerQuoteId: `paj_rate_${input.direction}_${Date.now()}`,
      sourceAmount: money(source),
      destinationAmount: money(destination),
      rate: money(Number(rate)),
      feeAmount: money(fee, 6),
      metadata: { paj: true, environment: env.PAJ_RAMP_ENV, chain: pajChain(), mint: env.PAJ_RAMP_USDC_MINT, sessionMode: env.PAJ_RAMP_SESSION_MODE }
    } satisfies Pick<NgnQuoteRecord, 'provider' | 'providerQuoteId' | 'sourceAmount' | 'destinationAmount' | 'rate' | 'feeAmount' | 'metadata'>;
  }

  async createOnrampTransfer(quote: NgnQuoteRecord) {
    const token = merchantToken();
    if (!token) throw forbidden('PAJ merchant/session token is not configured.');
    const metadata = (typeof quote.metadata === 'object' && quote.metadata ? quote.metadata as Record<string, unknown> : {});
    const recipient = String(metadata.recipient || env.PAJ_RAMP_DEFAULT_RECIPIENT_ADDRESS || '');
    if (!recipient) throw forbidden('PAJ on-ramp recipient wallet is not configured.');
    const order = await pajRequest<PajOnrampOrder>('/pub/onramp', {
      method: 'POST',
      token,
      body: {
        fiatAmount: Number(quote.sourceAmount),
        currency: env.PAJ_RAMP_DEFAULT_CURRENCY || 'NGN',
        recipient,
        mint: pajMint(),
        chain: pajChain(),
        webhookURL: pajWebhookUrl(),
        businessUSDCFee: pajFee()
      }
    });
    return {
      providerTransferId: order.id,
      status: 'awaiting_deposit' as const,
      bankReference: order.id,
      virtualAccount: { bankName: order.bank, accountName: order.accountName, accountNumberMasked: `****${String(order.accountNumber).slice(-4)}`, rail: 'bank_transfer' },
      metadata: { pajOrder: order, paymentInstructions: { bankName: order.bank, accountName: order.accountName, accountNumberMasked: `****${String(order.accountNumber).slice(-4)}`, fiatAmount: order.fiatAmount, currency: order.currency } }
    } satisfies Partial<NgnTransferRecord>;
  }

  async createOfframpTransfer(quote: NgnQuoteRecord) {
    const token = merchantToken();
    if (!token) throw forbidden('PAJ merchant/session token is not configured.');
    const metadata = (typeof quote.metadata === 'object' && quote.metadata ? quote.metadata as Record<string, unknown> : {});
    const bank = String(metadata.bankId || metadata.bank || env.PAJ_RAMP_DEFAULT_BANK_ID || '');
    const accountNumber = String(metadata.accountNumber || env.PAJ_RAMP_DEFAULT_ACCOUNT_NUMBER || '');
    if (!bank || !accountNumber) throw forbidden('PAJ off-ramp bank account is not configured for this order.');
    const order = await pajRequest<PajOfframpOrder>('/pub/offramp', {
      method: 'POST',
      token,
      body: {
        bank,
        accountNumber,
        currency: env.PAJ_RAMP_DEFAULT_CURRENCY || 'NGN',
        amount: Number(quote.sourceAmount),
        mint: pajMint(),
        chain: pajChain(),
        description: 'Sivan NGN payout',
        webhookURL: pajWebhookUrl(),
        businessUSDCFee: pajFee()
      }
    });
    return {
      providerTransferId: order.id,
      status: 'awaiting_crypto_deposit' as const,
      depositAddress: order.address,
      metadata: { pajOrder: order, depositInstructions: { address: order.address, amount: order.amount, mint: order.mint, chain: pajChain(), expectedFiatAmount: order.fiatAmount, currency: order.currency } }
    } satisfies Partial<NgnTransferRecord>;
  }

  async getTransfer(providerTransferId: string) {
    const token = merchantToken();
    if (!token) throw forbidden('PAJ merchant/session token is not configured.');
    const tx = await pajRequest<any>(`/pub/transactions/${providerTransferId}`, { token });
    const direction = tx.transactionType === 'ON_RAMP' ? 'onramp' : 'offramp';
    return { providerTransferId, status: mapStatus(direction, tx.status), destinationTxHash: tx.signature, metadata: { pajTransaction: tx } };
  }

  async verifyWebhook(payload: unknown, _headers?: unknown): Promise<NgnWebhookRecord> {
    const body = payload as PajWebhookPayload;
    const direction = body.transactionType === 'ON_RAMP' ? 'onramp' : 'offramp';
    return {
      id: `ngnwh_paj_${body.id || Date.now()}`,
      provider: this.name,
      providerEventId: String(body.id || Date.now()),
      eventType: `paj.${String(body.transactionType || 'UNKNOWN').toLowerCase()}.${String(body.status || 'UNKNOWN').toLowerCase()}`,
      transferId: body.id,
      payload: { ...body, mappedStatus: mapStatus(direction, body.status) },
      createdAt: new Date().toISOString()
    };
  }

  async health(): Promise<NgnProviderHealth> {
    try {
      const rates = await pajRequest<PajAllRate>('/pub/rate');
      return { provider: this.name, available: Boolean(rates.onRampRate || rates.offRampRate), mode: providerMode(), message: `PAJ ${env.PAJ_RAMP_ENV} reachable. On-ramp: ${rates.onRampRate?.rate ?? 'n/a'}, Off-ramp: ${rates.offRampRate?.rate ?? 'n/a'}`, checkedAt: new Date().toISOString() };
    } catch (error) {
      return { provider: this.name, available: false, mode: providerMode(), message: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() };
    }
  }
}
