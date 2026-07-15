export type Currency = 'usd' | 'gbp' | 'eur';
export type SourceCurrency = 'usdc' | 'usdt';
export type Chain = 'ethereum' | 'polygon' | 'base' | 'solana' | 'arbitrum' | 'optimism' | 'avalanche_c_chain';
export type CustomerStatus = 'created' | 'kyc_not_started' | 'kyc_incomplete' | 'kyc_under_review' | 'kyc_approved' | 'kyc_rejected' | 'paused' | 'offboarded';
export type ExternalAccountStatus = 'created' | 'active' | 'verification_pending' | 'verified' | 'verification_failed' | 'deactivated';
export type OnrampStatus = 'created' | 'awaiting_payment' | 'payment_received' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'requires_action';

export type WithdrawalStatus =
  | 'created'
  | 'pending_deposit'
  | 'deposit_received'
  | 'converting'
  | 'payout_processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'requires_action';





export interface CustomerTypeControlRecord {
  customerType: 'individual' | 'business';
  enabled: boolean;
  label: string;
  updatedBy?: string;
  updatedAt: string;
}

export interface SystemStatusRecord {
  id: 'global';
  mode: 'active' | 'maintenance' | 'paused';
  message?: string;
  estimatedResumeAt?: string;
  updatedBy?: string;
  updatedAt: string;
}

export interface AssetControlRecord {
  asset: SourceCurrency;
  enabled: boolean;
  label: string;
  updatedBy?: string;
  updatedAt: string;
}

export interface NetworkControlRecord {
  network: Chain;
  enabled: boolean;
  label: string;
  sortOrder: number;
  updatedBy?: string;
  updatedAt: string;
}

export interface PaymentControlRecord {
  currency: Currency;
  enabled: boolean;
  label: string;
  accountType: 'us' | 'gb' | 'iban';
  defaultPaymentRail: string;
  updatedBy?: string;
  updatedAt: string;
}


export interface LegalAcceptanceRecord {
  id: string;
  userId: string;
  email: string;
  termsVersion: string;
  privacyVersion: string;
  riskDisclosureVersion: string;
  acceptedAt: string;
  ipAddress?: string;
  userAgent?: string;
  source: 'signup' | 'manual' | 'migration';
  createdAt: string;
}

export interface UserPreferencesRecord {
  userId: string;
  defaultFiatCurrency: Currency | 'ngn';
  language: string;
  transactionUpdates: boolean;
  marketingEmails: boolean;
  securityAlerts: boolean;
  emailConfirmationsForHighValue: boolean;
  updatedAt: string;
}

