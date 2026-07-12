export type AdminViewKey = 'overview' | 'analytics' | 'users' | 'withdrawals' | 'reconciliation' | 'providers' | 'controls' | 'webhooks' | 'audit' | 'economics' | 'settings';

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
  kycStatus: string;
  tosStatus?: 'pending' | 'approved';
  onboardingCostUsd?: string;
  onboardingCostType?: 'kyc' | 'kyb';
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
  accountType: string;
  bankName?: string;
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
  sourceCurrency: 'usdc';
  destinationCurrency: 'usd' | 'gbp' | 'eur';
  destinationAmount?: string;
  feePercent?: string;
  feeAmount?: string;
  depositTxHash?: string;
  destinationTxHash?: string;
  status: string;
  statusReason?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AdminUser extends UserRecord {
  customer: CustomerRecord | null;
  externalAccountCount: number;
  withdrawalCount: number;
}

export interface AdminWithdrawal extends WithdrawalRecord {
  user: UserRecord | null;
  externalAccount: ExternalAccountRecord | null;
  liquidationAddress: null | {
    id: string;
    providerLiquidationAddressId: string;
    address: string;
    chain: string;
    sourceCurrency: string;
    destinationCurrency: string;
    destinationPaymentRail: string;
    status: string;
  };
}

export interface WebhookEventRecord {
  id: string;
  provider: string;
  providerEventId: string;
  eventCategory?: string;
  eventType?: string;
  eventObjectId?: string;
  processedAt?: string;
  createdAt: string;
  payload: unknown;
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

export interface AdminOverview {
  counts: {
    users: number;
    customers: number;
    externalAccounts: number;
    liquidationAddresses: number;
    withdrawals: number;
    webhookEvents: number;
    providers: number;
  };
  withdrawalsByStatus: Record<string, number>;
  webhookEventsByType: Record<string, number>;
  metrics: OnboardingMetrics;
  recent: {
    users: UserRecord[];
    customers: CustomerRecord[];
    withdrawals: WithdrawalRecord[];
    webhookEvents: WebhookEventRecord[];
  };
}

export interface ProviderCapability {
  name: string;
  available: boolean;
  sourceCurrencies: string[];
  sourceChains: string[];
  destinationCurrencies: string[];
  destinationCountries: string[] | 'global';
  destinationPaymentRails: string[];
  complianceModels: string[];
  speed: string;
  reliability: string;
  priority: number;
  notes?: string;
}

export interface RoutingDecision {
  providerName: string;
  reason: string;
  matchedCapability: ProviderCapability;
  evaluatedProviders: Array<{ providerName: string; available: boolean; matched: boolean; reasons: string[] }>;
}

export interface ReconciliationFinding {
  type: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  withdrawalId?: string;
  liquidationAddressId?: string;
  providerDrainId?: string;
  previousStatus?: string;
  nextStatus?: string;
}

export interface ReconciliationResult {
  dryRun: boolean;
  startedAt: string;
  completedAt: string;
  summary: {
    checkedLiquidationAddresses: number;
    checkedDrains: number;
    matchedDrains: number;
    unmatchedDrains: number;
    updatedWithdrawals: number;
    providerErrors: number;
    findingCount: number;
  };
  findings: ReconciliationFinding[];
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


export interface AdminAnalyticsActivity {
  id: string;
  userId: string;
  type: string;
  label: string;
  occurredAt: string;
  user: UserRecord | null;
  metadata?: Record<string, unknown>;
}

export interface AdminAnalyticsWindow {
  days: number;
  activeUsers: number;
  returningUsers: number;
  newUsers: number;
  churningUsers: number;
  dormantUsers: number;
  activeUserIds: string[];
  returningUserIds: string[];
  newUserIds: string[];
  churningUserIds: string[];
  dormantUserIds: string[];
}

export interface AdminAnalyticsUser extends UserRecord {
  firstActivityAt: string;
  lastActivityAt: string;
  activityCount: number;
  withdrawalCount: number;
  completedWithdrawalCount: number;
  kycStatus: string;
}

export interface AdminProfitabilityMetrics {
  averageLifetimeVolumePerUserUsd: string;
  averageLifetimeVolumePerTransactingUserUsd: string;
  kycCostRecoveryPerKycUserUsd: string;
  withdrawalVolumePerUserUsd: string;
  withdrawalVolumePerTransactingUserUsd: string;
  repeatWithdrawalRatePercent: string;
  averageWithdrawalSizeUsd: string;
  failedWithdrawalRatePercent: string;
  providerCostUsd: string;
  bridgeVariableCostUsd: string;
  onboardingCostUsd: string;
  sivanFeeRevenueUsd: string;
  netMarginBeforeCacUsd: string;
  customerAcquisitionCostPerUserUsd: string;
  customerAcquisitionCostTotalUsd: string;
  netMarginAfterCacUsd: string;
  transactingUsers: number;
  repeatUsers: number;
  completedWithdrawalCount: number;
  failedWithdrawalCount: number;
}

export interface AdminAnalytics {
  generatedAt: string;
  definitions: Record<string, string>;
  totals: {
    users: number;
    activities: number;
    activityCounts: Record<string, number>;
  };
  profitability: AdminProfitabilityMetrics;
  windows: AdminAnalyticsWindow[];
  users: AdminAnalyticsUser[];
  recentActivities: AdminAnalyticsActivity[];
}


export interface AdminAuditLog {
  id: string;
  actorType: string;
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

export interface AdminReconciliationRun {
  id: string;
  provider?: string;
  dryRun: boolean;
  status: 'completed' | 'failed';
  summary?: any;
  error?: string;
  startedAt: string;
  completedAt?: string;
  findings: ReconciliationFinding[];
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
