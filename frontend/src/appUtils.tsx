import { useState } from 'react';
import type { CustomerRecord, AssetControl, NetworkControl, OfframpControls, PaymentControl, ViewKey, VirtualAccountControl } from './types';

export const views: Array<{ key: ViewKey; icon: string; label: string }> = [
  { key: 'overview', icon: '▦', label: 'Dashboard' },
  { key: 'buy', icon: '↙', label: 'Buy stablecoins' },
  { key: 'receive', icon: '↓', label: 'Receive' },
  { key: 'transfer', icon: '⇆', label: 'Send & transfer' },
  { key: 'withdraw', icon: '↗', label: 'Sell crypto' },
  { key: 'history', icon: '◷', label: 'Transactions' },
  { key: 'banks', icon: '▭', label: 'Payment methods' },
  { key: 'virtualAccounts', icon: '▥', label: 'Virtual account' },
  { key: 'kyc', icon: '◈', label: 'Identity verification' },
  { key: 'settings', icon: '⚙', label: 'Settings' },
  { key: 'help', icon: '?', label: 'Support' }
];

export const publicViews: Array<{ key: 'landing' | 'signup' | 'signin' | 'help'; icon: string; label: string }> = [
  { key: 'landing', icon: '⌂', label: 'Home' },
  { key: 'signup', icon: '⊕', label: 'Create account' },
  { key: 'signin', icon: '↪', label: 'Sign in' },
  { key: 'help', icon: '?', label: 'Support' }
];

export const pathByView: Record<ViewKey, string> = {
  landing: '/',
  overview: '/dashboard',
  withdraw: '/withdraw',
  buy: '/buy',
  receive: '/receive',
  transfer: '/transfer',
  history: '/withdrawals',
  banks: '/bank-accounts',
  virtualAccounts: '/virtual-account',
  kyc: '/verification',
  settings: '/settings',
  help: '/help',
  signup: '/signup',
  emailRecovery: '/email-recovery/confirm'
};

export function viewFromPath(pathname: string): ViewKey {
  const clean = pathname.replace(/\/$/, '') || '/';
  if (clean === '/dashboard' || clean === '/app') return 'overview';
  if (clean === '/withdraw' || clean === '/app/sell') return 'withdraw';
  if (clean === '/transfer' || clean === '/send' || clean === '/app/transfer') return 'transfer';
  if (clean === '/buy' || clean === '/on-ramp' || clean === '/app/buy') return 'buy';
  if (clean === '/receive' || clean === '/deposit' || clean === '/app/receive') return 'receive';
  if (clean === '/withdrawals' || clean === '/history' || clean === '/app/transactions') return 'history';
  if (clean === '/bank-accounts' || clean === '/banks' || clean === '/app/payment-methods') return 'banks';
  if (clean === '/virtual-account' || clean === '/virtual-accounts' || clean === '/receiving-accounts' || clean === '/app/virtual-account') return 'virtualAccounts';
  if (clean === '/verification' || clean === '/verification-complete' || clean === '/app/verification') return 'kyc';
  if (clean === '/settings' || clean === '/app/settings') return 'settings';
  if (clean === '/help' || clean === '/support' || clean === '/app/support') return 'help';
  if (clean === '/email-recovery/confirm' || clean === '/recover-email') return 'emailRecovery';
  if (clean === '/signup' || clean === '/login') return 'signup';
  return 'landing';
}

export function readStorage<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function statusClass(status?: string) {
  if (!status) return 'pending';
  if (['completed', 'kyc_approved', 'verified', 'active'].includes(status)) return 'success';
  if (['failed', 'cancelled', 'kyc_rejected'].includes(status)) return 'danger';
  return 'pending';
}

export function friendlyStatus(status?: string) {
  const map: Record<string, string> = {
    created: 'Started',
    kyc_not_started: 'Not started',
    kyc_approved: 'Verified',
    kyc_under_review: 'Under review',
    kyc_incomplete: 'Action required',
    kyc_rejected: 'Verification failed',
    pending: 'Pending',
    approved: 'Approved',
    pending_deposit: 'Waiting for USDC',
    deposit_received: 'Deposit received',
    payout_processing: 'Sending to bank',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
    requires_action: 'Action required',
    verified: 'Verified',
    active: 'Active'
  };
  return status ? map[status] || status.replaceAll('_', ' ') : 'Not started';
}