export interface UserRecord {
  id: string;
  email: string;
  whatsappNumber?: string;
  fullName: string;
  primaryChannel?: 'email' | 'whatsapp' | 'both';
  emailVerifiedAt?: string;
  whatsappVerifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerRecord {
  id: string;
  userId: string;
  provider: string;
  providerCustomerId: string;
  customerType?: 'individual' | 'business';
  kycLinkId?: string;
  kycLink?: string;
  tosLink?: string;
  kycStatus: CustomerStatus;
  tosStatus?: 'pending' | 'approved';
  onboardingCostUsd?: string;
  onboardingCostType?: 'kyc' | 'kyb';
  onboardingCostRecordedAt?: string;
  raw?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalAccountRecord {
  id: string;
  userId: string;
  customerId: string;
  provider: string;
  providerExternalAccountId: string;
  currency: Currency;
  accountType: 'us' | 'gb' | 'iban' | 'unknown';
  bankName?: string;
  accountName?: string;
  accountOwnerName: string;
  accountLast4?: string;
  paymentRail: string;
  status: ExternalAccountStatus;
  raw?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface LiquidationAddressRecord {
  id: string;
  userId: string;
  customerId: string;
  externalAccountId: string;
  provider: string;
  providerLiquidationAddressId: string;
  address: string;
  memolessAddress?: string;
  chain: Chain;
  sourceCurrency: SourceCurrency;
  destinationCurrency: Currency;
  destinationPaymentRail: string;
  returnAddress?: string;
  returnInstructions?: unknown;
  customDeveloperFeePercent?: string;
  status: 'active' | 'inactive' | 'created';
  raw?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface WithdrawalRecord {
  id: string;
  userId: string;
  customerId: string;
  externalAccountId: string;
  liquidationAddressId: string;
  provider: string;
  providerDrainId?: string;
  sourceCurrency: SourceCurrency;
  destinationCurrency: Currency;
  sourceAmount?: string;
  destinationAmount?: string;
  feePercent?: string;
  feeAmount?: string;
  depositTxHash?: string;
  destinationReference?: string;
  destinationTxHash?: string;
  status: WithdrawalStatus;
  statusReason?: string;
  raw?: unknown;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}


export interface OnrampOrderRecord {
  id: string;
  userId: string;
  customerId: string;
  provider: string;
  providerTransferId?: string;
  sourceCurrency: Currency;
  sourcePaymentRail: string;
  destinationCurrency: SourceCurrency;
  destinationChain: Chain;
  destinationAddress: string;
  amount: string;
  feePercent?: string;
  feeAmount?: string;
  netAmount?: string;
  providerReference?: string;
  sourceDepositInstructions?: unknown;
  destinationTxHash?: string;
  status: OnrampStatus;
  statusReason?: string;
  receipt?: unknown;
  raw?: unknown;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}


export type SupportTicketStatus = 'open' | 'in_review' | 'waiting_on_user' | 'waiting_on_provider' | 'resolved' | 'closed';
export type SupportTicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type SupportTicketType = 'verification' | 'bank_account' | 'withdrawal' | 'deposit_not_detected' | 'wrong_token_or_network' | 'payout_delayed' | 'onramp_payment' | 'onramp_delivery' | 'account_access' | 'other';
export type SupportResourceType = 'withdrawal' | 'onramp_order' | 'external_account' | 'customer' | 'general';

export interface SupportTicketRecord {
  id: string;
  userId: string;
  customerId?: string;
  type: SupportTicketType;
  priority: SupportTicketPriority;
  status: SupportTicketStatus;
  subject: string;
  description: string;
  resourceType: SupportResourceType;
  resourceId?: string;
  assignedTo?: string;
  lastMessageAt?: string;
  metadata?: unknown;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface SupportTicketMessageRecord {
  id: string;
  ticketId: string;
  senderType: 'user' | 'admin' | 'system' | 'provider';
  senderId?: string;
  message: string;
  attachments?: unknown;
  internalNote?: boolean;
  createdAt: string;
}

export interface AuditLogRecord {
  id: string;
  actorType: 'system' | 'user' | 'admin' | 'provider';
  actorId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  severity: 'info' | 'warning' | 'error';
  ipAddress?: string;
  userAgent?: string;
  metadata?: unknown;
  createdAt: string;
}

export interface ReconciliationRunRecord {
  id: string;
  provider?: string;
  dryRun: boolean;
  status: 'completed' | 'failed';
  summary?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface ReconciliationFindingRecord {
  id: string;
  runId: string;
  provider?: string;
  severity: 'info' | 'warning' | 'error';
  findingType: string;
  withdrawalId?: string;
  liquidationAddressId?: string;
  providerDrainId?: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
  status: 'open' | 'resolved' | 'ignored';
  createdAt: string;
}

export interface AuthChallengeRecord {
  id: string;
  email: string;
  codeHash: string;
  intent: 'signup' | 'signin';
  fullName?: string;
  expiresAt: string;
  consumedAt?: string;
  createdAt: string;
  legalTermsVersion?: string;
  legalPrivacyVersion?: string;
  legalRiskDisclosureVersion?: string;
  legalAcceptedAt?: string;
  legalAcceptanceIpAddress?: string;
  legalAcceptanceUserAgent?: string;
}

export interface WebhookEventRecord {
  id: string;
  provider: string;
  providerEventId: string;
  eventCategory?: string;
  eventType?: string;
  eventObjectId?: string;
  payload: unknown;
  processedAt?: string;
  createdAt: string;
}

export interface UnifiedWebhookLogRecord {
  id: string;
  serviceName: string;
  provider: string;
  providerEventId?: string;
  paymentReference?: string;
  eventCategory?: string;
  eventType?: string;
  payload: unknown;
  createdAt: string;
}

export interface DatabaseShape {
  users: UserRecord[];
  userPreferences: UserPreferencesRecord[];
  legalAcceptances: LegalAcceptanceRecord[];
  customers: CustomerRecord[];
  externalAccounts: ExternalAccountRecord[];
  liquidationAddresses: LiquidationAddressRecord[];
  withdrawals: WithdrawalRecord[];
  onrampOrders: OnrampOrderRecord[];
  webhookEvents: WebhookEventRecord[];
  authChallenges: AuthChallengeRecord[];
  auditLogs: AuditLogRecord[];
  reconciliationRuns: ReconciliationRunRecord[];
  reconciliationFindings: ReconciliationFindingRecord[];
  paymentControls: PaymentControlRecord[];
  assetControls: AssetControlRecord[];
  networkControls: NetworkControlRecord[];
  systemStatus: SystemStatusRecord[];
  customerTypeControls: CustomerTypeControlRecord[];
  unifiedWebhookLogs: UnifiedWebhookLogRecord[];
  supportTickets: SupportTicketRecord[];
  supportTicketMessages: SupportTicketMessageRecord[];
}
