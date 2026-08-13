export type VirtualAccountProviderName = 'mock' | 'bridge' | 'nomba' | 'monnify' | 'flutterwave';

export type VirtualAccountCurrency = 'usd' | 'gbp' | 'eur' | 'ngn';

export type VirtualAccountStatus =
  | 'requested'
  | 'under_review'
  | 'approved'
  | 'provisioning'
  | 'active'
  | 'suspended'
  | 'rejected'
  | 'closed';

export interface VirtualAccountRequestRecord {
  id: string;
  userId: string;
  userEmail?: string;
  customerId?: string;
  currency: VirtualAccountCurrency;
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
  provider: VirtualAccountProviderName;
  providerAccountId: string;
  currency: VirtualAccountCurrency;
  country?: string;
  bankName?: string;
  accountName?: string;
  accountNumberMasked?: string;
  routingNumberMasked?: string;
  ibanMasked?: string;
  status: VirtualAccountStatus;
  rawProviderPayload?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface CreateVirtualAccountInput {
  requestId?: string;
  userId: string;
  customerId?: string;
  providerCustomerId?: string;
  email?: string;
  fullName?: string;
  currency: VirtualAccountCurrency;
  country?: string;
  useCase?: string;
  metadata?: unknown;
}

export interface ProviderVirtualAccount {
  provider: VirtualAccountProviderName;
  providerAccountId: string;
  currency: VirtualAccountCurrency;
  country?: string;
  bankName?: string;
  accountName?: string;
  accountNumberMasked?: string;
  routingNumberMasked?: string;
  ibanMasked?: string;
  status: VirtualAccountStatus;
  rawProviderPayload?: unknown;
}


export type VirtualAccountEventType =
  | 'funds_received'
  | 'funds_scheduled'
  | 'payment_submitted'
  | 'payment_processed'
  | 'in_review'
  | 'refund_in_flight'
  | 'refunded'
  | 'refund_failed'
  | 'account_update'
  | 'activation'
  | 'deactivation'
  | 'microdeposit'
  | 'unknown';

export type VirtualAccountTransactionStatus =
  | 'funds_received'
  | 'scheduled'
  | 'submitted'
  | 'completed'
  | 'in_review'
  | 'refund_in_flight'
  | 'refunded'
  | 'refund_failed'
  | 'failed';

export interface VirtualAccountEventRecord {
  id: string;
  provider: VirtualAccountProviderName;
  providerEventId: string;
  virtualAccountId?: string;
  providerAccountId?: string;
  depositId?: string;
  eventType: VirtualAccountEventType;
  sourceCurrency?: VirtualAccountCurrency;
  destinationCurrency?: string;
  sourceAmount?: string;
  destinationAmount?: string;
  paymentRail?: string;
  status: VirtualAccountTransactionStatus | 'account_update' | 'activation' | 'deactivation' | 'microdeposit';
  depositReference?: string;
  destinationTxHash?: string;
  rawPayload?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface VirtualAccountTransactionRecord {
  id: string;
  provider: VirtualAccountProviderName;
  virtualAccountId?: string;
  providerAccountId?: string;
  depositId: string;
  userId?: string;
  customerId?: string;
  sourceCurrency?: VirtualAccountCurrency;
  destinationCurrency?: string;
  sourceAmount?: string;
  destinationAmount?: string;
  paymentRail?: string;
  status: VirtualAccountTransactionStatus;
  depositReference?: string;
  destinationTxHash?: string;
  lastProviderEventId?: string;
  rawPayload?: unknown;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