export function kycOutcomeMessage(status?: string, customerAction?: CustomerRecord['customerAction']) {
  if (customerAction?.message) return customerAction.message;
  if (status === 'kyc_approved') return 'Identity verification successful. You can now use Sivan Payment features that require verification.';
  if (status === 'kyc_under_review') return 'Identity verification submitted. Our compliance team is reviewing it and this page will keep refreshing.';
  if (['kyc_rejected', 'failed', 'cancelled'].includes(status || '')) return 'Identity verification could not be completed. Please retry securely or contact support.';
  if (status === 'kyc_incomplete') return 'Identity verification needs one more step. Continue the secure verification flow to finish.';
  return 'Identity verification status refreshed.';
}

export function kycNoticeKind(status?: string) {
  if (status === 'kyc_approved') return 'success';
  if (status === 'kyc_under_review') return 'review';
  if (['kyc_rejected', 'failed', 'cancelled'].includes(status || '')) return 'failed';
  if (status === 'kyc_incomplete') return 'action';
  return 'neutral';
}


export function CustomSelect({ name, options, value, defaultValue, onChange, disabled = false }: { name: string; options: Array<{ value: string; label: string; helper?: string; disabled?: boolean }>; value?: string; defaultValue?: string; onChange?: (value: string) => void; disabled?: boolean }) {
  const firstEnabled = options.find((option) => !option.disabled)?.value || options[0]?.value || '';
  const [internalValue, setInternalValue] = useState(defaultValue || value || firstEnabled);
  const [open, setOpen] = useState(false);
  const selectedValue = value ?? internalValue;
  const selected = options.find((option) => option.value === selectedValue) || options.find((option) => !option.disabled) || options[0];
  const choose = (next: string) => {
    setInternalValue(next);
    onChange?.(next);
    setOpen(false);
  };
  return <div className="custom-select-wrap app-select-wrap"><input type="hidden" name={name} value={selected?.value || ''} /><button type="button" disabled={disabled} className={`custom-select-trigger ${open ? 'open' : ''}`} onClick={() => !disabled && setOpen((state) => !state)}><span><strong>{selected?.label || 'Select'}</strong>{selected?.helper && <small>{selected.helper}</small>}</span><em>⌄</em></button>{open && <div className="custom-select-menu app-select-menu">{options.map((option) => <button type="button" disabled={option.disabled} className={option.value === selected?.value ? 'selected' : ''} key={option.value} onClick={() => !option.disabled && choose(option.value)}><span>{option.label}</span>{option.helper && <small>{option.helper}</small>}</button>)}</div>}</div>;
}

export function Badge({ children, status }: { children: string; status?: string }) {
  return <span className={`badge ${statusClass(status)}`}>{children}</span>;
}

export function Empty({ children }: { children: string }) {
  return <div className="empty-state">{children}</div>;
}

export function getForm(form: HTMLFormElement) {
  return Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
}

export function shortRef(value?: string) {
  if (!value) return '—';
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export function timeAgo(value?: string, nowMs = Date.now()) {
  if (!value) return 'Now';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return 'Recently';
  const seconds = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(value).toLocaleDateString();
}

export function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function isRetryableNetworkError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase();
  return message.includes('failed to fetch') || message.includes('network') || message.includes('abort') || message.includes('load failed');
}

export function isRetryableHttpStatus(status: number) {
  return [408, 425, 429, 500, 502, 503, 504, 520, 522, 523, 524, 530].includes(status);
}

export const fallbackCustomerTypes = [
  { customerType: 'individual' as const, enabled: true, label: 'Individual', updatedAt: new Date().toISOString() },
  { customerType: 'business' as const, enabled: false, label: 'Business', updatedAt: new Date().toISOString() }
];

export const fallbackSourceAssets: AssetControl[] = [
  { asset: 'usdc', enabled: true, label: 'USDC', updatedAt: new Date().toISOString() },
  { asset: 'usdt', enabled: false, label: 'USDT', updatedAt: new Date().toISOString() }
];

/**
 * Used only until GET /api/offramp/controls answers.
 *
 * Mirrors DEFAULT_NETWORK_CONTROLS on the server, and must keep mirroring it.
 * It previously enabled avalanche_c_chain and nothing else - the same bug the
 * backend had - which meant a user on a slow connection was briefly offered
 * the one network Breet carries no stablecoin on, in either direction.
 */
