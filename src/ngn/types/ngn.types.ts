export type NgnProviderName = 'mock' | 'linkio' | 'eversend' | 'nomba' | 'paj' | 'breet';
export type NgnDirection = 'onramp' | 'offramp';
export type NgnQuoteStatus = 'quote_created' | 'quote_accepted' | 'expired' | 'failed';
export type NgnTransferStatus =
  | 'created'
  | 'quote_created'
  | 'quote_accepted'
  | 'awaiting_deposit'
  | 'awaiting_crypto_deposit'
  | 'deposit_received'
  | 'blockchain_confirmed'
  | 'processing'
  | 'settlement_processing'
  | 'bank_processing'
  | 'crypto_sent'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'requires_review';

export interface NgnControlsRecord {
  id: 'global';
  onrampEnabled: boolean;
  offrampEnabled: boolean;
  mockProviderEnabled: boolean;
  bankSettlementEnabled: boolean;
  virtualAccountEnabled: boolean;
  activeProvider: NgnProviderName;
  backupProvider?: NgnProviderName;
  /**
   * Master switch for NIN/BVN identity verification.
   *
   * OFF for MVP. No NIN/BVN provider is integrated yet, so requiring it would
   * block every user at Level 1 and there would be no way to clear them. With
   * it off, Level 2 is reachable on the bank check alone.
   *
   * This is a deliberate, visible, auditable compromise rather than a silent
   * one - an admin can see it is off, and turning it on is one toggle once a
   * provider exists.
   */
  identityVerificationEnabled: boolean;
  maxTransactionNgn: string;
  dailyLimitNgn: string;
  highValueReviewThresholdNgn: string;
  updatedBy?: string;
  updatedAt: string;
}

export interface NgnQuoteRecord {
  id: string;
  userId: string;
  customerId?: string;
  direction: NgnDirection;
  provider: NgnProviderName;
  sourceCurrency: 'ngn' | 'usdc' | 'usdt';
  destinationCurrency: 'ngn' | 'usdc' | 'usdt';
  sourceAmount: string;
  destinationAmount: string;
  rate: string;
  feeAmount: string;
  status: NgnQuoteStatus;
  providerQuoteId?: string;
  expiresAt: string;
  metadata?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface NgnTransferRecord {
  id: string;
  quoteId: string;
  userId: string;
  customerId?: string;
  direction: NgnDirection;
  provider: NgnProviderName;
  sourceCurrency: 'ngn' | 'usdc' | 'usdt';
  destinationCurrency: 'ngn' | 'usdc' | 'usdt';
  sourceAmount: string;
  destinationAmount: string;
  rate: string;
  feeAmount: string;
  status: NgnTransferStatus;
  providerQuoteId?: string;
  providerTransferId?: string;
  bankReference?: string;
  depositAddress?: string;
  virtualAccount?: unknown;
  settlementReference?: string;
  destinationTxHash?: string;
  metadata?: unknown;
  timeline?: NgnTimelineStep[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface NgnWebhookRecord {
  id: string;
  provider: NgnProviderName;
  providerEventId: string;
  eventType: string;
  transferId?: string;
  payload: unknown;
  processedAt?: string;
  createdAt: string;
}

export interface NgnProviderHealth {
  provider: NgnProviderName;
  available: boolean;
  mode: 'mock' | 'sandbox' | 'live_disabled' | 'live';
  message?: string;
  checkedAt: string;
}

export interface NgnQuoteInput {
  userId: string;
  customerId?: string;
  direction: NgnDirection;
  sourceCurrency: 'ngn' | 'usdc' | 'usdt';
  destinationCurrency: 'ngn' | 'usdc' | 'usdt';
  sourceAmount: string;
}

export interface NgnTimelineStep { key: string; label: string; status: 'completed' | 'current' | 'pending' | 'failed'; at?: string; description: string }
