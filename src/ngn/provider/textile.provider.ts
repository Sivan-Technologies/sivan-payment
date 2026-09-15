import type { NgnProviderAdapter } from './ngn-provider.js';
import type { NgnProviderHealth, NgnProviderName, NgnQuoteInput, NgnQuoteRecord, NgnTransferRecord, NgnWebhookRecord } from '../types/ngn.types.js';

/** Legacy adapter never booked provider transfers. Fail closed, not paid. */
function unavailable(): never {
  throw Object.assign(new Error('This Textile route is unavailable until verified provider execution is configured.'), { statusCode: 503 });
}

export class TextileNgnProvider implements NgnProviderAdapter {
  name: NgnProviderName = 'textile';
  async createQuote(_input: NgnQuoteInput): Promise<Pick<NgnQuoteRecord, 'provider' | 'providerQuoteId' | 'sourceAmount' | 'destinationAmount' | 'rate' | 'feeAmount' | 'metadata'>> { return unavailable(); }
  async createOnrampTransfer(_quote: NgnQuoteRecord): Promise<Partial<NgnTransferRecord>> { return unavailable(); }
  async createOfframpTransfer(_quote: NgnQuoteRecord): Promise<Partial<NgnTransferRecord>> { return unavailable(); }
  async getTransfer(_id: string): Promise<Partial<NgnTransferRecord>> { return unavailable(); }
  async verifyWebhook(_payload: unknown, _headers: unknown): Promise<NgnWebhookRecord> { return unavailable(); }
  async health(): Promise<NgnProviderHealth> {
    return { provider: this.name, available: false, mode: 'live', message: 'Legacy Textile execution is disabled; no verified settlement integration.', checkedAt: new Date().toISOString() };
  }
}
