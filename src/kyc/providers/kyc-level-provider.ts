export type KycLevelMatchStatus = 'matched' | 'review' | 'failed';

export interface BvnInfoMatchInput {
  bvn: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  mobileNo: string;
}

export interface BvnAccountMatchInput {
  bvn: string;
  bankCode: string;
  accountNumber: string;
  accountName: string;
}

export interface KycLevelMatchResult {
  provider: string;
  status: KycLevelMatchStatus;
  message: string;
  bvnLast4: string;
  matchedFields?: Record<string, boolean | string>;
  providerReference?: string;
  raw?: unknown;
}

export interface KycLevelProviderHealth {
  provider: string;
  available: boolean;
  mode: 'mock' | 'live';
  message?: string;
  checkedAt: string;
}

export interface KycLevelProvider {
  name: string;
  verifyBvnIdentity(input: BvnInfoMatchInput): Promise<KycLevelMatchResult>;
  verifyBvnBankAccount(input: BvnAccountMatchInput): Promise<KycLevelMatchResult>;
  health(): Promise<KycLevelProviderHealth>;
}

export function bvnLast4(bvn: string) {
  return String(bvn || '').replace(/\D/g, '').slice(-4);
}
