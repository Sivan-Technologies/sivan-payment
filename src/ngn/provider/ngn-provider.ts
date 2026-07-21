import type { NgnProviderHealth, NgnQuoteInput, NgnQuoteRecord, NgnTransferRecord, NgnWebhookRecord } from '../types/ngn.types.js';

export interface NgnProviderAdapter {
  name: NgnQuoteRecord['provider'];
  createQuote(input: NgnQuoteInput): Promise<Pick<NgnQuoteRecord, 'provider' | 'providerQuoteId' | 'sourceAmount' | 'destinationAmount' | 'rate' | 'feeAmount' | 'metadata'>>;
  createOnrampTransfer(quote: NgnQuoteRecord): Promise<Partial<NgnTransferRecord>>;
  createOfframpTransfer(quote: NgnQuoteRecord): Promise<Partial<NgnTransferRecord>>;
  getTransfer(providerTransferId: string): Promise<Partial<NgnTransferRecord>>;
  verifyWebhook(payload: unknown, headers: unknown): Promise<NgnWebhookRecord>;
  health(): Promise<NgnProviderHealth>;
}
