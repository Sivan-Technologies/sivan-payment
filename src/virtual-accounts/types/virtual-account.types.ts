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
