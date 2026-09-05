import type { PayoutCurrency } from './rails';

export type ViewKey = 'landing' | 'overview' | 'withdraw' | 'buy' | 'receive' | 'transfer' | 'history' | 'banks' | 'virtualAccounts' | 'kyc' | 'settings' | 'help' | 'signup' | 'emailRecovery' | 'agreements';

export interface UserRecord {
  id: string;
  email: string;
  whatsappNumber?: string;
  fullName: string;
  /** Declared date of birth, yyyy-MM-dd. Forwarded to Bridge as birth_date. */
  dateOfBirth?: string;
  /**
   * ISO 3166-1 alpha-2, uppercase. Set from the verification modal, not at
   * signup. Undefined for every user who existed before it was collected, and
   * an undefined country routes to Bridge - never to the Nigerian path, which
   * their account number could not pass.
   */
  country?: string;
  username?: string;
  usernameUpdatedAt?: string;
  primaryChannel?: 'email' | 'whatsapp' | 'both';
  avatarUrl?: string;
  avatarObjectKey?: string;
  avatarUpdatedAt?: string;
  emailVerifiedAt?: string;
  whatsappVerifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IdentityLink {
  id: string;
  status: 'linked';
  channel: 'whatsapp' | 'telegram';
  paymentUserId: string;
  escrowUserId?: string;
  email: string;
  /**
   * OPTIONAL, because a Telegram link record has no phone number. Both
   * channels share this one shape, and typing it as required made every
   * Telegram link a type error.
   */
  whatsappNumber?: string;
  telegramUserId?: string;
  /** Display only. Telegram usernames can be changed and re-registered. */
  telegramUsername?: string;
  linkedAt?: string;
}

export interface IdentityPendingPairing {
  id: string;
  status: 'pending';
  channel: 'whatsapp' | 'telegram';
  expiresAt: string;
  createdAt: string;
  /**
   * NO `token` FIELD, DELIBERATELY. publicToken() in identity.service.ts omits
   * the code, which exists only in the response to .../start. So after a page
   * reload a pending code cannot be shown again, and the card must say "a code
   * is pending" rather than render a blank box.
   */
}

export interface IdentityChannelStatus {
  linked: boolean;
  link: IdentityLink | null;
  pendingPairing: IdentityPendingPairing | null;
}

export interface ServiceAgreementDeal {
  escrowId: string;
  id?: string;
  title: string;
  description?: string;
  amount: string;
  amountUsdc?: number;
  currency: string;
  network?: string;
  role: 'buyer' | 'seller' | 'actor';
  status: string;
  statusLabel?: string;
  buyerWhatsapp?: string;
  sellerWhatsapp?: string;
  buyerUserId?: string;
  sellerUserId?: string;
  counterparty?: string;
  countdownLabel?: string;
  deliveryDueAt?: string | null;
  fundedAt?: string | null;
  deliveredAt?: string | null;
  releasedAt?: string | null;
  fundingTxHash?: string | null;
  releaseTxHash?: string | null;
  vaultAddress?: string | null;
  createdAt: string;
  updatedAt?: string;
  terms?: string;
  notes?: string;
  channel?: 'web' | 'telegram' | 'webmcp';
}

export interface ServiceAgreementsSummary {
  linked: boolean;
  deals: ServiceAgreementDeal[];
}

export interface IdentityStatus {
  /** True when ANY channel is linked. */
  linked: boolean;
  /**
   * The WhatsApp link, kept as a top-level alias of channels.whatsapp.link.
   * The dashboard setup panel and ProfileSettingsPanel still read these, so
   * this widening is purely additive - `channels` was already arriving on the
   * wire and was simply being dropped by the old type.
   */
  link: IdentityLink | null;
  pendingPairing: IdentityPendingPairing | null;
  channels: {
    whatsapp: IdentityChannelStatus;
    telegram: IdentityChannelStatus;
  };
}


export interface CustomerRecord {
  id: string;
  userId: string;
  provider: string;
  providerCustomerId: string;
  customerType?: 'individual' | 'business';
  kycLinkId?: string;
  kycLink?: string;
  hostedKycLink?: string;
  tosLink?: string;
  kycStatus: string;
  tosStatus?: 'pending' | 'approved';
  onboardingCostUsd?: string;
  onboardingCostType?: 'kyc' | 'kyb';
  onboardingCostRecordedAt?: string;
  customerAction?: {
    level: 'success' | 'review' | 'failed' | 'action_required' | 'processing' | 'neutral';
    title: string;
    message: string;
    requirements?: string[];
    canContinue?: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ExternalAccountRecord {
  id: string;
  userId: string;
  customerId: string;
  provider: string;
  providerExternalAccountId: string;
  currency: 'usd' | 'gbp' | 'eur';
  accountType: 'us' | 'gb' | 'iban' | 'unknown';
  bankName?: string;
  accountName?: string;
  accountOwnerName: string;
  accountLast4?: string;
  paymentRail: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}



export interface SupplierRecord {
  id: string;
  userId: string;
  customerId: string;
  supplierName: string;
  supplierType: 'individual' | 'business';
  supplierCountry: string;
  currency: 'usd' | 'gbp' | 'eur' | 'mxn' | 'brl';
  bankName: string;
  accountOwnerName: string;
  accountType: string;
  accountLast4?: string;
  provider: string;
  providerExternalAccountId?: string;
  providerRail?: string;
  bridgeExternalAccountId?: string;
  status: string;
  riskLevel: string;
  riskScore: number;
  reviewReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierPaymentRecord {
  id: string;
  userId: string;
  supplierId: string;
  amount: string;
  sourceAsset: 'usdc';
  destinationCurrency: 'usd' | 'gbp' | 'eur' | 'mxn' | 'brl';
  paymentPurpose: string;
  invoiceUrl?: string;
  status: string;
  provider?: string;
  providerTransferId?: string;
  providerRail?: string;
  executionMode?: string;
  bridgeTransferId?: string;
  riskLevel: string;
  riskScore: number;
  reviewReason?: string;
  aceRiskReview?: any;
  createdAt: string;
  updatedAt: string;
  supplier?: SupplierRecord | null;
}

/**
 * ONE BALANCE, chain + ledger, from GET /balance/unified.
 *
 * Reported: the Receive screen showed a real deposit while the dashboard and
 * transfer screens showed zero. They were reading different things - Receive
 * asked the Privy wallet, everything else summed a ledger that is only ever
 * credited by virtual-account settlements and admin adjustments. An on-chain
 * deposit credited nothing, so real money was invisible to every spending path.
 */
export interface UnifiedAssetBalance {
  asset: string;
  /** Live on-chain total. */
  chain: string;
  /** Ledger credits with no chain counterpart we read (virtual accounts). */
  credited: string;
  /** Claims against it: transfers under review, payouts in flight. */
  held: string;
  /** chain + credited - held. What the user may actually send. */
  spendable: string;
  pending: string;
  spent: string;
  /** True when the chain read FAILED. Not the same as zero. */
  chainUnavailable: boolean;
}

export interface UnifiedBalance {
  userId: string;
  balances: UnifiedAssetBalance[];
  wallets: Array<{ chain: string; address: string; balances?: Array<{ asset: string; chain: string; amount: string }>; balancesUnavailable: boolean }>;
  updatedAt: string;
}

export interface BalanceSummary {
  userId: string;
  balances: Array<{ asset: string; pending: string; available: string; held: string; spent: string; totalCredited: string }>;
  ledger: BalanceLedgerEntry[];
  updatedAt: string;
}

export interface BalanceLedgerEntry {
  entryId: string;
  userId: string;
  customerId?: string;
  asset: 'usdc' | 'usdt';
  amount: string;
  kind: string;
  status: string;
  sourceType: string;
  sourceId: string;
  description?: string;
  network?: string;
  destinationAddress?: string;
  transferId?: string;
  createdAt: string;
}

/**
 * MONEY ARRIVING FROM OUTSIDE SIVAN.
 *
 * An exchange withdrawal into the user's Sivan address. The seventh activity
 * source, and the most common inbound path - see the backend record in
 * src/database/types.ts and migration 042 for why it did not exist before.
 *
 * `txHash` and `sender` are OPTIONAL because the current detector polls
 * balances and sees a delta rather than a transaction. Code must not assume a
 * deposit has a receipt; blockExplorer.ts already renders no link when the hash
 * is absent.
 */
export interface WalletDepositRecord {
  id: string;
  userId: string;
  walletId: string;
  address: string;
  chain: string;
  asset: string;
  amount: string;
  txHash?: string;
  sender?: string;
  blockNumber?: number;
  blockTimestamp?: string;
  status: 'pending' | 'confirmed' | 'failed';
  detectionSource: string;
  notifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BalanceTransferRecord {
  transferId: string;
  userId: string;
  asset: 'usdc' | 'usdt';
  network: string;
  amount: string;
  destinationAddress: string;
  status: string;
  note?: string;
  /**
   * The on-chain identifier. The server has always sent these; the frontend
   * type simply did not declare them, so the UI could not show a user the one
   * reference they can actually verify and fell back to printing the
   * recipient address instead.
   *
   * A SPONSORED EVM transfer is an ERC-4337 user operation and has only
   * userOperationHash until a bundler includes it; a Solana send has txHash
   * (the signature) immediately. Both optional, because a transfer awaiting
   * review has neither.
   */
  txHash?: string;
  userOperationHash?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionTimelineStep {
  key: string;
  label: string;
  description: string;
  status: 'completed' | 'current' | 'pending' | 'failed';
  at?: string;
}

export interface TransactionTimeline {
  transactionType: 'withdrawal' | 'onramp_order' | 'virtual_account_transaction';
  requestId: string;
  internalTransactionId: string;
  providerReference?: string;
  amount?: string;
  currency?: string;
  asset?: string;
  direction: 'sell' | 'buy' | 'deposit';
  provider?: string;
  status: string;
  explanation: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  steps: TransactionTimelineStep[];
}

export interface WithdrawalRecord {
  id: string;
  userId: string;
  customerId: string;
  externalAccountId: string;
  liquidationAddressId: string;
  provider: string;
  providerDrainId?: string;
  sourceCurrency: 'usdc' | 'usdt';
  destinationCurrency: 'usd' | 'gbp' | 'eur';
  sourceAmount?: string;
  destinationAmount?: string;
  feePercent?: string;
  feeAmount?: string;
  depositTxHash?: string;
  destinationReference?: string;
  destinationTxHash?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  transactionTimeline?: TransactionTimeline;
}

export interface FeePolicy {
  id: string;
  name: string;
  type: 'percentage';
  percent: string;
  enabled: boolean;
}

export interface OnboardingMetrics {
  users: {
    totalSignedUp: number;
    withBridgeCustomer: number;
    withoutBridgeCustomer: number;
  };
  signupExposure: {
    bridgeKycCostUsd: string;
    potentialKycCostIfEverySignupVerifiesUsd: string;
    potentialUnstartedKycExposureUsd: string;
  };
  onboardingCosts: {
    trackedCustomers: number;
    kycCount: number;
    kybCount: number;
    kycCostTotalUsd: string;
    kybCostTotalUsd: string;
    totalOnboardingCostUsd: string;
  };
  recovery: {
    sivanOfframpFeePercent: string;
    bridgeOfframpCostPercent: string;
    completedWithdrawalCount: number;
    completedGrossVolumeUsdEstimate: string;
    sivanDeveloperFeeRevenueUsd: string;
    estimatedBridgeOfframpCostUsd: string;
    contributionBeforeOnboardingUsd: string;
    onboardingCostRecoveredUsd: string;
    unrecoveredOnboardingCostUsd: string;
    netAfterOnboardingUsd: string;
  };
  kycStatuses: Record<string, number>;
}

export interface EconomicsEstimate {
  revenue: { sivanFeePercent: string; estimatedSivanFeeRevenue: string };
  costs: {
    bridgeOfframpCostPercent: string;
    estimatedBridgeOfframpCost: string;
    onboardingCost: string;
    thirdPartyRailFee: string;
    estimatedTotalCost: string;
  };
  margin: {
    estimatedContributionMargin: string;
    marginPercentOfVolume: string;
    onboardingBreakEvenVolume: string | null;
  };
}

export interface DepositResponse {
  withdrawal: WithdrawalRecord;
  deposit: {
    address: string;
    memolessAddress?: string;
    chain: string;
    currency: string;
  };
}


export interface CustomerTypeControl {
  customerType: 'individual' | 'business';
  enabled: boolean;
  label: string;
  updatedBy?: string;
  updatedAt: string;
}

export interface PaymentControl {
  /** 'ngn' is the Breet/NIP rail. It is NOT a Bridge currency - see PayoutCurrency server-side. */
  currency: 'usd' | 'gbp' | 'eur' | 'ngn';
  enabled: boolean;
  label: string;
  /** 'nuban' cannot be POSTed to the Bridge external-account endpoint. */
  accountType: 'us' | 'gb' | 'iban' | 'nuban';
  defaultPaymentRail: string;
  updatedBy?: string;
  updatedAt: string;
}

/** Mirrors DisplayFxRates in src/controls/display-fx.ts. Display only - never a quote. */
export interface DisplayFx {
  ngnPerUnit: Record<'usd' | 'gbp' | 'eur' | 'ngn', number>;
  configured: Record<'usd' | 'gbp' | 'eur' | 'ngn', boolean>;
  approximate: true;
  enforcementCurrency: 'ngn';
}

export interface AssetControl {
  asset: 'usdc' | 'usdt';
  enabled: boolean;
  label: string;
  updatedBy?: string;
  updatedAt: string;
}

export interface NetworkControl {
  network: 'ethereum' | 'polygon' | 'base' | 'solana' | 'arbitrum' | 'avalanche_c_chain' | 'stellar' | 'celo' | 'bsc' | 'bnb' | string;
  enabled: boolean;
  label: string;
  sortOrder: number;
  updatedBy?: string;
  updatedAt: string;
}

export interface VirtualAccountControl {
  // PayoutCurrency, not the Bridge trio: VirtualAccountRequestRecord already
  // permits 'ngn', and the two disagreeing is what let a naira account reach a
  // component that could not render it.
  currency: PayoutCurrency;
  enabled: boolean;
  label: string;
  provider?: string;
  accountType: 'us' | 'gb' | 'iban';
  paymentRails?: string[];
  updatedBy?: string;
  updatedAt: string;
}

export interface VirtualAccountRequestRecord {
  id: string;
  userId: string;
  customerId?: string;
  currency: 'usd' | 'gbp' | 'eur' | 'ngn';
  country?: string;
  useCase?: string;
  status: 'requested' | 'under_review' | 'approved' | 'rejected' | 'canceled';
  reviewedBy?: string;
  reviewedAt?: string;
  rejectionReason?: string;
  metadata?: unknown;
  customerAction?: {
    level: 'action_required' | 'review' | 'failed' | 'neutral';
    title: string;
    message: string;
    requirements?: string[];
    kycUrl?: string;
    providerCustomerId?: string;
    endorsement?: string;
    providerStatus?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface VirtualAccountRecord {
  id: string;
  requestId?: string;
  userId: string;
  customerId?: string;
  provider: string;
  providerAccountId: string;
  currency: 'usd' | 'gbp' | 'eur' | 'ngn';
  country?: string;
  bankName?: string;
  accountName?: string;
  accountNumberMasked?: string;
  routingNumberMasked?: string;
  ibanMasked?: string;
  status: string;
  rawProviderPayload?: unknown;
  createdAt: string;
  updatedAt: string;
}


export interface VirtualAccountTransactionRecord {
  id: string;
  provider: string;
  virtualAccountId?: string;
  providerAccountId?: string;
  depositId: string;
  userId?: string;
  customerId?: string;
  sourceCurrency?: 'usd' | 'gbp' | 'eur' | 'ngn';
  destinationCurrency?: string;
  sourceAmount?: string;
  destinationAmount?: string;
  paymentRail?: string;
  status: string;
  depositReference?: string;
  destinationTxHash?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface OfframpControls {
  customerTypes: CustomerTypeControl[];
  payoutCurrencies: PaymentControl[];
  virtualAccounts: VirtualAccountControl[];
  sourceAssets: AssetControl[];
  sourceNetworks: NetworkControl[];
  /**
   * Whether cross-border supplier payouts are open.
   *
   * Server-owned, and read here so a launch can ship LEAN: an admin turns the
   * flow off in the hub and the route disappears from the customer app,
   * rather than staying on screen and failing with a 403 after the user has
   * typed a supplier's bank details.
   */
  supplierPayoutsEnabled: boolean;
  /** Whether wallet-to-wallet USDC transfers are open. Server-owned; the send form reads it. */
  transfersEnabled?: boolean;
  /** The naira rail's own Sivan margin. Bridge's rate does not apply to a bank payout. */
  ngnOfframpFeePercent?: string;
  /**
   * Optional because an older backend will not send it. Every consumer must
   * survive its absence by falling back to naira - the unit the figures are
   * already in - rather than rendering a converted number with no rate.
   */
  displayFx?: DisplayFx;
}


export interface SystemIncident {
  id: string;
  provider: string;
  affectedService: 'withdrawals' | 'onramp' | 'virtual_accounts' | 'webhooks' | 'all' | 'other';
  severity: 'info' | 'warning' | 'critical';
  status: 'active' | 'monitoring' | 'resolved';
  message: string;
  customerMessage?: string;
  startedAt: string;
  eta?: string;
  resolvedAt?: string;
  durationMinutes?: number;
}

export interface SystemStatus {
  id: 'global';
  mode: 'active' | 'maintenance' | 'paused';
  message?: string;
  estimatedResumeAt?: string;
  activeIncidents?: SystemIncident[];
  updatedBy?: string;
  updatedAt: string;
}


export interface OnrampOrderRecord {
  id: string;
  userId: string;
  customerId: string;
  provider: string;
  providerTransferId?: string;
  sourceCurrency: 'usd' | 'gbp' | 'eur';
  sourcePaymentRail: string;
  destinationCurrency: 'usdc' | 'usdt';
  destinationChain: 'ethereum' | 'polygon' | 'base' | 'solana' | 'arbitrum' | 'avalanche_c_chain';
  destinationAddress: string;
  amount: string;
  feePercent?: string;
  feeAmount?: string;
  netAmount?: string;
  providerReference?: string;
  sourceDepositInstructions?: any;
  destinationTxHash?: string;
  status: string;
  statusReason?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  transactionTimeline?: TransactionTimeline;
}

export interface SupportTicketRecord {
  id: string;
  userId: string;
  customerId?: string;
  type: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: 'open' | 'in_review' | 'waiting_on_user' | 'waiting_on_provider' | 'resolved' | 'closed';
  subject: string;
  description: string;
  resourceType: string;
  resourceId?: string;
  assignedTo?: string;
  lastMessageAt?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  messages?: Array<{ id: string; senderType: string; senderId?: string; message: string; internalNote?: boolean; createdAt: string }>;
  sla?: any;
}

export interface UserPreferencesRecord {
  userId: string;
  defaultFiatCurrency: 'usd' | 'gbp' | 'eur' | 'ngn';
  language: 'en-US' | 'en-GB' | 'fr-FR' | 'de-DE' | 'es-ES' | 'it-IT' | 'nl-NL' | 'pt-PT';
  transactionUpdates: boolean;
  marketingEmails: boolean;
  securityAlerts: boolean;
  emailConfirmationsForHighValue: boolean;
  telegramNotificationsEnabled?: boolean;
  whatsappNotificationsEnabled?: boolean;
  multiChainAlertsEnabled?: boolean;
  /**
   * Which network the SERVER signs against. Read-only, and not a preference -
   * it is returned by GET/PUT preferences and must never be sent back.
   *
   * Absent means mainnet, so a stale client or an older backend shows no
   * testnet warning rather than falsely claiming a user's real funds are on a
   * test chain. Fixed per deployment, so it never changes within a session.
   */
  networkMode?: 'mainnet' | 'testnet';
  updatedAt: string;
}



/**
 * A wallet belonging to this user, one per chain.
 *
 * Bridge issues a wallet per customer and the user's virtual account settles
 * into it, so this address is genuinely theirs rather than a shared Sivan
 * treasury address.
 */
export interface UserWalletRecord {
  id: string;
  userId: string;
  chain: 'solana' | 'base' | 'ethereum' | 'stellar' | 'celo' | 'polygon' | 'arbitrum' | 'bsc' | 'bnb' | string;
  address: string;
  status: 'provisioning' | 'active' | 'suspended' | 'closed' | 'failed';
  /**
   * Which vendor issued the address. 'mock' means it is a simulated address
   * that belongs to nobody: the UI must say so loudly rather than presenting
   * it as somewhere real money can be sent.
   */
  provider?: 'mock' | 'bridge' | 'privy';
  custodial: boolean;
  /** Assets the chain can actually carry. Base cannot hold USDT. */
  acceptedAssets?: Array<'usdc' | 'usdt'>;
  /**
   * Undefined means the balance could not be loaded. An empty array means it
   * loaded and is genuinely zero. The UI must not show the first as "0.00".
   */
  balances?: Array<{ asset: 'usdc' | 'usdt'; chain: string; amount: string }>;
  /** True when the provider was unreachable, so no balance figure is trustworthy. */
  balancesUnavailable?: boolean;
  createdAt: string;
  updatedAt: string;
}


/**
 * The single source of truth for "how verified is this user, and for how much".
 *
 * Served by GET /api/users/:id/verification-summary. The UI must not derive
 * any of this itself: it used to compute
 *
 *     isVerified = customer?.kycStatus === 'kyc_approved'
 *     hasBank    = externalAccounts.length > 0
 *
 * which are Bridge-only facts. A Nigerian who passed the bank check has
 * neither, so the UI called them unverified while the backend had already
 * granted Level 1.
 */
export interface FlowAllowance {
  flow: 'escrow' | 'offramp' | 'onramp';
  rail: 'ngn' | 'foreign';
  /** null means genuinely uncapped. NEVER hardcode this in the UI. */
  limitNgn: number | null;
  usedNgn: number;
  remainingNgn: number | null;
  nextLevel?: number;
  /**
   * A reason this rail is unusable that is NOT the ceiling.
   *
   * A Bridge-approved Nigerian reaches Level 2, so the naira ceiling is a
   * genuine 5,000,000 - but with no name-matched NUBAN there is nowhere for
   * naira to land and the withdrawal will refuse. Showing only the ceiling
   * would advertise five million to someone who cannot move one.
   */
  blockedBy?: 'payout_account_required';
}

export interface VerificationSummary {
  level: number;
  levelLabel: string;
  path: 'ngn_bank' | 'bridge_kyc';
  country?: string;
  checks: {
    identity: string;
    bank: string;
    nin: string;
    bvn: string;
    proofOfAddress: string;
    sourceOfFunds: string;
  };
  identitySource?: 'sivan' | 'bridge';
  upliftApplies: boolean;
  /**
   * The provider terms step, decided by the SERVER.
   *
   * `required` is presence-of-a-Bridge-customer, NOT country. The page used to
   * key the Terms row off `!isNgnPath`, which hid it from a Nigerian who had
   * started a Bridge verification - so they owed an acceptance, were blocked
   * at withdrawal for it, and had no row anywhere offering the link.
   */
  terms: {
    required: boolean;
    accepted: boolean;
    link?: string;
  };
  /**
   * The IDENTITY check alone, terms excluded.
   *
   * Separate from pathComplete because the step list needs "is your ID
   * confirmed" while the gate needs "are you finished". Collapsing the two
   * made a verified identity render as an incomplete step the moment terms
   * were outstanding.
   */
  identityComplete: boolean;
  pathComplete: boolean;
  hasPayoutAccount: boolean;
  hasPendingPayoutReview: boolean;
  windowDays: number;
  allowances: FlowAllowance[];
  /**
   * The rung above this one, decided by the SERVER.
   *
   * Rendered verbatim. The ladder differs by country - a Nigerian goes
   * bank -> NIN/BVN, everyone else goes straight to documents - and keeping a
   * second copy of that in the frontend is how the two drift apart.
   *
   * Undefined at the top, where there is nothing to offer.
   */
  nextStep?: {
    level: number;
    label: string;
    description: string;
    action: 'nin_bvn' | 'bridge_kyc' | 'contact_support';
    /** False when the level exists but no provider is wired up yet. */
    available: boolean;
  };
}

/**
 * A naira on/off-ramp, from GET /api/users/:id/ngn-transfers.
 *
 * THIS TYPE DID NOT EXIST, AND NEITHER DID THE FETCH.
 *
 * Transactions was built from /withdrawals (Bridge) and /onramp-orders
 * (Bridge). A Nigerian selling USDC for naira creates neither - the record
 * lives in payments_ngn_transfers. So a user could accept a sell, receive a
 * real Breet deposit address, and then be told "No transactions yet."
 *
 * Caught in a browser against the deployed app: three awaiting_crypto_deposit
 * transfers on the API, an empty transaction list on screen.
 */
export interface NgnTransferRecord {
  id: string;
  quoteId?: string;
  userId: string;
  direction: 'onramp' | 'offramp';
  provider: string;
  sourceCurrency: string;
  destinationCurrency: string;
  sourceAmount: string;
  destinationAmount: string;
  rate?: string;
  feeAmount?: string;
  status: string;
  providerQuoteId?: string;
  providerTransferId?: string;
  /** Where the user must send crypto for an off-ramp to settle. */
  depositAddress?: string;
  /**
   * WHICH CHAIN THAT ADDRESS IS ON.
   *
   * Server-derived from the quote. Sending USDC on the wrong chain to a rail
   * deposit address loses it permanently, and an address alone does not tell a
   * user which network it belongs to - a base58 string is Solana, but nobody
   * should be asked to know that.
   */
  network?: string;
  /** When an unfunded order closes itself. Absent once funded or finished. */
  expiresAt?: string;
  /** Whether the user may cancel right now. Decided by the server. */
  cancellable?: boolean;
  virtualAccount?: unknown;
  metadata?: Record<string, unknown>;
  timeline?: unknown;
  createdAt: string;
  updatedAt?: string;
}

/**
 * GET /api/users/:id/supplier-payments/quote
 *
 * The server's price for a cross-border supplier payout. Fetched rather than
 * computed: the curve is marginal-tiered AND discounted by the user's 30-day
 * volume, so a client-side copy would need both tables plus the volume, and
 * would disagree with the charge the moment an admin edits the fee tab.
 */
export interface SupplierFeeQuoteResponse {
  /** What the supplier receives - the amount the user typed. */
  netAmount: string;
  /** Sivan's fee, ADDED on top. Sent to Bridge as developer_fee. */
  fee: string;
  /** What leaves the balance: netAmount + fee. */
  grossAmount: string;
  feeBeforeDiscount: string;
  volumeDiscountAmount: string;
  volumeDiscountPercent: number;
  volumeUsd: string;
  /** One-time supplier-onboarding charge, "0.00" when not a first payment. */
  newSupplierFee: string;
  isFirstPaymentToSupplier: boolean;
  effectivePercent: string;
  appliedRule: 'tiered' | 'minimum' | 'maximum';
  breakdown: Array<{ fromUsd: number; toUsd: number | null; percent: number; amountInBand: string; feeFromBand: string }>;
  explanation: string;
  windowDays: number;
}

export type ServiceAgreementStatus =
  | 'pending_payment'
  | 'funded'
  | 'in_delivery'
  | 'delivered'
  | 'released'
  | 'cancelled'
  | 'disputed';

export interface ServiceAgreement {
  id: string;
  buyerUserId: string;
  sellerUserId: string;
  title: string;
  description: string;
  amountUsdc: number;
  currency: string;
  network: string;
  status: ServiceAgreementStatus;
  /** Delivery window extracted from natural language at creation time. */
  deadlineDays: number;
  /** ISO timestamp of delivery deadline. Null until agreement is funded. */
  deliveryDueAt: string | null;
  /** Live countdown label for display in chat and dashboard cards. */
  countdownLabel: string;
  reminder6hSent: boolean;
  overdueNoticeSent: boolean;
  fundedAt: string | null;
  deliveredAt: string | null;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
