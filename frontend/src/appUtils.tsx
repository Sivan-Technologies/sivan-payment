import { useState } from 'react';
import type { CustomerRecord, AssetControl, NetworkControl, OfframpControls, PaymentControl, ViewKey, VirtualAccountControl } from './types';

export const views: Array<{ key: ViewKey; icon: string; label: string }> = [
  { key: 'overview', icon: '▦', label: 'Dashboard' },
  { key: 'buy', icon: '↙', label: 'Buy stablecoins' },
  { key: 'receive', icon: '↓', label: 'Receive' },
  { key: 'transfer', icon: '⇆', label: 'Send & transfer' },
  { key: 'withdraw', icon: '↗', label: 'Withdraw' },
  { key: 'history', icon: '◷', label: 'Transactions' },
  { key: 'agreements', icon: '📜', label: 'Service agreements' },
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
  agreements: '/agreements',
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
  if (clean === '/agreements' || clean === '/service-agreements' || clean === '/app/agreements') return 'agreements';
  if (clean === '/bank-accounts' || clean === '/banks' || clean === '/app/payment-methods') return 'banks';
  if (clean === '/virtual-account' || clean === '/virtual-accounts' || clean === '/receiving-accounts' || clean === '/app/virtual-account') return 'virtualAccounts';
  if (clean === '/verification' || clean === '/verification-complete' || clean === '/app/verification') return 'kyc';
  if (clean === '/settings' || clean === '/app/settings') return 'settings';
  if (clean === '/help' || clean === '/support' || clean === '/app/support') return 'help';
  if (clean === '/email-recovery/confirm' || clean === '/recover-email') return 'emailRecovery';
  if (clean === '/signup' || clean === '/login' || clean === '/signin') return 'signup';
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

/**
 * Format crypto and fiat amounts for clean, professional display.
 *
 * Rules:
 * - If integer or whole amount (e.g. 5, 20, 20.000000): displays cleanly as "5" or "20" (no trailing .00).
 * - If fractional (e.g. 4.700000, 44.700000000000000016, 9.900000):
 *   rounds floating point jitter to at most 2 decimal places (e.g. "44.70", "4.70", "9.90").
 */
export function formatAmount(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '' || value === '—') return '—';
  const num = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(num)) return String(value);

  if (Math.abs(num - Math.round(num)) < 1e-6) {
    return Math.round(num).toLocaleString('en-US');
  }

  return num.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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
  // 429 is explicitly NOT retryable immediately: retrying on rate limit amplifies the burst
  return [408, 425, 502, 503, 504, 520, 522, 523, 524, 530].includes(status);
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
  { network: 'solana', enabled: true, isDefault: true, label: 'Solana', sortOrder: 10, updatedAt: new Date().toISOString() },
  { network: 'base', enabled: true, isDefault: false, label: 'Base', sortOrder: 20, updatedAt: new Date().toISOString() },
  { network: 'bsc', enabled: true, isDefault: false, label: 'BNB Chain', sortOrder: 25, updatedAt: new Date().toISOString() },
  { network: 'arc', enabled: true, isDefault: false, label: 'Arc', sortOrder: 26, updatedAt: new Date().toISOString() },
  { network: 'arbitrum', enabled: true, isDefault: false, label: 'Arbitrum', sortOrder: 27, updatedAt: new Date().toISOString() },
  { network: 'stellar', enabled: true, isDefault: false, label: 'Stellar', sortOrder: 28, updatedAt: new Date().toISOString() },
  { network: 'celo', enabled: true, isDefault: false, label: 'Celo', sortOrder: 29, updatedAt: new Date().toISOString() },
  { network: 'ethereum', enabled: false, isDefault: false, label: 'Ethereum', sortOrder: 30, updatedAt: new Date().toISOString() },
  { network: 'polygon', enabled: false, isDefault: false, label: 'Polygon', sortOrder: 40, updatedAt: new Date().toISOString() },
  { network: 'avalanche_c_chain', enabled: false, isDefault: false, label: 'Avalanche C-Chain', sortOrder: 60, updatedAt: new Date().toISOString() }
];

export const fallbackVirtualAccounts: VirtualAccountControl[] = [
  { currency: 'usd', enabled: false, label: 'USD virtual account', provider: 'bridge', accountType: 'us', paymentRails: ['ach_push', 'wire'], updatedAt: new Date().toISOString() },
  { currency: 'gbp', enabled: false, label: 'GBP virtual account', provider: 'bridge', accountType: 'gb', paymentRails: ['faster_payments'], updatedAt: new Date().toISOString() },
  { currency: 'eur', enabled: false, label: 'EUR virtual account', provider: 'bridge', accountType: 'iban', paymentRails: ['sepa'], updatedAt: new Date().toISOString() }
];

export function normalizeFrontendApiBase(value: string) {
  const clean = (value || '').trim().replace(/\/$/, '');
  try {
    const parsed = new URL(clean);
    const host = parsed.hostname.toLowerCase();
    if (host === 'api.sivantech.online' || host === 'test-sivan.sivantech.online' || host === 'api-staging.sivantech.online') {
      return `${parsed.origin}/api/payment`;
    }
    if (host === 'payment.sivantech.online') {
      return parsed.origin;
    }
    if (host.includes('sivan-payments-api-live')) {
      return 'https://api.sivantech.online/api/payment';
    }
    if (host.includes('sivan-payments-api-test')) {
      return 'https://api-staging.sivantech.online/api/payment';
    }
  } catch {
    // Keep local/relative values unchanged.
  }
  return clean || (typeof window !== 'undefined' && window.location.hostname === 'localhost' ? 'http://localhost:3000' : 'https://api-staging.sivantech.online/api/payment');
}

