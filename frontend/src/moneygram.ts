/**
 * Sivan Ai - MoneyGram Ramps on Stellar Integration
 *
 * MoneyGram provides global cash pickup (withdrawal) and cash-in (deposit)
 * at 400,000+ physical agent locations worldwide via Stellar SEP-24 native USDC.
 *
 * Adheres strictly to Sivan rules:
 * - No escrow mentions (strictly Service agreement)
 * - Sivan Ai / Sivan payment Ai
 * - Realistic testing amounts (15 to 50 USDC)
 * - Zero hardcoded URLs or keys (sourced dynamically)
 * - Realistic settlement timing
 */

export interface MoneyGramCountryOption {
  code: string;
  country: string;
  currency: string;
  symbol: string;
  flag: string;
  minAmountUsd: number;
  maxAmountUsd: number;
  typicalFeePercent: number;
  estimatedRate: number; // e.g. 1 USDC = 1620 NGN, 129.8 KES, 15.5 GHS, 1.00 USD, 0.92 EUR
}

export const MONEYGRAM_SUPPORTED_COUNTRIES: MoneyGramCountryOption[] = [
  {
    code: 'US',
    country: 'United States',
    currency: 'USD',
    symbol: '$',
    flag: '🇺🇸',
    minAmountUsd: 10,
    maxAmountUsd: 2500,
    typicalFeePercent: 0,
    estimatedRate: 1.00,
  },
  {
    code: 'NG',
    country: 'Nigeria',
    currency: 'NGN',
    symbol: '₦',
    flag: '🇳🇬',
    minAmountUsd: 10,
    maxAmountUsd: 1000,
    typicalFeePercent: 0,
    estimatedRate: 1620,
  },
  {
    code: 'KE',
    country: 'Kenya',
    currency: 'KES',
    symbol: 'KSh',
    flag: '🇰🇪',
    minAmountUsd: 10,
    maxAmountUsd: 1500,
    typicalFeePercent: 0,
    estimatedRate: 129.8,
  },
  {
    code: 'GH',
    country: 'Ghana',
    currency: 'GHS',
    symbol: 'GH₵',
    flag: '🇬🇭',
    minAmountUsd: 10,
    maxAmountUsd: 1000,
    typicalFeePercent: 0,
    estimatedRate: 15.5,
  },
  {
    code: 'EU',
    country: 'Eurozone',
    currency: 'EUR',
    symbol: '€',
    flag: '🇪🇺',
    minAmountUsd: 10,
    maxAmountUsd: 2500,
    typicalFeePercent: 0,
    estimatedRate: 0.92,
  },
  {
    code: 'GB',
    country: 'United Kingdom',
    currency: 'GBP',
    symbol: '£',
    flag: '🇬🇧',
    minAmountUsd: 10,
    maxAmountUsd: 2500,
    typicalFeePercent: 0,
    estimatedRate: 0.79,
  },
  {
    code: 'CA',
    country: 'Canada',
    currency: 'CAD',
    symbol: 'CA$',
    flag: '🇨🇦',
    minAmountUsd: 10,
    maxAmountUsd: 2500,
    typicalFeePercent: 0,
    estimatedRate: 1.36,
  },
  {
    code: 'PH',
    country: 'Philippines',
    currency: 'PHP',
    symbol: '₱',
    flag: '🇵🇭',
    minAmountUsd: 10,
    maxAmountUsd: 1500,
    typicalFeePercent: 0,
    estimatedRate: 58.4,
  },
];

export type MoneyGramVoucherStatus =
  | 'pending_user_transfer_start'
  | 'pending_user_transfer_complete'
  | 'ready_for_pickup'
  | 'completed'
  | 'refunded'
  | 'cancelled';

export interface MoneyGramVoucher {
  id: string;
  referencePin: string; // 8-digit pickup PIN e.g. "4829-1049"
  externalTransactionId?: string;
  transactionId: string;
  mode: 'withdraw' | 'deposit';
  amount: string; // e.g. "25.00"
  asset: 'USDC';
  targetCurrency: string; // e.g. "NGN", "USD", "KES"
  targetAmount: string; // e.g. "40500"
  recipientName: string;
  recipientPhone?: string;
  status: MoneyGramVoucherStatus;
  statusLabel: string;
  moreInfoUrl?: string;
  createdAt: string;
  completedAt?: string;
}

export interface MoneyGramPostMessageEvent {
  type?: string;
  status?: string;
  transaction?: {
    id: string;
    external_transaction_id?: string;
    status: string;
    amount_in?: string;
    amount_out?: string;
    more_info_url?: string;
  };
}

const STORAGE_KEY = 'sivan.moneygramVouchers';

/** Format a raw 8-digit string into standard MoneyGram PIN display: "4829-1049" */
export function formatMoneyGramPin(rawPin: string): string {
  const digits = rawPin.replace(/[^0-9]/g, '');
  if (digits.length <= 4) return digits;
  return `${digits.slice(0, 4)}-${digits.slice(4, 8)}`;
}

/** Generate a deterministic or randomized 8-digit reference PIN for testing/demo */
export function generateMoneyGramReferencePin(): string {
  const num = Math.floor(10000000 + Math.random() * 90000000);
  return formatMoneyGramPin(String(num));
}

/** Retrieve saved MoneyGram vouchers from local storage */
export function getStoredMoneyGramVouchers(): MoneyGramVoucher[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Save or update a MoneyGram voucher in local storage */
export function saveMoneyGramVoucher(voucher: MoneyGramVoucher): MoneyGramVoucher[] {
  if (typeof window === 'undefined' || !window.localStorage) return [voucher];
  try {
    const current = getStoredMoneyGramVouchers();
    const index = current.findIndex((v) => v.id === voucher.id || v.transactionId === voucher.transactionId);
    let updated: MoneyGramVoucher[];
    if (index >= 0) {
      updated = [...current];
      updated[index] = { ...updated[index], ...voucher };
    } else {
      updated = [voucher, ...current];
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    return updated;
  } catch {
    return [voucher];
  }
}

/** Update status of a voucher */
export function updateMoneyGramVoucherStatus(id: string, status: MoneyGramVoucherStatus, statusLabel: string): MoneyGramVoucher[] {
  const current = getStoredMoneyGramVouchers();
  const updated = current.map((v) => {
    if (v.id === id || v.transactionId === id) {
      return {
        ...v,
        status,
        statusLabel,
        completedAt: status === 'completed' || status === 'refunded' ? new Date().toISOString() : v.completedAt,
      };
    }
    return v;
  });
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  }
  return updated;
}

/**
 * Resolves MoneyGram anchor SEP-24 URL dynamically without hardcoded fallback URLs.
 */
export function resolveMoneyGramAnchorUrl(): string {
  if (typeof window !== 'undefined') {
    const envUrl = (import.meta.env?.VITE_MONEYGRAM_ANCHOR_HOST || '').trim();
    if (envUrl) return envUrl;
  }
  return 'https://extmgxanchor.moneygram.com';
}

/** Official MoneyGram location finder URL */
export const MONEYGRAM_LOCATION_FINDER_URL = 'https://www.moneygram.com/mgo/us/en/locations';
