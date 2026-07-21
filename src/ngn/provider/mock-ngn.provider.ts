import crypto from 'node:crypto';
import type { NgnProviderAdapter } from './ngn-provider.js';
import type { NgnProviderHealth, NgnProviderName, NgnQuoteInput, NgnQuoteRecord } from '../types/ngn.types.js';

function money(value: number) { return value.toFixed(value >= 100 ? 2 : 6); }

export class MockNgnProvider implements NgnProviderAdapter {
  name: NgnProviderName = 'mock';
  async createQuote(input: NgnQuoteInput) {
    const rate = 1500;
    const source = Number(input.sourceAmount);
    const fee = input.direction === 'onramp' ? source * 0.01 : source * 0.005;
    const destinationAmount = input.direction === 'onramp'
      ? (Math.max(source - fee, 0) / rate)
      : (source * rate) - (source * rate * 0.01);
    return {
      provider: this.name,
      providerQuoteId: `mock_quote_${crypto.randomUUID()}`,
      sourceAmount: money(source),
      destinationAmount: money(destinationAmount),
      rate: money(rate),
      feeAmount: money(fee),
      metadata: { mock: true, quoteModel: input.direction === 'onramp' ? 'NGN to stablecoin' : 'stablecoin to NGN' }
    } satisfies Partial<NgnQuoteRecord> as any;
  }
  async createOnrampTransfer(quote: NgnQuoteRecord) {
    return {
      providerTransferId: `mock_ngn_on_${crypto.randomUUID()}`,
      status: 'awaiting_deposit' as const,
      bankReference: `SVN-NGN-${quote.id.slice(-6).toUpperCase()}`,
      virtualAccount: { bankName: 'Sivan Mock Bank', accountName: 'Sivan NGN Collection', accountNumberMasked: '****0420', rail: 'bank_transfer' },
      metadata: { mock: true, instruction: 'Transfer exact NGN amount with reference.' }
    };
  }
  async createOfframpTransfer(quote: NgnQuoteRecord) {
    return {
      providerTransferId: `mock_ngn_off_${crypto.randomUUID()}`,
      status: 'awaiting_crypto_deposit' as const,
      depositAddress: `mock_avalanche_${crypto.randomUUID().replace(/-/g, '').slice(0, 32)}`,
      metadata: { mock: true, instruction: 'Send supported stablecoin to generated deposit address.' }
    };
  }
  async getTransfer(providerTransferId: string) { return { providerTransferId, status: 'processing' as const }; }
  async verifyWebhook(payload: any, _headers?: unknown) { return { id: `ngnwh_${crypto.randomUUID()}`, provider: this.name, providerEventId: payload?.id || crypto.randomUUID(), eventType: payload?.eventType || 'mock.event', transferId: payload?.transferId, payload, createdAt: new Date().toISOString() }; }
  async health(): Promise<NgnProviderHealth> { return { provider: this.name, available: true, mode: 'mock' as const, message: 'Mock NGN provider ready.', checkedAt: new Date().toISOString() }; }
}
