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
  /**
   * The USER changed their mind, as opposed to 'expired' where the clock ran
   * out. Kept distinct deliberately: "I cancelled this" and "Sivan closed this
   * because you did not fund it" are different facts, and collapsing them
   * would make the off-ramp funnel unreadable - you could no longer tell
   * abandonment from a UX problem.
   */
  | 'cancelled'
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
  /**
   * Whether the user may fund an off-ramp by SENDING CRYPTO THEMSELVES.
   *
   * OFF for launch, at the founders' request. The withdraw screen offered two
   * buttons - "From my Sivan balance" and "I'll send crypto myself" - and the
   * second is the path that produced "its got delivered to the breet sandbox
   * but i kept seeing waiting for your asset till now". It shows a bare
   * deposit address with no balance check in front of it, while the balance
   * path shows a concrete "60.00 USDC available to withdraw" the user can act
   * on. Narrowing launch to the guarded path removes the flow that has
   * actually confused people.
   *
   * WHAT THIS FLAG DOES, STATED PRECISELY, BECAUSE THE NAME OVERPROMISES.
   *
   * It hides the manual-funding INSTRUCTIONS. It does not disable a code path,
   * because there is no separate code path to disable: both buttons POST the
   * same /api/ngn/offramp/orders, the server creates a deposit address either
   * way, and ngn-transfers.service.ts always calls scheduleSweep() from the
   * user's balance. "I'll send crypto myself" is simply what happens when that
   * sweep cannot fund the order - the deposit address stays valid and still
   * settles, exactly as its own comment says:
   *
   *     "The deposit address is valid either way, so the manual route still
   *      works for anyone who would rather send the crypto themselves."
   *
   * So a user who already knows an address can still fund one. Genuinely
   * refusing externally-funded deposits would mean rejecting settled on-chain
   * money, which loses funds and is not something to ship days before launch.
   * This is a UI narrowing, deliberately, and it is reversible from the admin
   * hub without a deploy.
   */
  externalFundingEnabled: boolean;
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
  /**
   * The chain the crypto leg moves on.
   *
   * This field did not exist, so the user's chosen network was dropped before
   * the provider ever saw it: createQuote() priced with
   * BREET_DEFAULT_NETWORK and stamped THAT network's assetId into the quote.
   * A user selecting Base got a quote carrying Solana's asset, and accepting
   * it asked Breet to generate a Base address against a Solana id -
   * "you have entered an invalid _id".
   */
  network?: string;
}

export interface NgnTimelineStep { key: string; label: string; status: 'completed' | 'current' | 'pending' | 'failed'; at?: string; description: string }
