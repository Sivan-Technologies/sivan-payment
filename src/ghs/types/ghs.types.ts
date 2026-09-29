import type { GhsPayoutAccountRecord, GhsQuoteRecord, GhsTransferRecord } from '../../database/types.js';

export interface GhsBank {
  id: string;
  name: string;
  slug?: string;
  type?: 'momo' | 'bank' | string;
}

export interface GhsBankAccountResolution {
  accountName: string;
  accountNumber: string;
  bankId: string;
  bankName?: string;
  trustworthy: boolean;
  type?: string;
}

export type { GhsPayoutAccountRecord, GhsQuoteRecord, GhsTransferRecord };