export const fallbackSourceNetworks: NetworkControl[] = [
  { network: 'solana', enabled: true, label: 'Solana', sortOrder: 10, updatedAt: new Date().toISOString() },
  { network: 'base', enabled: true, label: 'Base', sortOrder: 20, updatedAt: new Date().toISOString() },
  { network: 'ethereum', enabled: true, label: 'Ethereum', sortOrder: 30, updatedAt: new Date().toISOString() },
  { network: 'polygon', enabled: false, label: 'Polygon', sortOrder: 40, updatedAt: new Date().toISOString() },
  { network: 'arbitrum', enabled: false, label: 'Arbitrum', sortOrder: 50, updatedAt: new Date().toISOString() },
  { network: 'avalanche_c_chain', enabled: false, label: 'Avalanche C-Chain', sortOrder: 60, updatedAt: new Date().toISOString() }
];

export const fallbackVirtualAccounts: VirtualAccountControl[] = [
  { currency: 'usd', enabled: false, label: 'USD virtual account', provider: 'bridge', accountType: 'us', paymentRails: ['ach_push', 'wire'], updatedAt: new Date().toISOString() },
  { currency: 'gbp', enabled: false, label: 'GBP virtual account', provider: 'bridge', accountType: 'gb', paymentRails: ['faster_payments'], updatedAt: new Date().toISOString() },
  { currency: 'eur', enabled: false, label: 'EUR virtual account', provider: 'bridge', accountType: 'iban', paymentRails: ['sepa'], updatedAt: new Date().toISOString() }
];

export function normalizeFrontendApiBase(value: string) {
  let clean = value.trim().replace(/\/$/, '');
  if (clean.endsWith('/api/payment')) {
    clean = clean.slice(0, -'/api/payment'.length);
  }
  try {
    const parsed = new URL(clean);
    const host = parsed.hostname.toLowerCase();
    if (host === 'api.sivantech.online') {
      return `${parsed.origin}/api/payment`;
    }
    if (host === 'test-sivan.sivantech.online') {
      return `${parsed.origin}/api/payment`;
    }
    if (host.includes('sivan-payments-api-live')) {
      return 'https://api.sivantech.online/api/payment';
    }
    if (host.includes('sivan-payments-api-test')) {
      return 'https://test-sivan.sivantech.online/api/payment';
    }
  } catch {
    // Keep local/relative values unchanged.
  }
  return clean;
}


export function normalizeOfframpControls(value: unknown): OfframpControls {
  const data = value as Partial<OfframpControls> | PaymentControl[] | undefined;
  if (Array.isArray(data)) {
    return {
      customerTypes: fallbackCustomerTypes,
      payoutCurrencies: data,
      virtualAccounts: fallbackVirtualAccounts,
      sourceAssets: fallbackSourceAssets,
      sourceNetworks: fallbackSourceNetworks
    };
  }
  return {
    customerTypes: data?.customerTypes ?? fallbackCustomerTypes,
    payoutCurrencies: data?.payoutCurrencies ?? [],
    virtualAccounts: data?.virtualAccounts ?? fallbackVirtualAccounts,
    sourceAssets: data?.sourceAssets ?? fallbackSourceAssets,
    sourceNetworks: data?.sourceNetworks ?? fallbackSourceNetworks
  };
}

export function initials(nameOrEmail?: string) {
  const value = nameOrEmail || 'User';
  const parts = value.includes('@') ? [value[0]] : value.trim().split(/\s+/);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'U';
}

export function qrUrl(value: string) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(value)}`;
}


export const legalVersions = {
  termsVersion: '2026-07-14',
  privacyVersion: '2026-07-14',
  riskDisclosureVersion: '2026-07-14'
};

export const legalLinks = {
  terms: 'https://www.sivantech.online/legal/terms',
  privacy: 'https://www.sivantech.online/legal/privacy',
  risk: 'https://www.sivantech.online/legal/risk-disclosure',
  dataRetention: 'https://www.sivantech.online/legal/data-retention',
  amlKyc: 'https://www.sivantech.online/legal/aml-kyc',
  jurisdictions: 'https://www.sivantech.online/legal/supported-jurisdictions',
  wrongNetwork: 'https://www.sivantech.online/legal/wrong-network',
  complaints: 'https://www.sivantech.online/legal/complaints',
  cookies: 'https://www.sivantech.online/legal/cookies'
};


export type UserNotification = {
  id: string;
  icon: string;
  title: string;
  message: string;
  severity: 'info' | 'action' | 'urgent';
  createdAt: string;
  actionLabel?: string;
  view?: ViewKey;
};

export type UserTwoFactorStatus = {
  userId: string;
  enabled: boolean;
  enabledAt?: string;
  lastVerifiedAt?: string;
  recoveryCodesRemaining?: number;
  recoveryQuestionsConfigured?: boolean;
  recoveryQuestionsCount?: number;
};


