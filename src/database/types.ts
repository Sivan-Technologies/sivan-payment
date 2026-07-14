export type Currency = 'usd' | 'gbp' | 'eur';
export type SourceCurrency = 'usdc';
export type Chain = 'ethereum' | 'polygon' | 'base' | 'solana' | 'arbitrum' | 'optimism' | 'avalanche';
export type CustomerStatus = 'created' | 'kyc_not_started' | 'kyc_incomplete' | 'kyc_under_review' | 'kyc_approved' | 'kyc_rejected' | 'paused' | 'offboarded';
export type ExternalAccountStatus = 'created' | 'active' | 'verification_pending' | 'verified' | 'verification_failed' | 'deactivated';
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

export interface DatabaseShape {
  users: UserRecord[];
  customers: CustomerRecord[];
  externalAccounts: ExternalAccountRecord[];
  liquidationAddresses: LiquidationAddressRecord[];
  withdrawals: WithdrawalRecord[];
  webhookEvents: WebhookEventRecord[];
}
