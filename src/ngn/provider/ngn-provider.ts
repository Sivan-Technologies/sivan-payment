import type { NgnProviderHealth, NgnQuoteInput, NgnQuoteRecord, NgnTransferRecord, NgnWebhookRecord } from '../types/ngn.types.js';

export interface NgnProviderAdapter {
  name: NgnQuoteRecord['provider'];
  createQuote(input: NgnQuoteInput): Promise<Pick<NgnQuoteRecord, 'provider' | 'providerQuoteId' | 'sourceAmount' | 'destinationAmount' | 'rate' | 'feeAmount' | 'metadata'>>;
  createOnrampTransfer(quote: NgnQuoteRecord): Promise<Partial<NgnTransferRecord>>;
  createOfframpTransfer(quote: NgnQuoteRecord): Promise<Partial<NgnTransferRecord>>;
  getTransfer(providerTransferId: string): Promise<Partial<NgnTransferRecord>>;
  verifyWebhook(payload: unknown, headers: unknown): Promise<NgnWebhookRecord>;
  health(): Promise<NgnProviderHealth>;
  /**
   * Ask the provider what it believes about settlements, without waiting to be
   * told.
   *
   * OPTIONAL, because not every provider can answer. Where it exists, it is
   * the safety net under the webhook: a delivery that 403s, times out, or is
   * simply never sent must not leave a user's money in limbo, and until this
   * existed it did exactly that - six failed deliveries left a completed,
   * paid-out settlement reading "waiting for crypto deposit" forever.
   */
  listSettlements?(): Promise<NgnProviderSettlement[]>;
}

/** One provider-side settlement, keyed on the deposit address it arrived at. */
export interface NgnProviderSettlement {
  depositAddress?: string;
  tradeId?: string;
  withdrawalId?: string;
  /** Breet's state for the crypto->NGN conversion. */
  tradeStatus?: string;
  /** Breet's state for the NGN payout to the bank. */
  withdrawalStatus?: string;
  cryptoAmount?: number;
  fiatAmount?: number;
  txHash?: string;
  raw?: unknown;
}
