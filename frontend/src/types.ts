export type ViewKey = 'landing' | 'overview' | 'withdraw' | 'buy' | 'history' | 'banks' | 'kyc' | 'settings' | 'help' | 'signup';

export interface UserRecord {
  id: string;
  email: string;
  fullName: string;
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
  hostedKycLink?: string;
  tosLink?: string;
  kycStatus: string;
  tosStatus?: 'pending' | 'approved';
  onboardingCostUsd?: string;
  onboardingCostType?: 'kyc' | 'kyb';
  onboardingCostRecordedAt?: string;
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
  destinationTxHash?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
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

export interface OfframpControls {
  customerTypes: CustomerTypeControl[];
  payoutCurrencies: PaymentControl[];
  sourceAssets: AssetControl[];
  sourceNetworks: NetworkControl[];
}


export interface SystemStatus {
  id: 'global';
  mode: 'active' | 'maintenance' | 'paused';
  message?: string;
  estimatedResumeAt?: string;
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
