import type { PayoutCurrency } from './rails';

export type ViewKey = 'landing' | 'overview' | 'withdraw' | 'buy' | 'receive' | 'transfer' | 'history' | 'banks' | 'virtualAccounts' | 'kyc' | 'settings' | 'help' | 'signup' | 'emailRecovery';

export interface UserRecord {
  id: string;
  email: string;
  whatsappNumber?: string;
  fullName: string;
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

export interface IdentityStatus {
  linked: boolean;
  link: null | {
    id: string;
    status: 'linked';
    paymentUserId: string;
    escrowUserId?: string;
    email: string;
    whatsappNumber: string;
    linkedAt?: string;
  };
  pendingPairing: null | {
    id: string;
    status: 'pending';
    expiresAt: string;
    createdAt: string;
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

export interface BalanceTransferRecord {
  transferId: string;
  userId: string;
  asset: 'usdc' | 'usdt';
  network: string;
  amount: string;
  destinationAddress: string;
  status: string;
  note?: string;
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
  currency: 'usd' | 'gbp' | 'eur';
  enabled: boolean;
  label: string;
  accountType: 'us' | 'gb' | 'iban';
  defaultPaymentRail: string;
  updatedBy?: string;
  updatedAt: string;
}

export interface AssetControl {
  asset: 'usdc' | 'usdt';
  enabled: boolean;
  label: string;
  updatedBy?: string;
  updatedAt: string;
}

export interface NetworkControl {
  network: 'ethereum' | 'polygon' | 'base' | 'solana' | 'arbitrum' | 'avalanche_c_chain';
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
  chain: 'solana' | 'base' | 'ethereum';
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