export function buildApiUrl(apiBase: string, path: string): string {
  const baseClean = (apiBase || '').trim().replace(/\/$/, '');
  const pathClean = path.startsWith('/') ? path : `/${path}`;
  if (baseClean.endsWith('/api') && !baseClean.endsWith('/api/payment') && pathClean.startsWith('/api/')) {
    return `${baseClean}${pathClean.slice(4)}`;
  }
  return `${baseClean}${pathClean}`;
}


export function normalizeOfframpControls(value: unknown): OfframpControls {
  const data = value as Partial<OfframpControls> | PaymentControl[] | undefined;
  if (Array.isArray(data)) {
    return {
      customerTypes: fallbackCustomerTypes,
      payoutCurrencies: data,
      virtualAccounts: fallbackVirtualAccounts,
      sourceAssets: fallbackSourceAssets,
      sourceNetworks: fallbackSourceNetworks,
      defaultNetwork: 'solana',
      supplierPayoutsEnabled: true
      // No displayFx on the legacy array shape - there is nowhere for it to
      // have come from. Consumers fall back to naira, which is what the
      // figures already are.
    };
  }
  return {
    customerTypes: data?.customerTypes ?? fallbackCustomerTypes,
    payoutCurrencies: data?.payoutCurrencies ?? [],
    virtualAccounts: data?.virtualAccounts ?? fallbackVirtualAccounts,
    sourceAssets: data?.sourceAssets ?? fallbackSourceAssets,
    sourceNetworks: data?.sourceNetworks ?? fallbackSourceNetworks,
    defaultNetwork: data?.defaultNetwork ?? data?.sourceNetworks?.find((n) => n.enabled && n.isDefault)?.network ?? 'solana',
    /**
     * DEFAULTS TO TRUE, and the direction matters.
     *
     * `?? true` means a failed or stale controls fetch shows the route and
     * lets the server refuse - annoying but honest. Defaulting to false would
     * hide a live, working feature every time this endpoint hiccupped, which
     * is a far worse failure: the user cannot tell "switched off" from
     * "broken", and neither can support.
     */
    supplierPayoutsEnabled: data?.supplierPayoutsEnabled ?? true,
    /**
     * `?? true` DELIBERATELY, and the opposite direction to the server.
     *
     * This normaliser is an allowlist - a field not named here is dropped, so
     * omitting it would have shipped a correct API and a UI that never saw it.
     *
     * The server defaults transfersEnabled to FALSE (fail closed on the money
     * path). Here it defaults to TRUE, because an older backend that does not
     * send the field at all must not have its send form disabled: that would
     * hide a working feature on every deployment predating this change. When
     * the field IS present it is obeyed exactly.
     */
    transfersEnabled: data?.transfersEnabled ?? true,
    /**
     * PASSED THROUGH, NOT DEFAULTED.
     *
     * This normaliser is an allowlist - it rebuilds the object field by field
     * and anything not named here is dropped. Adding displayFx to the API
     * without adding it here would have shipped a correct endpoint, a correct
     * formatter, and a dashboard that still printed naira, with nothing
     * obviously wrong in either half.
     *
     * Deliberately NOT given a fallback rate. `undefined` makes every consumer
     * render the exact naira figure; a made-up rate would make them all render
     * a wrong converted one. An absent rate must degrade to the truth.
     */
    displayFx: data?.displayFx
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



/**
 * NOTHING ABOUT OUR PLUMBING REACHES A TOAST.
 *
 * A user on production, entering a bank account on their phone, was shown:
 *
 *   "Bank verification is unavailable right now (provider: breet).
 *    Breet: failed to validate bank account."
 *
 * The server-side cause is fixed at its source and there is a sweep in the
 * API's error handler. This is the third layer, and it exists because the
 * frontend echoes `error.message` straight into a toast in twenty-three
 * places: any one of them can surface a string nobody vetted - from an older
 * API still running, from a proxy, or from a browser-generated network error.
 *
 * Belt and braces on purpose. A leak here is seen by a customer, and the cost
 * of one redundant check is nothing.
 */
const LEAKY_TERMS = [
  'breet', 'bridge', 'pajramp', 'paj ramp', 'privy', 'resend', 'nomba',
  'eversend', 'linkio', 'alchemy', 'neon', 'render', 'sumsub', 'persona',
  'provider:', 'api key', 'app_secret', 'app secret', 'econnrefused',
  'enotfound', 'etimedout', 'postgres', 'cannot read properties',
  'undefined is not', 'internal server error',
];

/** True when a message names a provider or an internal. */
export function messageLeaksInternals(message: string): boolean {
  const text = String(message ?? '').toLowerCase();
  return LEAKY_TERMS.some((term) =>
    term.endsWith(':') || term.includes(' ') ? text.includes(term) : new RegExp(`\\b${term}\\b`).test(text)
  );
}

/**
 * The sentence a user actually sees.
 *
 * A leaking message is replaced wholesale rather than trimmed: a string that
 * mentions our provider was not written for a customer, so no amount of
 * editing turns it into a good one. An empty or absent message gets the same
 * treatment, because a blank red box is worse than a plain sentence.
 */
export function userFacingMessage(message: unknown): string {
  const text = String((message as Error)?.message ?? message ?? '').trim();
  if (!text) return 'Something went wrong. Please try again.';
  if (messageLeaksInternals(text)) {
    return 'We could not complete that request. Please check your details and try again.';
  }
  return text;
}
