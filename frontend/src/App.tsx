import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import type { CustomerRecord, DepositResponse, ExternalAccountRecord, AssetControl, FeePolicy, NetworkControl, OfframpControls, PaymentControl, SystemStatus, UserRecord, ViewKey, WithdrawalRecord, OnrampOrderRecord, SupportTicketRecord, UserPreferencesRecord, IdentityStatus, TransactionTimeline, VirtualAccountControl, VirtualAccountRecord, VirtualAccountRequestRecord, VirtualAccountTransactionRecord, SupplierRecord, SupplierPaymentRecord, BalanceSummary, BalanceTransferRecord } from './types';

const views: Array<{ key: ViewKey; icon: string; label: string }> = [
  { key: 'overview', icon: '▦', label: 'Dashboard' },
  { key: 'buy', icon: '↙', label: 'Buy crypto' },
  { key: 'transfer', icon: '⇆', label: 'Transfer & pay' },
  { key: 'withdraw', icon: '↗', label: 'Sell crypto' },
  { key: 'history', icon: '◷', label: 'Transactions' },
  { key: 'banks', icon: '▭', label: 'Payment methods' },
  { key: 'virtualAccounts', icon: '▥', label: 'Virtual account' },
  { key: 'kyc', icon: '◈', label: 'Verification' },
  { key: 'settings', icon: '⚙', label: 'Settings' },
  { key: 'help', icon: '?', label: 'Support' }
];

const publicViews: Array<{ key: 'landing' | 'signup' | 'signin' | 'help'; icon: string; label: string }> = [
  { key: 'landing', icon: '⌂', label: 'Home' },
  { key: 'signup', icon: '⊕', label: 'Create account' },
  { key: 'signin', icon: '↪', label: 'Sign in' },
  { key: 'help', icon: '?', label: 'Support' }
];

const pathByView: Record<ViewKey, string> = {
  landing: '/',
  overview: '/dashboard',
  withdraw: '/withdraw',
  buy: '/buy',
  transfer: '/transfer',
  history: '/withdrawals',
  banks: '/bank-accounts',
  virtualAccounts: '/virtual-account',
  kyc: '/verification',
  settings: '/settings',
  help: '/help',
  signup: '/signup'
};

function viewFromPath(pathname: string): ViewKey {
  const clean = pathname.replace(/\/$/, '') || '/';
  if (clean === '/dashboard' || clean === '/app') return 'overview';
  if (clean === '/withdraw' || clean === '/app/sell') return 'withdraw';
  if (clean === '/transfer' || clean === '/send' || clean === '/app/transfer') return 'transfer';
  if (clean === '/buy' || clean === '/on-ramp' || clean === '/app/buy') return 'buy';
  if (clean === '/withdrawals' || clean === '/history' || clean === '/app/transactions') return 'history';
  if (clean === '/bank-accounts' || clean === '/banks' || clean === '/app/payment-methods') return 'banks';
  if (clean === '/virtual-account' || clean === '/virtual-accounts' || clean === '/receiving-accounts' || clean === '/app/virtual-account') return 'virtualAccounts';
  if (clean === '/verification' || clean === '/verification-complete' || clean === '/app/verification') return 'kyc';
  if (clean === '/settings' || clean === '/app/settings') return 'settings';
  if (clean === '/help' || clean === '/support' || clean === '/app/support') return 'help';
  if (clean === '/signup' || clean === '/login') return 'signup';
  return 'landing';
}

function readStorage<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function statusClass(status?: string) {
  if (!status) return 'pending';
  if (['completed', 'kyc_approved', 'verified', 'active'].includes(status)) return 'success';
  if (['failed', 'cancelled', 'kyc_rejected'].includes(status)) return 'danger';
  return 'pending';
}

function friendlyStatus(status?: string) {
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

function kycOutcomeMessage(status?: string, customerAction?: CustomerRecord['customerAction']) {
  if (customerAction?.message) return customerAction.message;
  if (status === 'kyc_approved') return 'Verification successful. You can now use Sivan Payment features that require KYC.';
  if (status === 'kyc_under_review') return 'Verification submitted. Bridge is reviewing it and this page will keep refreshing.';
  if (['kyc_rejected', 'failed', 'cancelled'].includes(status || '')) return 'Verification could not be completed. Please retry securely or contact support.';
  if (status === 'kyc_incomplete') return 'Verification needs one more step. Continue the secure Bridge flow to finish.';
  return 'Verification status refreshed.';
}

function kycNoticeKind(status?: string) {
  if (status === 'kyc_approved') return 'success';
  if (status === 'kyc_under_review') return 'review';
  if (['kyc_rejected', 'failed', 'cancelled'].includes(status || '')) return 'failed';
  if (status === 'kyc_incomplete') return 'action';
  return 'neutral';
}

function Badge({ children, status }: { children: string; status?: string }) {
  return <span className={`badge ${statusClass(status)}`}>{children}</span>;
}

function Empty({ children }: { children: string }) {
  return <div className="empty-state">{children}</div>;
}

function getForm(form: HTMLFormElement) {
  return Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
}

function shortRef(value?: string) {
  if (!value) return '—';
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function timeAgo(value?: string, nowMs = Date.now()) {
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

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isRetryableNetworkError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase();
  return message.includes('failed to fetch') || message.includes('network') || message.includes('abort') || message.includes('load failed');
}

function isRetryableHttpStatus(status: number) {
  return [408, 425, 429, 500, 502, 503, 504, 520, 522, 523, 524, 530].includes(status);
}

const fallbackCustomerTypes = [
  { customerType: 'individual' as const, enabled: true, label: 'Individual', updatedAt: new Date().toISOString() },
  { customerType: 'business' as const, enabled: false, label: 'Business', updatedAt: new Date().toISOString() }
];

const fallbackSourceAssets: AssetControl[] = [
  { asset: 'usdc', enabled: true, label: 'USDC', updatedAt: new Date().toISOString() },
  { asset: 'usdt', enabled: false, label: 'USDT', updatedAt: new Date().toISOString() }
];

const fallbackSourceNetworks: NetworkControl[] = [
  { network: 'base', enabled: false, label: 'Base', sortOrder: 10, updatedAt: new Date().toISOString() },
  { network: 'polygon', enabled: false, label: 'Polygon', sortOrder: 20, updatedAt: new Date().toISOString() },
  { network: 'ethereum', enabled: false, label: 'Ethereum', sortOrder: 30, updatedAt: new Date().toISOString() },
  { network: 'solana', enabled: false, label: 'Solana', sortOrder: 40, updatedAt: new Date().toISOString() },
  { network: 'arbitrum', enabled: false, label: 'Arbitrum', sortOrder: 50, updatedAt: new Date().toISOString() },
  { network: 'avalanche_c_chain', enabled: true, label: 'Avalanche C-Chain', sortOrder: 60, updatedAt: new Date().toISOString() }
];

const fallbackVirtualAccounts: VirtualAccountControl[] = [
  { currency: 'usd', enabled: false, label: 'USD virtual account', provider: 'bridge', accountType: 'us', paymentRails: ['ach_push', 'wire'], updatedAt: new Date().toISOString() },
  { currency: 'gbp', enabled: false, label: 'GBP virtual account', provider: 'bridge', accountType: 'gb', paymentRails: ['faster_payments'], updatedAt: new Date().toISOString() },
  { currency: 'eur', enabled: false, label: 'EUR virtual account', provider: 'bridge', accountType: 'iban', paymentRails: ['sepa'], updatedAt: new Date().toISOString() }
];

function normalizeFrontendApiBase(value: string) {
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


function normalizeOfframpControls(value: unknown): OfframpControls {
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

function initials(nameOrEmail?: string) {
  const value = nameOrEmail || 'User';
  const parts = value.includes('@') ? [value[0]] : value.trim().split(/\s+/);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'U';
}

function qrUrl(value: string) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(value)}`;
}


const legalVersions = {
  termsVersion: '2026-07-14',
  privacyVersion: '2026-07-14',
  riskDisclosureVersion: '2026-07-14'
};

const legalLinks = {
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


type UserNotification = {
  id: string;
  icon: string;
  title: string;
  message: string;
  severity: 'info' | 'action' | 'urgent';
  createdAt: string;
  actionLabel?: string;
  view?: ViewKey;
};

type UserTwoFactorStatus = {
  userId: string;
  enabled: boolean;
  enabledAt?: string;
  lastVerifiedAt?: string;
  recoveryCodesRemaining?: number;
};


export default function App() {
  const [view, setView] = useState<ViewKey>(() => viewFromPath(window.location.pathname));
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'profile' | 'security' | 'notifications' | 'preferences'>('profile');
  const apiBase = useMemo(() => normalizeFrontendApiBase(import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000'), []);
  const appEnv = import.meta.env.VITE_APP_ENV || 'local';
  const isLiveEnv = appEnv === 'live' || appEnv === 'production';
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [authToken, setAuthToken] = useState(() => localStorage.getItem('sivan.authToken') || '');
  const [readNotificationIds, setReadNotificationIds] = useState<string[]>(() => readStorage<string[]>('sivan.readNotifications', []));
  const [twoFactorPromptDismissedUntil, setTwoFactorPromptDismissedUntil] = useState(() => Number(localStorage.getItem('sivan.2faPromptDismissedUntil') || 0));
  const [authTab, setAuthTab] = useState<'signup' | 'signin'>('signup');
  const [pendingEmail, setPendingEmail] = useState('');
  const [pendingFullName, setPendingFullName] = useState('');
  const [devCode, setDevCode] = useState<string | undefined>();
  const [resendAvailableAt, setResendAvailableAt] = useState(0);
  const [timeNow, setTimeNow] = useState(Date.now());
  const [user, setUser] = useState<UserRecord | null>(() => readStorage<UserRecord | null>('sivan.user', null));
  const [customer, setCustomer] = useState<CustomerRecord | null>(() => readStorage<CustomerRecord | null>('sivan.customer', null));
  const [accounts, setAccounts] = useState<ExternalAccountRecord[]>(() => readStorage<ExternalAccountRecord[]>('sivan.accounts', []));
  const [withdrawals, setWithdrawals] = useState<WithdrawalRecord[]>([]);
  const [onrampOrders, setOnrampOrders] = useState<OnrampOrderRecord[]>([]);
  const [virtualAccountRequests, setVirtualAccountRequests] = useState<VirtualAccountRequestRecord[]>([]);
  const [virtualAccounts, setVirtualAccounts] = useState<VirtualAccountRecord[]>([]);
  const [virtualAccountTransactions, setVirtualAccountTransactions] = useState<VirtualAccountTransactionRecord[]>([]);
  const [supportTickets, setSupportTickets] = useState<SupportTicketRecord[]>([]);
  const [balance, setBalance] = useState<BalanceSummary | null>(null);
  const [balanceTransfers, setBalanceTransfers] = useState<BalanceTransferRecord[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierRecord[]>([]);
  const [supplierPayments, setSupplierPayments] = useState<SupplierPaymentRecord[]>([]);
  const [userPreferences, setUserPreferences] = useState<UserPreferencesRecord | null>(null);
  const [identityStatus, setIdentityStatus] = useState<IdentityStatus | null>(null);
  const [twoFactorStatus, setTwoFactorStatus] = useState<UserTwoFactorStatus | null>(null);
  const [pairingCode, setPairingCode] = useState('');
  const [pairingExpiresAt, setPairingExpiresAt] = useState('');
  const [feePolicy, setFeePolicy] = useState<FeePolicy | null>(null);
  const [paymentControls, setPaymentControls] = useState<OfframpControls>({ customerTypes: fallbackCustomerTypes, payoutCurrencies: [], virtualAccounts: fallbackVirtualAccounts, sourceAssets: [], sourceNetworks: [] });
  const [systemStatus, setSystemStatus] = useState<SystemStatus>({ id: 'global', mode: 'active', updatedAt: new Date().toISOString() });
  const [depositResult, setDepositResult] = useState<DepositResponse | null>(null);
  const [withdrawalReview, setWithdrawalReview] = useState<null | { userId: string; externalAccountId: string; sourceCurrency: string; sourceChain: string; destinationCurrency: string; returnAddress?: string; bankLabel: string; assetLabel: string; networkLabel: string }>(null);
  const [otpCode, setOtpCode] = useState('');
  const [pendingTwoFactorToken, setPendingTwoFactorToken] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [loading, setLoading] = useState(false);

  const pageTitle = useMemo(() => view === 'landing' ? 'Sivan Payments' : views.find((item) => item.key === view)?.label ?? 'Home', [view]);
  const primaryAccount = accounts[0];
  const hasUser = Boolean(user?.id && authToken);
  const isVerified = customer?.kycStatus === 'kyc_approved';
  const hasBank = accounts.length > 0;
  const systemPaused = systemStatus.mode === 'paused';
  const systemMaintenance = systemStatus.mode === 'maintenance';
  const canStartKyc = !systemPaused;
  const canCreatePaymentActions = systemStatus.mode === 'active';
  const activeStep = !hasUser ? 'Create account' : !isVerified ? 'Verify identity' : !hasBank ? 'Add bank' : 'Ready to withdraw';
  const nextStepView: ViewKey = !hasUser ? 'signup' : !isVerified ? 'kyc' : !hasBank ? 'banks' : 'withdraw';
  const nextStepLabel = !hasUser ? 'Create account' : !isVerified ? 'Verify identity' : !hasBank ? 'Add bank account' : 'Withdraw stablecoins';
  const environmentLabel = appEnv === 'test' ? '⚠ Test environment — no real money moves' : isLiveEnv ? '● Live' : 'Local environment';
  const goToView = (nextView: ViewKey) => {
    setView(nextView);
    setMobileMenuOpen(false);
    setUserMenuOpen(false);
    setNotificationOpen(false);
    const nextPath = pathByView[nextView] ?? '/dashboard';
    if (window.location.pathname !== nextPath) window.history.pushState({}, '', nextPath);
  };

  const goToSettingsSecurity = () => {
    setSettingsInitialTab('security');
    goToView('settings');
  };

  const goToPublicView = (nextView: 'landing' | 'signup' | 'signin' | 'help') => {
    if (nextView === 'landing') {
      setView('landing');
      setMobileMenuOpen(false);
      setUserMenuOpen(false);
      setNotificationOpen(false);
      window.history.pushState({}, '', '/');
      return;
    }
    if (nextView === 'signin') {
      setAuthTab('signin');
      resetPendingEmail();
      goToView('signup');
      return;
    }
    if (nextView === 'signup') {
      setAuthTab('signup');
      resetPendingEmail();
      goToView('signup');
      return;
    }
    goToView('help');
  };
  const enabledCustomerTypes = (paymentControls.customerTypes ?? fallbackCustomerTypes).filter((control) => control.enabled);
  const enabledControls = (paymentControls.payoutCurrencies ?? []).filter((control) => control.enabled);
  const enabledAssets = (paymentControls.sourceAssets ?? []).filter((control) => control.enabled);
  const enabledNetworks = (paymentControls.sourceNetworks ?? []).filter((control) => control.enabled);


  useEffect(() => {
    localStorage.setItem('sivan.readNotifications', JSON.stringify(readNotificationIds.slice(-200)));
  }, [readNotificationIds]);

  useEffect(() => {
    localStorage.setItem('sivan.2faPromptDismissedUntil', String(twoFactorPromptDismissedUntil));
  }, [twoFactorPromptDismissedUntil]);

  const notifications = useMemo<UserNotification[]>(() => {
    const items: UserNotification[] = [];
    const push = (item: UserNotification) => items.push(item);
    const now = new Date().toISOString();
    for (const incident of systemStatus.activeIncidents ?? []) {
      push({ id: `incident:${incident.id}`, icon: incident.severity === 'critical' ? '!' : '⚠', title: incident.severity === 'critical' ? 'Service disruption' : 'Provider maintenance', message: incident.customerMessage || incident.message || 'Some payment services may be delayed.', severity: incident.severity === 'critical' ? 'urgent' : 'action', createdAt: incident.startedAt || (incident as any).createdAt || now, actionLabel: 'View support', view: 'help' });
    }
    if (customer?.kycStatus === 'kyc_incomplete') push({ id: `kyc:${customer.id}:incomplete`, icon: '◈', title: 'Verification needs one more step', message: customer.customerAction?.message || 'Complete the remaining verification details to continue.', severity: 'action', createdAt: customer.updatedAt || now, actionLabel: 'Continue', view: 'kyc' });
    else if (customer?.kycStatus === 'kyc_rejected') push({ id: `kyc:${customer.id}:rejected`, icon: '!', title: 'Verification needs support', message: 'Your verification could not be completed. Retry securely or contact support.', severity: 'urgent', createdAt: customer.updatedAt || now, actionLabel: 'Review', view: 'kyc' });
    else if (customer?.kycStatus === 'kyc_under_review') push({ id: `kyc:${customer.id}:review`, icon: '⏳', title: 'Verification under review', message: 'We will update your account as soon as review is complete.', severity: 'info', createdAt: customer.updatedAt || now, actionLabel: 'Check status', view: 'kyc' });
    else if (customer?.kycStatus === 'kyc_approved' && !hasBank) push({ id: `bank:${user?.id || 'me'}:missing`, icon: '▭', title: 'Add payout bank', message: 'You are verified. Add a payout bank to start selling crypto.', severity: 'action', createdAt: customer.updatedAt || now, actionLabel: 'Add bank', view: 'banks' });
    if (customer?.kycStatus === 'kyc_approved' && !twoFactorStatus?.enabled) push({ id: `security:${user?.id || 'me'}:2fa-recommended`, icon: '⚿', title: 'Protect your Sivan account', message: 'Enable authenticator 2FA to secure transfers and payouts.', severity: 'info', createdAt: customer.updatedAt || now, actionLabel: 'Enable', view: 'settings' });
    else if (!customer && hasUser) push({ id: `kyc:${user?.id || 'me'}:not-started`, icon: '◈', title: 'Verify your account', message: 'Complete identity verification to unlock payments.', severity: 'action', createdAt: user?.createdAt || now, actionLabel: 'Start', view: 'kyc' });

    for (const order of onrampOrders.slice(0, 5)) {
      if (order.status === 'awaiting_payment') push({ id: `onramp:${order.id}:awaiting`, icon: '↙', title: 'Buy order awaiting payment', message: `Send ${order.amount} ${order.sourceCurrency.toUpperCase()} using the exact reference.`, severity: 'action', createdAt: order.updatedAt || order.createdAt, actionLabel: 'View', view: 'history' });
      if (['payment_received', 'processing'].includes(order.status)) push({ id: `onramp:${order.id}:processing`, icon: '↙', title: 'Bank payment received', message: 'We are preparing your crypto delivery.', severity: 'info', createdAt: order.updatedAt || order.createdAt, actionLabel: 'Track', view: 'history' });
      if (order.status === 'failed') push({ id: `onramp:${order.id}:failed`, icon: '!', title: 'Buy order failed', message: 'Open the transaction timeline or contact support.', severity: 'urgent', createdAt: order.updatedAt || order.createdAt, actionLabel: 'View', view: 'history' });
    }

    for (const withdrawal of withdrawals.slice(0, 5)) {
      if (['pending_deposit', 'deposit_received', 'payout_processing', 'requires_action'].includes(withdrawal.status)) push({ id: `withdrawal:${withdrawal.id}:${withdrawal.status}`, icon: '↗', title: withdrawal.status === 'deposit_received' ? 'Withdrawal deposit detected' : 'Withdrawal in progress', message: withdrawal.status === 'requires_action' ? 'This withdrawal needs review.' : 'Your sell transaction is moving through settlement.', severity: withdrawal.status === 'requires_action' ? 'action' : 'info', createdAt: withdrawal.updatedAt || withdrawal.createdAt, actionLabel: 'Track', view: 'history' });
      if (withdrawal.status === 'failed') push({ id: `withdrawal:${withdrawal.id}:failed`, icon: '!', title: 'Withdrawal failed', message: 'Open the transaction timeline or contact support.', severity: 'urgent', createdAt: withdrawal.updatedAt || withdrawal.createdAt, actionLabel: 'View', view: 'history' });
    }

    for (const transfer of balanceTransfers.slice(0, 5)) {
      if (transfer.status === 'pending_review') push({ id: `balance-transfer:${transfer.transferId}:review`, icon: '⇆', title: 'Transfer held for review', message: 'Your transfer is pending compliance review.', severity: 'action', createdAt: transfer.updatedAt || transfer.createdAt, actionLabel: 'View', view: 'transfer' });
    }
    for (const payment of supplierPayments.slice(0, 5)) {
      if (payment.status === 'pending_review') push({ id: `supplier-payment:${payment.id}:review`, icon: '▭', title: 'Supplier payment held for review', message: 'Sivan is reviewing your supplier payout before provider release.', severity: 'action', createdAt: payment.updatedAt || payment.createdAt, actionLabel: 'View', view: 'transfer' });
      if (payment.status === 'failed') push({ id: `supplier-payment:${payment.id}:failed`, icon: '!', title: 'Supplier payment failed', message: 'Open Transfer & Pay or contact support.', severity: 'urgent', createdAt: payment.updatedAt || payment.createdAt, actionLabel: 'View', view: 'transfer' });
    }
    for (const tx of virtualAccountTransactions.slice(0, 4)) {
      if (!['completed', 'payment_processed'].includes(String(tx.status))) push({ id: `va-tx:${tx.id}:pending`, icon: '▥', title: 'Virtual account deposit pending', message: 'Funds are being settled before becoming available.', severity: 'info', createdAt: tx.updatedAt || tx.createdAt, actionLabel: 'View', view: 'virtualAccounts' });
      if (['completed', 'payment_processed'].includes(String(tx.status))) push({ id: `va-tx:${tx.id}:completed`, icon: '✓', title: 'USDC balance credited', message: 'A virtual account deposit has settled into your Sivan balance.', severity: 'info', createdAt: tx.updatedAt || tx.createdAt, actionLabel: 'View', view: 'transfer' });
    }
    for (const ticket of supportTickets.slice(0, 5)) {
      if (['open', 'in_review', 'waiting_on_user', 'waiting_on_provider'].includes(ticket.status)) push({ id: `support:${ticket.id}:${ticket.status}`, icon: '?', title: ticket.status === 'waiting_on_user' ? 'Support needs your response' : 'Support ticket active', message: `${ticket.subject || 'Your ticket'} · ${friendlyStatus(ticket.status)}`, severity: ticket.status === 'waiting_on_user' ? 'action' : 'info', createdAt: ticket.updatedAt || ticket.lastMessageAt || ticket.createdAt, actionLabel: 'Open', view: 'help' });
      if (ticket.status === 'resolved') push({ id: `support:${ticket.id}:resolved`, icon: '✓', title: 'Support ticket resolved', message: ticket.subject || 'Your ticket has been marked resolved.', severity: 'info', createdAt: ticket.updatedAt || ticket.closedAt || ticket.createdAt, actionLabel: 'View', view: 'help' });
    }
    const rank = { urgent: 3, action: 2, info: 1 } as const;
    return items.sort((a, b) => rank[b.severity] - rank[a.severity] || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 12);
  }, [systemStatus, customer, hasBank, hasUser, user, twoFactorStatus, onrampOrders, withdrawals, balanceTransfers, supplierPayments, virtualAccountTransactions, supportTickets]);

  const unreadNotifications = notifications.filter((item) => !readNotificationIds.includes(item.id));
  const notificationDotClass = unreadNotifications.some((item) => item.severity === 'urgent') ? 'urgent' : unreadNotifications.some((item) => item.severity === 'action') ? 'action' : '';
  const markNotificationRead = (id: string) => setReadNotificationIds((ids) => ids.includes(id) ? ids : [...ids, id]);
  const markAllNotificationsRead = () => setReadNotificationIds((ids) => Array.from(new Set([...ids, ...notifications.map((item) => item.id)])));
  const resendSeconds = Math.max(0, Math.ceil((resendAvailableAt - timeNow) / 1000));
  const verificationRedirectUri = useMemo(() => `${window.location.origin}/verification-complete`, []);
  const verificationUrl = customer?.hostedKycLink || customer?.kycLink;
  const kycStatus = customer?.kycStatus;
  const kycApproved = kycStatus === 'kyc_approved';
  const kycUnderReview = kycStatus === 'kyc_under_review';
  const kycFailed = ['kyc_rejected', 'failed', 'cancelled'].includes(kycStatus ?? '');
  const kycAlreadyStarted = Boolean(customer?.id && (verificationUrl || !['kyc_not_started', 'kyc_rejected', 'failed', 'cancelled'].includes(kycStatus ?? '')));
  const kycActionLabel = loading
    ? kycAlreadyStarted ? 'Opening...' : 'Starting...'
    : !canStartKyc ? 'Verification paused'
      : kycApproved ? 'Verified'
        : kycUnderReview ? 'Under review'
          : kycAlreadyStarted ? 'Continue verification'
            : kycFailed ? 'Restart verification'
              : 'Start verification';
  const canSubmitKyc = hasUser && canStartKyc && !loading && !kycApproved && !kycUnderReview;
  const setupPercent = Math.round(([hasUser, isVerified, hasBank].filter(Boolean).length / 3) * 100);
  const firstName = user?.fullName?.split(/\s+/)[0] || user?.email?.split('@')[0] || 'there';
  const completedWithdrawals = withdrawals.filter((withdrawal) => withdrawal.status === 'completed');
  const completedWithdrawalCount = completedWithdrawals.length;
  const completedVolume = completedWithdrawals.reduce((sum, withdrawal) => sum + Number(withdrawal.destinationAmount ?? withdrawal.sourceAmount ?? 0), 0);
  const completedActivityCount = completedWithdrawalCount
    + onrampOrders.filter((order) => order.status === 'completed').length
    + supplierPayments.filter((payment) => payment.status === 'completed').length
    + balanceTransfers.filter((transfer) => transfer.status === 'completed').length
    + virtualAccountTransactions.filter((tx) => ['completed', 'payment_processed'].includes(String(tx.status))).length;
  const showTwoFactorRecommendation = Boolean(isVerified && !twoFactorStatus?.enabled && Date.now() > twoFactorPromptDismissedUntil);

  const primaryAssetLabel = enabledAssets.map((asset) => asset.label).join(', ') || 'USDC';
  const primaryNetworkLabel = enabledNetworks.slice(0, 3).map((network) => network.label).join(', ') || 'Avalanche C-Chain';

  const logout = useCallback((message = 'You have been signed out.') => {
    setAuthToken('');
    setUser(null);
    setCustomer(null);
    setAccounts([]);
    setWithdrawals([]);
    setOnrampOrders([]);
    setSupportTickets([]);
    setVirtualAccountTransactions([]);
    setBalance(null);
    setBalanceTransfers([]);
    setUserPreferences(null);
    setIdentityStatus(null);
    setTwoFactorStatus(null);
    setDepositResult(null);
    localStorage.removeItem('sivan.authToken');
    localStorage.removeItem('sivan.user');
    localStorage.removeItem('sivan.customer');
    localStorage.removeItem('sivan.accounts');
    setView('landing');
    window.history.pushState({}, '', '/');
    setToast({ message, type: 'success' });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const notify = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 4800);
  }, []);

  const resetPendingEmail = useCallback(() => {
    setPendingEmail('');
    setPendingFullName('');
    setOtpCode('');
    setTwoFactorCode('');
    setPendingTwoFactorToken('');
    setDevCode(undefined);
    setResendAvailableAt(0);
  }, []);

  const api = useCallback(async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
    // Keep backend API paths intact. The Cloudflare payment gateway expects
    // /api/payment + /api/... so it can strip /api/payment and forward /api/...
    // to the payment service. Removing the second /api causes gateway 404s like
    // /api/payment/system/status and /api/payment/offramp/controls.
    const method = (options.method || 'GET').toUpperCase();
    const canRetry = method === 'GET' || method === 'HEAD';
    const attempts = canRetry ? 3 : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(`${apiBase}${path}`, {
          ...options,
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            ...(options.headers || {})
          }
        });
        window.clearTimeout(timeout);
        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (canRetry && isRetryableHttpStatus(response.status) && attempt < attempts) {
            await sleep(500 * attempt);
            continue;
          }
          if (response.status === 401 && authToken) logout('Session expired. Please sign in again.');
          const detailMessage = json?.error?.details?.message || json?.error?.details?.code || json?.details?.message || json?.details?.code;
          throw new Error(json?.error?.message || detailMessage || json?.message || 'Something went wrong. Please try again.');
        }
        return (json.data ?? json) as T;
      } catch (error) {
        window.clearTimeout(timeout);
        lastError = error;
        if (canRetry && isRetryableNetworkError(error) && attempt < attempts) {
          await sleep(650 * attempt);
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Network changed while contacting Sivan. Please retry.');
  }, [apiBase, authToken, logout]);

  useEffect(() => {
    if (authToken) localStorage.setItem('sivan.authToken', authToken);
    else localStorage.removeItem('sivan.authToken');
  }, [authToken]);

  useEffect(() => {
    if (user) localStorage.setItem('sivan.user', JSON.stringify(user));
    else localStorage.removeItem('sivan.user');
  }, [user]);

  useEffect(() => {
    if (customer) localStorage.setItem('sivan.customer', JSON.stringify(customer));
    else localStorage.removeItem('sivan.customer');
  }, [customer]);

  useEffect(() => {
    const protectedViews: ViewKey[] = ['overview', 'buy', 'transfer', 'withdraw', 'history', 'banks', 'virtualAccounts', 'kyc', 'settings'];
    if (!hasUser && protectedViews.includes(view)) {
      setAuthTab('signup');
      resetPendingEmail();
      setView('signup');
      if (window.location.pathname !== '/signup') window.history.replaceState({}, '', '/signup');
    }
  }, [hasUser, resetPendingEmail, view]);

  useEffect(() => {
    localStorage.setItem('sivan.accounts', JSON.stringify(accounts));
  }, [accounts]);

  useEffect(() => {
    if (!authToken) return;
    const timeoutMs = 30 * 60 * 1000;
    const updateActivity = () => localStorage.setItem('sivan.lastActivityAt', String(Date.now()));
    const checkActivity = () => {
      const last = Number(localStorage.getItem('sivan.lastActivityAt') || Date.now());
      if (Date.now() - last > timeoutMs) logout('Signed out after 30 minutes of inactivity.');
    };
    updateActivity();
    const events = ['click', 'keydown', 'mousemove', 'touchstart'];
    events.forEach((event) => window.addEventListener(event, updateActivity, { passive: true }));
    const interval = window.setInterval(checkActivity, 60_000);
    return () => {
      events.forEach((event) => window.removeEventListener(event, updateActivity));
      window.clearInterval(interval);
    };
  }, [authToken, logout]);

  const loadUserData = useCallback(async () => {
    if (!user?.id || !authToken) return;
    const [customerResult, accountsResult, withdrawalsResult, onrampOrdersResult, virtualAccountsResult, balanceResult, balanceTransfersResult, suppliersResult, supplierPaymentsResult, supportTicketsResult, preferencesResult, identityResult, twoFactorResult] = await Promise.allSettled([
      api<CustomerRecord>(`/api/customers/${user.id}`),
      api<ExternalAccountRecord[]>(`/api/users/${user.id}/external-accounts`),
      api<WithdrawalRecord[]>(`/api/users/${user.id}/withdrawals`),
      api<OnrampOrderRecord[]>(`/api/users/${user.id}/onramp-orders`),
      api<{ requests: VirtualAccountRequestRecord[]; accounts: VirtualAccountRecord[]; transactions?: VirtualAccountTransactionRecord[]; events?: any[] }>(`/api/users/${user.id}/virtual-accounts`),
      api<BalanceSummary>(`/api/users/${user.id}/balance`),
      api<BalanceTransferRecord[]>(`/api/users/${user.id}/balance/transfers`),
      api<SupplierRecord[]>(`/api/users/${user.id}/suppliers`),
      api<SupplierPaymentRecord[]>(`/api/users/${user.id}/supplier-payments`),
      api<SupportTicketRecord[]>(`/api/users/${user.id}/support/tickets`),
      api<UserPreferencesRecord>(`/api/users/${user.id}/preferences`),
      api<IdentityStatus>('/api/users/me/identity'),
      api<UserTwoFactorStatus>(`/api/users/${user.id}/2fa`)
    ]);
    if (customerResult.status === 'fulfilled') setCustomer(customerResult.value);
    if (accountsResult.status === 'fulfilled') setAccounts(accountsResult.value);
    if (withdrawalsResult.status === 'fulfilled') setWithdrawals(withdrawalsResult.value);
    if (onrampOrdersResult.status === 'fulfilled') setOnrampOrders(onrampOrdersResult.value);
    if (virtualAccountsResult.status === 'fulfilled') { setVirtualAccountRequests(virtualAccountsResult.value.requests ?? []); setVirtualAccounts(virtualAccountsResult.value.accounts ?? []); setVirtualAccountTransactions(virtualAccountsResult.value.transactions ?? []); }
    if (balanceResult.status === 'fulfilled') setBalance(balanceResult.value);
    if (balanceTransfersResult.status === 'fulfilled') setBalanceTransfers(balanceTransfersResult.value);
    if (suppliersResult.status === 'fulfilled') setSuppliers(suppliersResult.value);
    if (supplierPaymentsResult.status === 'fulfilled') setSupplierPayments(supplierPaymentsResult.value);
    if (supportTicketsResult.status === 'fulfilled') setSupportTickets(supportTicketsResult.value);
    if (preferencesResult.status === 'fulfilled') setUserPreferences(preferencesResult.value);
    if (identityResult.status === 'fulfilled') setIdentityStatus(identityResult.value);
    if (twoFactorResult.status === 'fulfilled') setTwoFactorStatus(twoFactorResult.value);
  }, [api, user?.id, authToken]);

  const refreshKycStatus = useCallback(async (showToast = false) => {
    if (!user?.id || !authToken) {
      if (showToast) notify('Create or sign in to your account first.', 'error');
      return null;
    }
    try {
      const refreshed = await api<CustomerRecord>(`/api/customers/${user.id}/kyc-status`);
      setCustomer(refreshed);
      if (showToast) notify(kycOutcomeMessage(refreshed.kycStatus, refreshed.customerAction), ['kyc_rejected', 'failed', 'cancelled'].includes(refreshed.kycStatus || '') ? 'error' : 'success');
      return refreshed;
    } catch (error) {
      if (showToast) notify((error as Error).message, 'error');
      return null;
    }
  }, [api, authToken, notify, user?.id]);

  const loadControls = useCallback(async () => {
    const [controls, status] = await Promise.all([
      api<unknown>('/api/offramp/controls').then(normalizeOfframpControls).catch(() => ({ customerTypes: fallbackCustomerTypes, payoutCurrencies: [], virtualAccounts: fallbackVirtualAccounts, sourceAssets: fallbackSourceAssets, sourceNetworks: fallbackSourceNetworks })),
      api<SystemStatus>('/api/system/status').catch(() => systemStatus)
    ]);
    setPaymentControls(controls);
    setSystemStatus(status);
    return controls;
  }, [api]);

  const loadFee = useCallback(async () => {
    const fee = await api<FeePolicy>('/api/fees/offramp').catch(() => null);
    if (fee) setFeePolicy(fee);
  }, [api]);

  useEffect(() => {
    void loadFee();
    void loadControls();
    void loadUserData();
  }, [loadFee, loadControls, loadUserData]);

  useEffect(() => {
    const onPopState = () => setView(viewFromPath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (view !== 'signup') return;
    if (window.location.pathname === '/login') setAuthTab('signin');
    if (window.location.pathname === '/signup') setAuthTab('signup');
  }, [view]);

  useEffect(() => {
    const refreshControls = () => {
      if (document.visibilityState === 'visible') void loadControls();
    };
    // Avoid hammering public bootstrap endpoints on unauthenticated signup/login
    // pages. Controls/status still refresh on focus/visibility, and authenticated
    // app sessions get a gentle one-minute background refresh.
    const interval = hasUser ? window.setInterval(refreshControls, 60_000) : undefined;
    window.addEventListener('focus', refreshControls);
    document.addEventListener('visibilitychange', refreshControls);
    return () => {
      if (interval) window.clearInterval(interval);
      window.removeEventListener('focus', refreshControls);
      document.removeEventListener('visibilitychange', refreshControls);
    };
  }, [hasUser, loadControls]);

  useEffect(() => {
    if (!pendingEmail || !resendAvailableAt) return;
    const interval = window.setInterval(() => setTimeNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [pendingEmail, resendAvailableAt]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const returnedFromVerification = window.location.pathname === '/verification-complete' || params.get('verification') === 'complete';
    if (!returnedFromVerification) return;
    setView('kyc');
    if (user?.id && authToken) {
      void (async () => {
        await loadUserData();
        await refreshKycStatus(true);
      })();
    } else {
      notify('Verification returned. Sign in to refresh your status.');
    }
    window.history.replaceState({}, document.title, '/verification');
  }, [authToken, loadUserData, notify, refreshKycStatus, user?.id]);

  useEffect(() => {
    if (!user?.id || !authToken || view !== 'kyc' || !customer?.id || kycApproved) return;
    const poll = () => void refreshKycStatus(false);
    poll();
    const interval = window.setInterval(poll, 15_000);
    window.addEventListener('focus', poll);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', poll);
    };
  }, [authToken, customer?.id, kycApproved, refreshKycStatus, user?.id, view]);


  async function handleEmailAuthStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    try {
      const body = getForm(event.currentTarget);
      const result = await api<{ message: string; expiresAt: string; devCode?: string }>('/api/auth/email/start', {
        method: 'POST',
        body: JSON.stringify({
          email: body.email,
          fullName: authTab === 'signup' ? body.fullName : undefined,
          intent: authTab,
          legalAcceptance: authTab === 'signup' ? {
            accepted: body.legalAccepted === 'on',
            ...legalVersions
          } : undefined
        })
      });
      setPendingEmail(body.email);
      setPendingFullName(body.fullName || '');
      setOtpCode('');
      setDevCode(result.devCode);
      setResendAvailableAt(Date.now() + 30_000);
      setTimeNow(Date.now());
      notify(authTab === 'signup' ? 'Verification code sent. Enter it to create your account.' : 'Login code sent. Enter it to continue.');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }


  async function handleResendCode() {
    if (!pendingEmail || resendSeconds > 0) return;
    setLoading(true);
    try {
      const result = await api<{ message: string; expiresAt: string; devCode?: string }>('/api/auth/email/start', {
        method: 'POST',
        body: JSON.stringify({
          email: pendingEmail,
          fullName: authTab === 'signup' ? pendingFullName : undefined,
          intent: authTab,
          legalAcceptance: authTab === 'signup' ? {
            accepted: true,
            ...legalVersions
          } : undefined
        })
      });
      setOtpCode('');
      setDevCode(result.devCode);
      setResendAvailableAt(Date.now() + 30_000);
      setTimeNow(Date.now());
      notify('A new verification code has been sent.');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleEmailAuthVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    try {
      const body = getForm(event.currentTarget);
      const result = await api<{ token?: string; user?: UserRecord; expiresInMinutes?: number; requiresTwoFactor?: boolean; twoFactorToken?: string; email?: string; expiresAt?: string }>('/api/auth/email/verify', {
        method: 'POST',
        body: JSON.stringify({ email: pendingEmail, code: body.code || otpCode })
      });
      if (result.requiresTwoFactor && result.twoFactorToken) {
        setPendingTwoFactorToken(result.twoFactorToken);
        setOtpCode('');
        notify('Enter your authenticator code to finish signing in.');
        return;
      }
      if (!result.token || !result.user) throw new Error('Authentication response was incomplete.');
      setAuthToken(result.token);
      setUser(result.user);
      setPendingEmail('');
      setOtpCode('');
      setTwoFactorCode('');
      setPendingTwoFactorToken('');
      setDevCode(undefined);
      localStorage.setItem('sivan.lastActivityAt', String(Date.now()));
      notify(authTab === 'signup' ? 'Account verified. Continue your setup.' : 'Welcome back.');
      goToView('overview');
      window.setTimeout(() => void loadUserData(), 0);
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }


  async function handleTwoFactorLoginVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingTwoFactorToken) return notify('Two-factor session expired. Sign in again.', 'error');
    setLoading(true);
    try {
      const result = await api<{ token: string; user: UserRecord; expiresInMinutes: number }>('/api/auth/2fa/verify', {
        method: 'POST',
        body: JSON.stringify({ twoFactorToken: pendingTwoFactorToken, code: twoFactorCode })
      });
      setAuthToken(result.token);
      setUser(result.user);
      setPendingEmail('');
      setOtpCode('');
      setTwoFactorCode('');
      setPendingTwoFactorToken('');
      setDevCode(undefined);
      localStorage.setItem('sivan.lastActivityAt', String(Date.now()));
      notify('Two-factor verified. Welcome back.');
      goToView('overview');
      window.setTimeout(() => void loadUserData(), 0);
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }


  async function handleKyc(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.id) return notify('Create your account first.', 'error');
    if (!canStartKyc) return notify(systemStatus.message || 'Verification is temporarily paused.', 'error');
    if (kycApproved) return notify('Your identity is already verified.');
    if (kycUnderReview) return notify('Verification is under review. We will update this page once it is complete.');
    const formBeforeLoading = getForm(event.currentTarget);
    const verificationWindow = window.open('', '_blank');
    if (verificationWindow) {
      verificationWindow.document.title = 'Opening Sivan verification';
      verificationWindow.document.body.style.background = '#07090d';
      verificationWindow.document.body.style.color = '#eef3f7';
      verificationWindow.document.body.style.fontFamily = 'Inter, system-ui, sans-serif';
      verificationWindow.document.body.style.padding = '32px';
      verificationWindow.document.body.innerHTML = '<h2>Opening secure verification…</h2><p>Please keep this tab open.</p>';
    }
    setLoading(true);
    try {
      const latestControls = await loadControls();
      const latestEnabledCustomerTypes = (latestControls.customerTypes ?? fallbackCustomerTypes).filter((control) => control.enabled);
      if (!latestEnabledCustomerTypes.some((control) => control.customerType === formBeforeLoading.type)) {
        verificationWindow?.close();
        return notify(`${formBeforeLoading.type === 'business' ? 'Business' : 'Individual'} verification is currently unavailable.`, 'error');
      }
      const body = formBeforeLoading;
      const created = await api<CustomerRecord>('/api/customers/kyc-link', {
        method: 'POST',
        body: JSON.stringify({
          userId: user.id,
          type: body.type || 'individual',
          redirectUri: body.redirectUri || verificationRedirectUri || `${window.location.origin}/verification-complete`
        })
      });
      setCustomer(created);
      const nextVerificationUrl = created.hostedKycLink || created.kycLink;
      if (nextVerificationUrl) {
        if (verificationWindow) {
          verificationWindow.opener = null;
          verificationWindow.location.assign(nextVerificationUrl);
        } else {
          window.open(nextVerificationUrl, '_blank', 'noopener,noreferrer');
        }
        notify(created.tosStatus === 'approved' ? 'Verification opened in a new tab. Keep this page open and return here when you finish.' : 'Verification opened in a new tab. If Terms remains pending, accept it from the verification status card when you return.');
      } else {
        verificationWindow?.close();
        notify('Verification started. Return here after completing the secure verification steps.');
      }
      setView('kyc');
    } catch (error) {
      verificationWindow?.close();
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function refreshKyc() {
    await refreshKycStatus(true);
  }


  async function handleBalanceTransfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.id) return notify('Create your account first.', 'error');
    if (!isVerified) return notify('Please complete verification before transferring crypto.', 'error');
    setLoading(true);
    try {
      const data = getForm(event.currentTarget);
      const transfer = await api<BalanceTransferRecord>(`/api/users/${user.id}/balance/transfers`, {
        method: 'POST',
        body: JSON.stringify({ asset: data.asset || 'usdc', network: data.network, amount: data.amount, destinationAddress: data.destinationAddress, note: data.note || undefined })
      });
      setBalanceTransfers((items) => [transfer, ...items.filter((item) => item.transferId !== transfer.transferId)]);
      await loadUserData();
      notify('Transfer request created. Sivan will process it from your available balance.');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }


  async function handleCreateSupplier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.id) return notify('Create your account first.', 'error');
    if (!isVerified) return notify('Please complete verification before adding a supplier.', 'error');
    setLoading(true);
    try {
      const data = getForm(event.currentTarget);
      const isUsd = data.currency === 'usd';
      const isGbp = data.currency === 'gbp';
      const isMxn = data.currency === 'mxn';
      const isBrl = data.currency === 'brl';
      const body: Record<string, unknown> = {
        supplierName: data.supplierName,
        supplierType: data.supplierType || 'business',
        supplierCountry: data.supplierCountry || (isGbp ? 'GB' : isUsd ? 'US' : isMxn ? 'MX' : isBrl ? 'BR' : 'FR'),
        currency: data.currency,
        accountType: isUsd ? 'us' : isGbp ? 'gb' : isMxn ? 'clabe' : isBrl ? 'pix' : 'iban',
        bankName: data.bankName,
        accountOwnerName: data.accountOwnerName,
        businessName: data.supplierName,
        address: isUsd
          ? { street_line_1: data.street || '923 Folsom Street', country: 'USA', state: data.state || 'CA', city: data.city || 'San Francisco', postal_code: data.postalCode || '94107' }
          : isGbp
            ? { street_line_1: data.street || '1 King Street', country: 'GBR', city: data.city || 'London', postal_code: data.postalCode || 'SW1A 1AA' }
            : isMxn
              ? { street_line_1: data.street || 'Av. Reforma', country: 'MEX', city: data.city || 'Mexico City', state: data.state || 'CDMX', postal_code: data.postalCode || '06600' }
              : isBrl
                ? { street_line_1: data.street || 'Av. Paulista', country: 'BRA', city: data.city || 'Sao Paulo', state: data.state || 'SP', postal_code: data.postalCode || '01310-100' }
                : { street_line_1: data.street || '2 Rue de la Paix', country: data.ibanCountry || 'FRA', city: data.city || 'Paris', postal_code: data.postalCode || '75002' }
      };
      if (isUsd) body.account = { routing_number: data.routingNumber, account_number: data.accountNumber, checking_or_savings: 'checking' };
      else if (isGbp) body.account = { sort_code: data.sortCode, account_number: data.gbAccountNumber };
      else if (isMxn) body.clabe = { account_number: data.clabeNumber };
      else if (isBrl) body.pix = { key: data.pixKey };
      else body.iban = { account_number: data.ibanAccountNumber, bic: data.bic || undefined, country: data.ibanCountry || 'FRA' };
      const supplier = await api<SupplierRecord>(`/api/users/${user.id}/suppliers`, { method: 'POST', body: JSON.stringify(body) });
      setSuppliers((items) => [supplier, ...items.filter((item) => item.id !== supplier.id)]);
      notify('Supplier added for compliance review. Admin approval is required before first payout.');
      (event.currentTarget as HTMLFormElement).reset();
      await loadUserData();
    } catch (error) { notify((error as Error).message, 'error'); } finally { setLoading(false); }
  }

  async function handleSupplierPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.id) return notify('Create your account first.', 'error');
    if (!isVerified) return notify('Please complete verification before paying suppliers.', 'error');
    setLoading(true);
    try {
      const data = getForm(event.currentTarget);
      const supplier = suppliers.find((item) => item.id === data.supplierId);
      const payment = await api<SupplierPaymentRecord>(`/api/users/${user.id}/supplier-payments`, { method: 'POST', body: JSON.stringify({ supplierId: data.supplierId, amount: data.amount, sourceAsset: 'usdc', destinationCurrency: supplier?.currency || data.destinationCurrency || 'usd', paymentPurpose: data.paymentPurpose, invoiceUrl: data.invoiceUrl || undefined }) });
      setSupplierPayments((items) => [payment, ...items.filter((item) => item.id !== payment.id)]);
      notify('Supplier payment created and held for risk review. AI can recommend, but admin/backend controls release funds.');
      (event.currentTarget as HTMLFormElement).reset();
      await loadUserData();
    } catch (error) { notify((error as Error).message, 'error'); } finally { setLoading(false); }
  }

  async function handleBank(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.id) return notify('Create your account first.', 'error');
    if (!isVerified) return notify('Please complete verification before adding a bank account.', 'error');
    if (!canCreatePaymentActions) return notify(systemStatus.message || 'New bank accounts are temporarily unavailable.', 'error');
    setLoading(true);
    try {
      const data = getForm(event.currentTarget);
      const latestControls = await loadControls();
      const latestEnabledControls = latestControls.payoutCurrencies.filter((control) => control.enabled);
      if (!latestEnabledControls.some((control) => control.currency === data.currency)) throw new Error(`${data.currency.toUpperCase()} withdrawals are currently unavailable.`);
      const isUsd = data.currency === 'usd';
      const isGbp = data.currency === 'gbp';
      const isMxn = data.currency === 'mxn';
      const isBrl = data.currency === 'brl';
      const body: Record<string, unknown> = {
        userId: user.id,
        currency: data.currency,
        accountType: isUsd ? 'us' : isGbp ? 'gb' : 'iban',
        paymentRail: isUsd ? 'ach' : isGbp ? 'faster_payments' : 'sepa',
        bankName: data.bankName,
        accountName: `${data.accountOwnerName} account`,
        accountOwnerName: data.accountOwnerName,
        accountOwnerType: 'individual',
        firstName: data.firstName,
        lastName: data.lastName,
        address: isUsd
          ? { street_line_1: data.street || '923 Folsom Street', country: 'USA', state: data.state || 'CA', city: data.city || 'San Francisco', postal_code: data.postalCode || '94107' }
          : isGbp
            ? { street_line_1: data.street || '1 King Street', country: 'GBR', city: data.city || 'London', postal_code: data.postalCode || 'SW1A 1AA' }
            : isMxn
              ? { street_line_1: data.street || 'Av. Reforma', country: 'MEX', city: data.city || 'Mexico City', state: data.state || 'CDMX', postal_code: data.postalCode || '06600' }
              : isBrl
                ? { street_line_1: data.street || 'Av. Paulista', country: 'BRA', city: data.city || 'Sao Paulo', state: data.state || 'SP', postal_code: data.postalCode || '01310-100' }
                : { street_line_1: data.street || '2 Rue de la Paix', country: data.ibanCountry || 'FRA', city: data.city || 'Paris', postal_code: data.postalCode || '75002' }
      };
      if (isUsd) {
        body.account = { routing_number: data.routingNumber, account_number: data.accountNumber, checking_or_savings: 'checking' };
      } else if (isGbp) {
        body.account = { sort_code: data.sortCode, account_number: data.gbAccountNumber };
      } else {
        body.iban = { account_number: data.ibanAccountNumber, bic: data.bic || undefined, country: data.ibanCountry || 'FRA' };
      }
      const account = await api<ExternalAccountRecord>('/api/external-accounts', { method: 'POST', body: JSON.stringify(body) });
      setAccounts((existing) => [account, ...existing.filter((item) => item.id !== account.id)]);
      notify('Bank account added. You can now create a withdrawal.');
      setView('withdraw');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }


  async function handleVirtualAccountRequest(currency: 'usd' | 'gbp' | 'eur') {
    if (!user?.id) return notify('Create your account first.', 'error');
    if (!isVerified) return notify('Please complete verification before requesting a virtual account.', 'error');
    if (!canCreatePaymentActions) return notify(systemStatus.message || 'New virtual account requests are temporarily unavailable.', 'error');
    setLoading(true);
    try {
      const result = await api<VirtualAccountRequestRecord>(`/api/users/${user.id}/virtual-accounts/request`, {
        method: 'POST',
        body: JSON.stringify({ currency, useCase: 'Receive fiat deposits into Sivan and convert to supported stablecoin settlement.' })
      });
      setVirtualAccountRequests((items) => [result, ...items.filter((item) => item.id !== result.id)]);
      notify(`${currency.toUpperCase()} virtual account request submitted.`);
      await loadUserData();
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleOnramp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.id) return notify('Create your account first.', 'error');
    if (!isVerified) return notify('Please complete verification before buying stablecoins.', 'error');
    if (!canCreatePaymentActions) return notify(systemStatus.message || 'New payment actions are temporarily unavailable.', 'error');
    setLoading(true);
    try {
      const data = getForm(event.currentTarget);
      const amount = Number(data.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a valid amount.');
      const latestControls = await loadControls();
      const enabledCurrencySet = new Set(latestControls.payoutCurrencies.filter((control) => control.enabled).map((control) => control.currency));
      const enabledAssetSet = new Set(latestControls.sourceAssets.filter((control) => control.enabled).map((control) => control.asset));
      const enabledNetworkSet = new Set(latestControls.sourceNetworks.filter((control) => control.enabled).map((control) => control.network));
      if (!enabledCurrencySet.has(data.sourceCurrency as 'usd' | 'gbp' | 'eur')) throw new Error(`${data.sourceCurrency.toUpperCase()} on-ramp payments are currently unavailable.`);
      if (!enabledAssetSet.has(data.destinationCurrency as 'usdc' | 'usdt')) throw new Error(`${data.destinationCurrency.toUpperCase()} purchases are currently unavailable.`);
      if (!enabledNetworkSet.has(data.destinationChain as any)) throw new Error(`${data.destinationChain} destination network is currently unavailable.`);
      const order = await api<OnrampOrderRecord>('/api/onramp/orders', {
        method: 'POST',
        body: JSON.stringify({
          userId: user.id,
          sourceCurrency: data.sourceCurrency,
          destinationCurrency: data.destinationCurrency,
          destinationChain: data.destinationChain,
          destinationAddress: data.destinationAddress,
          amount
        })
      });
      setOnrampOrders((orders) => [order, ...orders.filter((item) => item.id !== order.id)]);
      await loadUserData();
      notify('On-ramp order created. Follow the payment instructions exactly.');
    } catch (error) {
      if (isRetryableNetworkError(error)) {
        await loadUserData();
        notify('Network changed while creating the order. I refreshed your latest buy orders — check payment instructions below.', 'error');
      } else {
        notify((error as Error).message, 'error');
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleWithdraw(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.id) return notify('Create your account first.', 'error');
    if (!isVerified) return notify('Please complete verification first.', 'error');
    if (!accounts.length) return notify('Add a bank account first.', 'error');
    if (!canCreatePaymentActions) return notify(systemStatus.message || 'New withdrawals are temporarily unavailable.', 'error');
    setLoading(true);
    try {
      const data = getForm(event.currentTarget);
      const latestControls = await loadControls();
      const enabledCurrencySet = new Set(latestControls.payoutCurrencies.filter((control) => control.enabled).map((control) => control.currency));
      const enabledAssetSet = new Set(latestControls.sourceAssets.filter((control) => control.enabled).map((control) => control.asset));
      const enabledNetworkSet = new Set(latestControls.sourceNetworks.filter((control) => control.enabled).map((control) => control.network));
      if (!enabledAssetSet.has(data.sourceCurrency as 'usdc' | 'usdt')) throw new Error(`${data.sourceCurrency.toUpperCase()} deposits are currently unavailable.`);
      if (!enabledNetworkSet.has(data.sourceChain as any)) throw new Error(`${data.sourceChain} deposits are currently unavailable.`);
      const selectedAccount = accounts.find((account) => account.id === data.externalAccountId && enabledCurrencySet.has(account.currency)) || accounts.find((account) => enabledCurrencySet.has(account.currency));
      if (!selectedAccount) throw new Error('Choose a bank account first.');
      const assetLabel = latestControls.sourceAssets.find((asset) => asset.asset === data.sourceCurrency)?.label || data.sourceCurrency.toUpperCase();
      const networkLabel = latestControls.sourceNetworks.find((network) => network.network === data.sourceChain)?.label || data.sourceChain;
      setWithdrawalReview({
        userId: user.id,
        externalAccountId: selectedAccount.id,
        sourceCurrency: data.sourceCurrency,
        sourceChain: data.sourceChain,
        destinationCurrency: selectedAccount.currency,
        returnAddress: data.returnAddress,
        bankLabel: `${selectedAccount.bankName || 'Bank account'} ****${selectedAccount.accountLast4 || '----'}`,
        assetLabel,
        networkLabel
      });
      setDepositResult(null);
      notify('Review your withdrawal details before creating a deposit address.');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }


  async function confirmWithdrawal() {
    if (!withdrawalReview) return;
    setLoading(true);
    try {
      const result = await api<DepositResponse>('/api/withdrawals', {
        method: 'POST',
        body: JSON.stringify(withdrawalReview)
      });
      setWithdrawalReview(null);
      setDepositResult(result);
      await loadUserData();
      notify('Deposit address created. Send only the selected asset and network.');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }



  async function handleSaveUserPreferences(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.id) return notify('Create your account first.', 'error');
    setLoading(true);
    try {
      const form = event.currentTarget;
      const data = getForm(form);
      const checkbox = (name: string, current: boolean) => form.querySelector<HTMLInputElement>(`input[type="checkbox"][name="${name}"]`)?.checked ?? current;
      const updated = await api<UserPreferencesRecord>(`/api/users/${user.id}/preferences`, {
        method: 'PUT',
        body: JSON.stringify({
          defaultFiatCurrency: data.defaultFiatCurrency || userPreferences?.defaultFiatCurrency || 'usd',
          language: data.language || userPreferences?.language || 'en-US',
          transactionUpdates: checkbox('transactionUpdates', userPreferences?.transactionUpdates ?? true),
          marketingEmails: checkbox('marketingEmails', userPreferences?.marketingEmails ?? false),
          securityAlerts: checkbox('securityAlerts', userPreferences?.securityAlerts ?? true),
          emailConfirmationsForHighValue: checkbox('emailConfirmationsForHighValue', userPreferences?.emailConfirmationsForHighValue ?? false)
        })
      });
      setUserPreferences(updated);
      notify('Preferences saved.');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }


  async function handleUpdateUserPreferences(patch: Partial<UserPreferencesRecord>) {
    if (!user?.id) return notify('Create your account first.', 'error');
    const optimistic = { ...(userPreferences ?? { userId: user.id, defaultFiatCurrency: 'usd' as const, language: 'en-US', transactionUpdates: true, marketingEmails: false, securityAlerts: true, emailConfirmationsForHighValue: false, updatedAt: new Date().toISOString() }), ...patch, updatedAt: new Date().toISOString() } as UserPreferencesRecord;
    setUserPreferences(optimistic);
    setLoading(true);
    try {
      const updated = await api<UserPreferencesRecord>(`/api/users/${user.id}/preferences`, {
        method: 'PUT',
        body: JSON.stringify({
          defaultFiatCurrency: optimistic.defaultFiatCurrency,
          language: optimistic.language,
          transactionUpdates: optimistic.transactionUpdates,
          marketingEmails: optimistic.marketingEmails,
          securityAlerts: optimistic.securityAlerts,
          emailConfirmationsForHighValue: optimistic.emailConfirmationsForHighValue,
          ...patch
        })
      });
      setUserPreferences(updated);
      notify('Notification preference updated.');
    } catch (error) {
      await loadUserData();
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleStartWhatsappLink() {
    if (!user?.id) return notify('Create your account first.', 'error');
    setLoading(true);
    try {
      const result = await api<any>('/api/users/me/identity/link-whatsapp/start', { method: 'POST', body: '{}' });
      if (result?.token) {
        setPairingCode(result.token);
        setPairingExpiresAt(result.expiresAt || '');
      }
      await loadUserData();
      if (result?.token) notify('Pairing code generated. Send it to Sivan on WhatsApp.');
      else notify(result?.message || 'Pairing request is ready.');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleCancelWhatsappLink() {
    setLoading(true);
    try {
      await api('/api/users/me/identity/link-whatsapp/cancel', { method: 'POST', body: '{}' });
      setPairingCode('');
      setPairingExpiresAt('');
      await loadUserData();
      notify('Pairing code canceled.');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleUnlinkWhatsapp() {
    setLoading(true);
    try {
      if (!window.confirm('Unlink this WhatsApp / Escrow identity from your Sivan web account?')) return;
      await api('/api/users/me/identity/unlink-whatsapp', { method: 'POST', body: '{}' });
      setPairingCode('');
      setPairingExpiresAt('');
      await loadUserData();
      notify('WhatsApp account unlinked.');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateSupportTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.id) return notify('Create your account first.', 'error');
    const form = event.currentTarget;
    setLoading(true);
    try {
      const data = getForm(form);
      const formData = new FormData(form);
      const file = formData.get('attachment') instanceof File ? formData.get('attachment') as File : null;
      let attachmentUrl = data.attachmentUrl || undefined;
      let attachmentObjectKey: string | undefined;
      if (file && file.size > 0) {
        const upload = await api<{ uploadUrl: string; publicUrl?: string; objectKey: string; headers?: Record<string, string> }>('/api/support/attachments/upload-url', {
          method: 'POST',
          body: JSON.stringify({ userId: user.id, fileName: file.name, contentType: file.type || 'application/octet-stream', sizeBytes: file.size })
        });
        const uploaded = await fetch(upload.uploadUrl, { method: 'PUT', headers: upload.headers || { 'Content-Type': file.type }, body: file });
        if (!uploaded.ok) throw new Error('Attachment upload failed. Please try again or paste an attachment URL.');
        attachmentUrl = upload.publicUrl || upload.uploadUrl.split('?')[0];
        attachmentObjectKey = upload.objectKey;
      }
      const [resourceTypeRaw, resourceIdRaw] = (data.relatedItem || 'general:').split(':');
      const resourceType = resourceTypeRaw || 'general';
      const resourceId = resourceIdRaw || undefined;
      const ticket = await api<SupportTicketRecord>('/api/support/tickets', {
        method: 'POST',
        body: JSON.stringify({
          userId: user.id,
          type: data.type,
          subject: data.subject,
          description: data.description,
          resourceType,
          resourceId,
          transactionHash: data.transactionHash || undefined,
          bankReference: data.bankReference || undefined,
          walletAddress: data.walletAddress || undefined,
          attachmentUrl,
          metadata: attachmentObjectKey ? { attachmentObjectKey } : undefined
        })
      });
      setSupportTickets((tickets) => [ticket, ...tickets.filter((item) => item.id !== ticket.id)]);
      notify(`Support ticket created: ${ticket.id}`);
      form.reset();
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  if (view === 'landing') {
    return <LandingPage
      isLiveEnv={isLiveEnv}
      appEnv={appEnv}
      hasUser={hasUser}
      assets={primaryAssetLabel}
      networks={primaryNetworkLabel}
      payoutCurrencies={enabledControls.map((control) => control.currency.toUpperCase()).join(', ') || 'USD, GBP, EUR'}
      feePercent={feePolicy?.percent || '1.25'}
      onGetStarted={() => goToView(hasUser ? 'overview' : 'signup')}
      onDashboard={() => goToView('overview')}
      onBuy={() => goToView('buy')}
    />;
  }

  return (
    <div className={`app-shell ${hasUser ? 'authenticated' : 'public'} ${mobileMenuOpen ? 'menu-open' : ''}`}>
      <button className="mobile-menu-overlay" aria-label="Close menu" onClick={() => setMobileMenuOpen(false)} />
      <aside className={`sidebar app-sidebar ${mobileMenuOpen ? 'open' : ''}`}>
        <button className="mobile-menu-close" aria-label="Close menu" onClick={() => setMobileMenuOpen(false)}>×</button>
        <div className="brand app-brand">
          <img className="brand-logo" src="/asset/sivan-logo.png" alt="Sivan logo" />
          <h1>Sivan</h1>
        </div>

        <nav className="nav app-nav">
          {hasUser ? views.map((item) => (
            <button key={item.key} className={`nav-item ${view === item.key ? 'active' : ''}`} onClick={() => goToView(item.key)}>
              <span>{item.icon}</span> {item.label}
            </button>
          )) : publicViews.map((item) => {
            const active = item.key === 'landing'
              ? false
              : item.key === 'help'
                ? view === 'help'
                : view === 'signup' && ((item.key === 'signin' && authTab === 'signin') || (item.key === 'signup' && authTab === 'signup'));
            return <button key={item.key} className={`nav-item ${active ? 'active' : ''}`} onClick={() => goToPublicView(item.key)}>
              <span>{item.icon}</span> {item.label}
            </button>;
          })}
        </nav>

        {!hasUser && <PublicSidebarCta onCreate={() => goToPublicView('signup')} />}

        <div className="sidebar-footer app-sidebar-footer">
          <div className="sidebar-status"><span></span>{systemStatus.mode === 'active' ? 'All systems operational' : systemStatus.mode === 'maintenance' ? 'Maintenance mode' : 'Payments paused'}</div>
          <div className="sidebar-legal-links"><a href={legalLinks.terms} target="_blank" rel="noreferrer">Terms</a><a href={legalLinks.privacy} target="_blank" rel="noreferrer">Privacy</a><a href={legalLinks.risk} target="_blank" rel="noreferrer">Risk</a></div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar app-topbar">
          <button className="mobile-menu-button" aria-label="Open menu" onClick={() => setMobileMenuOpen(true)}><span></span><span></span><span></span></button>
          <h2>{pageTitle}</h2>
          <div className="top-actions app-top-actions">
            {hasUser && <><div className="search-wrap"><span>⌕</span><input placeholder="Search transactions, accounts..." aria-label="Search transactions and accounts" /></div><NotificationCenter open={notificationOpen} notifications={notifications} unreadCount={unreadNotifications.length} dotClass={notificationDotClass} readIds={readNotificationIds} timeNow={timeNow} onToggle={() => { setNotificationOpen((open) => !open); setUserMenuOpen(false); }} onClose={() => setNotificationOpen(false)} onMarkAllRead={markAllNotificationsRead} onOpen={(item) => { markNotificationRead(item.id); if (item.view === 'settings') goToSettingsSecurity(); else if (item.view) goToView(item.view); }} /></>}
            {hasUser ? <div className="user-menu-wrap"><button className="user-pill" onClick={() => setUserMenuOpen((open) => !open)}><span className="avatar-button small-avatar">{initials(user?.fullName || user?.email)}</span><span><strong>{user?.fullName || 'Sivan user'}</strong><small>{user?.email}</small></span></button>{userMenuOpen && <div className="user-menu"><button onClick={() => goToView('settings')}>Settings</button><button onClick={() => logout('Signed out successfully.')}>Sign out</button></div>}</div> : <button className="primary-btn small topbar-signin" onClick={() => goToPublicView('signin')}>Sign in</button>}
          </div>
        </header>

        {toast && <section className={`toast ${toast.type === 'error' ? 'error' : ''}`}>{toast.message}</section>}

        {(systemStatus.activeIncidents?.length || systemStatus.mode !== 'active') && <IncidentBanner systemStatus={systemStatus} />}

        {view === 'overview' && (
          <section className="view active dashboard-view app-dashboard">
            {customer ? <KycOutcomeNotice customer={customer} hasBank={hasBank} onContinue={() => goToView(isVerified && hasBank ? 'transfer' : nextStepView)} onSupport={() => goToView('help')} onRefresh={refreshKyc} /> : <DashboardAccountNotice onVerify={() => goToView('kyc')} />}
            <div className="dashboard-actions-row">
              <button className="dashboard-action-card sell" onClick={() => goToView('withdraw')}><span>↗</span><div><strong>Sell crypto</strong><small>Convert crypto to cash in your bank</small></div><em>→</em></button>
              <button className="dashboard-action-card buy" onClick={() => goToView('buy')}><span>↙</span><div><strong>Buy crypto</strong><small>Buy stablecoins with fiat via transfer or card</small></div><em>→</em></button><button className="dashboard-action-card transfer" onClick={() => goToView('transfer')}><span>⇆</span><div><strong>Transfer & pay</strong><small>Send settled USDC or pay suppliers</small></div><em>→</em></button>
            </div>

            <div className="dashboard-kpis">
              <KpiCard label="Total volume" value={completedVolume ? `$${completedVolume.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '$0.00'} sub="Completed payouts" trend={completedWithdrawalCount ? `${completedWithdrawalCount} completed` : 'No completed payouts yet'} />
              <KpiCard label="Transactions" value={String(withdrawals.length + onrampOrders.length)} sub="Lifetime" trend={(withdrawals.length + onrampOrders.length) ? `${withdrawals.length + onrampOrders.length} records` : 'Start your first'} />
              <KpiCard label="Avg. payout time" value="1–2 days" sub="Provider + bank rail" trend="Tracked by status" />
              <KpiCard label="Verification" value={isVerified ? 'Verified' : 'Incomplete'} sub={isVerified ? 'Ready' : 'Action required'} trend={friendlyStatus(customer?.kycStatus)} />
            </div>

            <div className="dashboard-main-grid">
              <DashboardTransactions withdrawals={withdrawals} onrampOrders={onrampOrders} onStart={() => goToView('withdraw')} onBuy={() => goToView('buy')} onViewAll={() => goToView('history')} />
              <div className="dashboard-side-stack">
                {showTwoFactorRecommendation && <TwoFactorRecommendationCard completedCount={completedActivityCount} onEnable={goToSettingsSecurity} onDismiss={() => setTwoFactorPromptDismissedUntil(Date.now() + 7 * 24 * 60 * 60 * 1000)} />}
                <DashboardSetupPanel setupPercent={setupPercent} hasUser={hasUser} isVerified={isVerified} hasBank={hasBank} user={user} onContinue={() => goToView(!isVerified ? 'kyc' : !hasBank ? 'banks' : 'banks')} />
                <SecurityReminder onSettings={() => goToView('settings')} />
              </div>
            </div>
          </section>
        )}


        {view === 'signup' && (
          <section className="form-layout auth-premium-layout">
            <article className="panel form-panel auth-card-premium">
              <div className="auth-card-topline"><span>Secure access</span><em>Passwordless</em></div>
              <h3>{pendingEmail ? 'Check your email' : authTab === 'signup' ? 'Create your Sivan account' : 'Welcome back to Sivan'}</h3>
              <p className="muted auth-lead">{pendingEmail ? 'Enter the 6-digit code we sent. This keeps your account secure without passwords.' : authTab === 'signup' ? 'Start with secure email access, then complete verification when you are ready to move money.' : 'Sign in with a one-time code. No password to remember, no seed phrase ever requested.'}</p>
              <div className="auth-tabs">
                <button type="button" className={authTab === 'signup' ? 'active' : ''} onClick={() => { setAuthTab('signup'); resetPendingEmail(); }}>Create account</button>
                <button type="button" className={authTab === 'signin' ? 'active' : ''} onClick={() => { setAuthTab('signin'); resetPendingEmail(); }}>Sign in</button>
              </div>
              {!pendingEmail ? (
                <form className="form auth-form-premium" onSubmit={handleEmailAuthStart}>
                  <label>Email address<input name="email" type="email" placeholder="you@example.com" autoComplete="email" required /></label>
                  {authTab === 'signup' && <label>Full name<input name="fullName" placeholder="Olaleye Micheal Samson" autoComplete="name" required /></label>}
                  {authTab === 'signup' && <label className="legal-checkbox auth-legal-card"><input name="legalAccepted" type="checkbox" required /><span>I agree to Sivan’s <a href={legalLinks.terms} target="_blank" rel="noreferrer">Terms</a>, <a href={legalLinks.privacy} target="_blank" rel="noreferrer">Privacy Policy</a>, and <a href={legalLinks.risk} target="_blank" rel="noreferrer">Risk Disclosure</a>.</span></label>}
                  <button className="primary-btn auth-submit" disabled={loading}>{loading ? 'Sending secure code…' : authTab === 'signup' ? 'Send verification code →' : 'Send login code →'}</button>
                </form>
              ) : pendingTwoFactorToken ? (
                <form className="form auth-form-premium" onSubmit={handleTwoFactorLoginVerify}>
                  <div className="email-confirmation auth-email-confirmation"><span>Two-factor required</span><strong>{pendingEmail}</strong><button type="button" onClick={resetPendingEmail}>Start over</button></div>
                  <label>Authenticator or recovery code<input value={twoFactorCode} onChange={(event) => setTwoFactorCode(event.target.value)} placeholder="123456 or recovery code" autoComplete="one-time-code" required /></label>
                  <button className="primary-btn auth-submit" disabled={loading || twoFactorCode.replace(/\s/g, '').length < 6}>{loading ? 'Verifying…' : 'Verify and continue →'}</button>
                </form>
              ) : (
                <form className="form auth-form-premium" onSubmit={handleEmailAuthVerify}>
                  <div className="email-confirmation auth-email-confirmation">
                    <span>Code sent to</span>
                    <strong>{pendingEmail}</strong>
                    <button type="button" onClick={resetPendingEmail}>Change email</button>
                  </div>
                  <OtpInput value={otpCode} onChange={setOtpCode} />
                  {devCode && <div className="dev-code">Test code: <strong>{devCode}</strong></div>}
                  <button className="primary-btn auth-submit" disabled={loading || otpCode.length < 6}>{loading ? 'Checking secure code…' : 'Continue to dashboard →'}</button>
                  <button type="button" className="ghost-btn" disabled={loading || resendSeconds > 0} onClick={handleResendCode}>{resendSeconds > 0 ? `Resend code in ${resendSeconds}s` : 'Resend code'}</button>
                </form>
              )}
              <div className="auth-trust-row"><span>Encrypted session</span><span>No password storage</span><span>Sivan never asks for private keys</span></div>
            </article>
            <article className="premium-card auth-showcase-card">
              <span className="orb" />
              <div className="auth-showcase-badge">Sivan Payments</div>
              <h3>Move money with a safer, cleaner payment account.</h3>
              <p>Buy stablecoins, sell to bank, receive virtual-account deposits, and use Transfer & Pay — all after secure verification.</p>
              <div className="auth-flow-preview">
                <div><span>1</span><strong>Email access</strong><small>One-time secure code</small></div>
                <div><span>2</span><strong>Verify once</strong><small>Unlock payments</small></div>
                <div><span>3</span><strong>Transfer & pay</strong><small>Use settled USDC</small></div>
              </div>
              <ul className="auth-benefit-list"><li>✓ Passwordless login</li><li>✓ Customer-safe provider routing</li><li>✓ Support-ready transaction timelines</li></ul>
            </article>
          </section>
        )}

        {view === 'kyc' && <VerificationPage hasUser={hasUser} customer={customer} customerTypes={paymentControls.customerTypes ?? fallbackCustomerTypes} kycFailed={kycFailed} canSubmitKyc={canSubmitKyc} kycActionLabel={kycActionLabel} verificationRedirectUri={verificationRedirectUri} onSubmit={handleKyc} onRefresh={refreshKyc} onSupport={() => goToView('help')} onAddBank={() => goToView('banks')} onSell={() => goToView('withdraw')} hasBank={hasBank} />}

        {view === 'banks' && <PaymentMethodsView accounts={accounts} onSubmit={handleBank} loading={loading} isVerified={isVerified} controls={enabledControls} canCreatePaymentActions={canCreatePaymentActions} isLiveEnv={isLiveEnv} onRefresh={loadUserData} />}

        {view === 'virtualAccounts' && <VirtualAccountsView requests={virtualAccountRequests} accounts={virtualAccounts} transactions={virtualAccountTransactions} controls={paymentControls.virtualAccounts} loading={loading} isVerified={isVerified} canCreatePaymentActions={canCreatePaymentActions} onRequest={handleVirtualAccountRequest} onRefresh={loadUserData} />}

        {view === 'withdraw' && (
          <OffRampWizard
            accounts={accounts}
            enabledControls={enabledControls}
            enabledAssets={enabledAssets}
            enabledNetworks={enabledNetworks}
            primaryAccount={primaryAccount}
            withdrawalReview={withdrawalReview}
            depositResult={depositResult}
            feePercent={feePolicy?.percent}
            loading={loading}
            canCreatePaymentActions={canCreatePaymentActions}
            onSubmit={handleWithdraw}
            onCancelReview={() => setWithdrawalReview(null)}
            onConfirm={confirmWithdrawal}
          />
        )}

        {view === 'buy' && <BuyCryptoView hasUser={hasUser} isVerified={isVerified} feePercent={feePolicy?.percent || '1.25'} enabledControls={enabledControls} enabledAssets={enabledAssets} enabledNetworks={enabledNetworks} orders={onrampOrders} loading={loading} onSubmit={handleOnramp} onSell={() => goToView('withdraw')} onContinue={() => goToView(hasUser ? isVerified ? 'banks' : 'kyc' : 'signup')} onSupport={() => goToView('help')} onRefreshOrders={loadUserData} />}
        {view === 'transfer' && <TransferCryptoView hasUser={hasUser} isVerified={isVerified} balance={balance} transfers={balanceTransfers} suppliers={suppliers} supplierPayments={supplierPayments} enabledNetworks={enabledNetworks} loading={loading} onSubmit={handleBalanceTransfer} onCreateSupplier={handleCreateSupplier} onSupplierPayment={handleSupplierPayment} onContinue={() => goToView(hasUser ? isVerified ? 'buy' : 'kyc' : 'signup')} onRefresh={loadUserData} />}

        {view === 'history' && <TransactionsView user={user} api={api} withdrawals={withdrawals} onrampOrders={onrampOrders} onStart={() => goToView('withdraw')} onBuy={() => goToView('buy')} />}

        {view === 'settings' && <SettingsView api={api} user={user} preferences={userPreferences} initialTab={settingsInitialTab} twoFactorStatus={twoFactorStatus} onTwoFactorStatusChanged={setTwoFactorStatus} identityStatus={identityStatus} pairingCode={pairingCode} pairingExpiresAt={pairingExpiresAt} timeNow={timeNow} onStartWhatsappLink={handleStartWhatsappLink} onCancelWhatsappLink={handleCancelWhatsappLink} onUnlinkWhatsapp={handleUnlinkWhatsapp} onRefreshIdentity={loadUserData} onSavePreferences={handleSaveUserPreferences} onUpdatePreferences={handleUpdateUserPreferences} loading={loading} onLogout={() => logout('Signed out successfully.')} />}
        {view === 'help' && <SupportView hasUser={hasUser} tickets={supportTickets} withdrawals={withdrawals} onrampOrders={onrampOrders} accounts={accounts} customer={customer} api={api} onCreateTicket={handleCreateSupportTicket} onTicketsChanged={setSupportTickets} loading={loading} />}

      </main>
    </div>
  );
}


function SidebarSetupCard({ setupPercent, hasUser, isVerified, hasBank, onContinue }: { setupPercent: number; hasUser: boolean; isVerified: boolean; hasBank: boolean; onContinue: () => void }) {
  const helper = !hasUser ? 'Create your account to start.' : !isVerified ? 'Verify your identity next.' : !hasBank ? 'Add your payout method.' : 'Ready for transactions.';
  return <article className="sidebar-setup-card"><p>Account setup</p><strong>{setupPercent}%</strong><div className="bar"><div className="fill" style={{ width: `${setupPercent}%` }} /></div><small>{helper}</small><button className="primary-btn" onClick={onContinue}>Continue setup ›</button></article>;
}

function PublicSidebarCta({ onCreate }: { onCreate: () => void }) {
  return <article className="sidebar-setup-card public-cta"><p>New to Sivan?</p><strong>Start</strong><small>Create your account to access payments, verification, and linked WhatsApp identity.</small><button className="primary-btn" onClick={onCreate}>Create account ›</button></article>;
}

function KpiCard({ label, value, sub, trend }: { label: string; value: string; sub: string; trend: string }) {
  return <article className="kpi-card"><p>{label}</p><strong>{value}</strong><span>{sub}</span><small>{trend}</small></article>;
}

function DashboardTransactions({ withdrawals, onrampOrders, onStart, onBuy, onViewAll }: { withdrawals: WithdrawalRecord[]; onrampOrders: OnrampOrderRecord[]; onStart: () => void; onBuy: () => void; onViewAll: () => void }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const rows = [
    ...withdrawals.map((withdrawal) => ({
      id: withdrawal.id,
      key: `sell:${withdrawal.id}`,
      direction: 'sell' as const,
      icon: '↗',
      title: `Sell · ${withdrawal.sourceAmount || '—'} ${withdrawal.sourceCurrency?.toUpperCase?.() || 'USDC'}`,
      sub: 'To bank payout',
      amount: `${withdrawal.destinationAmount || '—'} ${withdrawal.destinationCurrency?.toUpperCase() || ''}`,
      status: withdrawal.status,
      createdAt: withdrawal.createdAt,
      details: [
        ['Request ID', withdrawal.id],
        ['Provider reference', withdrawal.providerDrainId || withdrawal.destinationReference || 'Pending'],
        ['Crypto sent', `${withdrawal.sourceAmount || '—'} ${withdrawal.sourceCurrency?.toUpperCase?.() || 'USDC'}`],
        ['Bank payout', `${withdrawal.destinationAmount || '—'} ${withdrawal.destinationCurrency?.toUpperCase?.() || ''}`],
        ['Current stage', friendlyStatus(withdrawal.status)],
        ['Created', new Date(withdrawal.createdAt).toLocaleString()]
      ]
    })),
    ...onrampOrders.map((order) => ({
      id: order.id,
      key: `buy:${order.id}`,
      direction: 'buy' as const,
      icon: '↙',
      title: `Buy · ${order.amount || '—'} ${order.sourceCurrency?.toUpperCase?.() || 'USD'}`,
      sub: `${order.destinationCurrency?.toUpperCase?.() || 'USDC'} on ${String(order.destinationChain || 'network').replaceAll('_', ' ')}`,
      amount: `${order.netAmount || '—'} ${order.destinationCurrency?.toUpperCase?.() || ''}`,
      status: order.status,
      createdAt: order.createdAt,
      details: [
        ['Request ID', order.id],
        ['Provider reference', order.providerTransferId || order.providerReference || 'Pending'],
        ['You pay', `${order.amount || '—'} ${order.sourceCurrency?.toUpperCase?.() || 'USD'}`],
        ['You receive', `${order.netAmount || '—'} ${order.destinationCurrency?.toUpperCase?.() || 'USDC'}`],
        ['Destination', `${String(order.destinationChain || 'network').replaceAll('_', ' ')}${order.destinationAddress ? ` · ${shortRef(order.destinationAddress)}` : ''}`],
        ['Current stage', friendlyStatus(order.status)]
      ]
    })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 4);

  return <article className="dashboard-transactions"><div className="dash-card-head"><div><p className="eyebrow">Activity</p><h3>Recent transactions</h3></div><button onClick={onViewAll}>View all ↗</button></div>{!rows.length ? <div className="dashboard-empty"><p>No transactions yet.</p><div className="button-row"><button className="secondary-btn" onClick={onStart}>⊕ Sell crypto</button><button className="secondary-btn" onClick={onBuy}>↙ Buy crypto</button></div></div> : <><div className="dashboard-tx-list">{rows.map((tx) => {
    const open = expandedId === tx.key;
    return <div className={`dashboard-tx-card ${open ? 'open' : ''}`} key={tx.key}><button type="button" className="dashboard-tx" onClick={() => setExpandedId(open ? null : tx.key)} aria-expanded={open}><span className={`tx-icon ${tx.direction}`}>{tx.icon}</span><div><strong>{tx.title}</strong><small>{tx.sub}</small></div><div><b>{tx.amount}</b><Badge status={tx.status}>{friendlyStatus(tx.status)}</Badge></div><time>{new Date(tx.createdAt).toLocaleDateString()}</time><span className="tx-chevron">⌄</span></button>{open && <div className="dashboard-tx-details"><div className="dashboard-tx-detail-grid">{tx.details.map(([label, value]) => <div className="tx-detail-chip" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><div className="dashboard-tx-detail-footer"><small>This is a quick summary. Open Transactions for the full timeline, support evidence, provider trace and downloadable records.</small><button type="button" className="ghost-btn small" onClick={onViewAll}>Open full timeline →</button></div></div>}</div>;
  })}</div><div className="button-row dashboard-start-btn"><button className="secondary-btn" onClick={onStart}>⊕ Sell crypto</button><button className="secondary-btn" onClick={onBuy}>↙ Buy crypto</button></div></>}</article>;
}

function TwoFactorRecommendationCard({ completedCount, onEnable, onDismiss }: { completedCount: number; onEnable: () => void; onDismiss: () => void }) {
  const active = completedCount > 0;
  return <article className={`security-card two-factor-recommendation ${active ? 'after-activity' : ''}`}><div className="security-icon">⚿</div><div><p className="eyebrow">Security recommendation</p><h3>{active ? 'Secure your account before your next payment' : 'Protect your Sivan account'}</h3><p>{active ? 'You’ve completed your first Sivan transaction. Add authenticator 2FA to protect future transfers and payouts.' : 'Enable authenticator 2FA to secure transfers and payouts. You can skip this for now.'}</p><div className="recommendation-actions"><button className="primary-btn small" onClick={onEnable}>Enable 2FA</button><button className="ghost-btn small" onClick={onDismiss}>{active ? 'Not now' : 'Maybe later'}</button></div></div></article>;
}

function DashboardSetupPanel({ setupPercent, hasUser, isVerified, hasBank, user, onContinue }: { setupPercent: number; hasUser: boolean; isVerified: boolean; hasBank: boolean; user: UserRecord | null; onContinue: () => void }) {
  const whatsappLinked = Boolean(user?.whatsappNumber || user?.whatsappVerifiedAt);
  const buttonLabel = !isVerified ? 'Start verification →' : !hasBank ? 'Add payout bank →' : 'Manage payment methods →';
  return <article className="dashboard-setup-panel"><div className="panel-head"><div><p className="eyebrow">Setup</p><h3>Account setup</h3></div><strong className="setup-percent-pill">{setupPercent}%</strong></div><div className="setup-list"><SetupLine done={hasUser} title="Email confirmed" sub={user?.email ? 'Signed in securely' : 'Create account'} /><SetupLine done={whatsappLinked} optional title="WhatsApp linked" sub="Optional for escrow and alerts" /><SetupLine done={isVerified} title="Identity verified" sub={isVerified ? 'Ready' : '~3 minutes'} /><SetupLine done={hasBank} title="Payout bank" sub={hasBank ? 'Bank added' : 'Add a bank to sell crypto'} /></div><div className="setup-progress"><div><span style={{ width: `${setupPercent}%` }} /></div><strong>{setupPercent}%</strong></div><button className="primary-btn" onClick={onContinue}>{buttonLabel}</button></article>;
}

function SetupLine({ done, title, sub, optional = false }: { done: boolean; title: string; sub: string; optional?: boolean }) {
  return <div className={`setup-line ${done ? 'done' : ''} ${optional ? 'optional' : ''}`}><span>{done ? '✓' : optional ? '•' : '○'}</span><div><strong>{title}</strong><small>{sub}</small></div></div>;
}

function SecurityReminder({ onSettings }: { onSettings: () => void }) {
  return <article className="security-card"><div className="security-icon">◈</div><div><h3>Security reminder</h3><p>Enable two-factor authentication and never share your seed phrase. Sivan will never ask for wallet private keys or 2FA codes outside the dashboard.</p><button onClick={onSettings}>Security settings →</button></div></article>;
}


function LandingPage({ isLiveEnv, appEnv, hasUser, assets, networks, payoutCurrencies, feePercent, onGetStarted, onDashboard, onBuy }: { isLiveEnv: boolean; appEnv: string; hasUser: boolean; assets: string; networks: string; payoutCurrencies: string; feePercent: string; onGetStarted: () => void; onDashboard: () => void; onBuy: () => void }) {
  const [quoteMode, setQuoteMode] = useState<'sell' | 'buy'>('sell');
  const [quoteAmount, setQuoteAmount] = useState('1000');
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const numericFee = Number(feePercent || '1.25');
  const quoteValue = Math.max(0, Number(quoteAmount.replace(/,/g, '')) || 0);
  const feeAmount = Number.isFinite(numericFee) ? (quoteValue * numericFee / 100) : 0;
  const receiveAmount = Math.max(0, quoteValue - feeAmount);
  const formattedReceiveAmount = receiveAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const updateQuoteAmount = (value: string) => setQuoteAmount(value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'));
  const faqItems = [
    { q: 'Do I need to complete KYC to use Sivan?', a: 'Yes. Verification is required before bank withdrawals or on-ramp actions. This protects users, reduces fraud, and keeps Sivan aligned with provider-supported payment rails.' },
    { q: 'Which countries and payment methods are supported?', a: `The current off-ramp supports enabled payout rails such as ${payoutCurrencies}. Available options are controlled by Sivan in Admin Controls. NGN is planned as a coming-soon rail as partnerships are finalized.` },
    { q: 'How long does a transaction take?', a: 'After your crypto deposit is confirmed on the selected network, provider processing and bank payout timing can vary by rail and bank. The app tracks status as the provider sends updates.' },
    { q: 'What are the fees?', a: `The current Sivan off-ramp fee shown from the live fee configuration is ${feePercent}%. Fees are shown before users receive a deposit address, and admin-controlled pricing can be updated operationally.` },
    { q: 'What happens if I send the wrong token or wrong network?', a: 'Only send the selected token on the selected network shown on the deposit screen. Sending any other token, or using the wrong network, can permanently lose funds and may not be recoverable.' },
    { q: 'Does Sivan hold my funds?', a: 'Sivan coordinates provider-backed payment flows and status tracking. Deposit addresses and settlement are handled through supported payment providers; Sivan does not ask for wallet private keys.' },
    { q: 'Is on-ramp supported?', a: 'The on-ramp product area is being prepared. Live buy actions should only be enabled after backend/provider rails, webhooks, controls, and reconciliation are fully tested.' }
  ];
  return (
    <div className="landing-shell premium-landing">
      <header className="landing-nav premium-nav">
        <a className="landing-brand" href="https://www.sivantech.online/" aria-label="Sivan home">
          <img src="/asset/sivan-logo.png" alt="Sivan" /><strong>Sivan</strong>
        </a>
        <nav>
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#start">Start</a>
          <a href="#faq">FAQ</a>
          <a href="#business">Business</a>
          <button className="ghost-btn" onClick={onDashboard}>Sign in</button>
          <button className="primary-btn" onClick={onGetStarted}>{hasUser ? 'Continue' : 'Get started'}</button>
        </nav>
      </header>

      <main>
        <section className="landing-hero premium-hero">
          <div className="landing-copy">
            <p className="eyebrow">Crypto to fiat. Fiat to crypto.</p>
            <h1>Buy and sell crypto<br /><span>the simple way.</span></h1>
            <p className="lead">Convert supported stablecoins on Avalanche C-Chain directly to your bank account or prepare to buy crypto with a transfer. One verification, transparent fees, and clear payout tracking.</p>
            <div className="landing-actions">
              <button className="primary-btn" onClick={onGetStarted}>Get started →</button>
              <a className="secondary-btn" href="#how">See how it works</a>
            </div>
            <div className="landing-trust"><span>✓ Licensed partners</span><span>✓ Non-custodial</span><span>✓ 1–2 day payouts</span></div>
          </div>
          <div className="quote-widget">
            <div className="widget-tabs"><button className={quoteMode === 'sell' ? 'active' : ''} onClick={() => setQuoteMode('sell')}>Sell</button><button className={quoteMode === 'buy' ? 'active' : ''} onClick={() => setQuoteMode('buy')}>Buy</button></div>
            <QuoteBox label={quoteMode === 'sell' ? 'You send' : 'You pay'} amount={quoteAmount} asset={quoteMode === 'sell' ? 'USDC' : 'USD'} helper={quoteMode === 'sell' ? '1 USDC ≈ $1.00' : 'Bank transfer'} editable onAmountChange={updateQuoteAmount} />
            <div className="quote-swap">↕</div>
            <QuoteBox label={quoteMode === 'sell' ? 'You receive' : 'You get'} amount={formattedReceiveAmount} asset={quoteMode === 'sell' ? 'USD · ACH' : 'USDC'} helper={quoteMode === 'sell' ? 'After Sivan fee' : 'After Sivan fee'} />
            <div className="quote-fees">
              <div><span>Rate</span><strong>1 USDC ≈ $1.00</strong></div>
              <div><span>Sivan fee ({feePercent}%)</span><strong className="danger">−${feeAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></div>
              <div><span>Arrival</span><strong>Provider + bank rail timing</strong></div>
            </div>
            <button className="primary-btn quote-btn" onClick={quoteMode === 'sell' ? onGetStarted : onBuy}>{quoteMode === 'sell' ? 'Get deposit address' : 'Preview buy flow'}</button>
            <small>Fee is pulled from the live Sivan fee configuration.</small>
          </div>
        </section>

        <section className="landing-strip" id="rails">
          <span>{assets}{assets.toLowerCase().includes('usdt') ? '' : ' · USDT ready when enabled'}</span>
          <span>{payoutCurrencies}</span>
          <span>{networks}</span>
          <span>NGN coming soon</span>
        </section>

        <section className="landing-section two-directions" id="features">
          <div className="section-head center"><p className="eyebrow center">Two directions</p><h2>Move value in either direction.</h2><p>One platform. One verification. Sell crypto to your bank or prepare to buy crypto with fiat — the same simple experience.</p></div>
          <div className="direction-grid">
            <article className="direction-card sell"><span className="chip-pill">↗ Sell</span><h3>Crypto to your bank account.</h3><p>Send stablecoins from any wallet. We convert and pay out through enabled provider-supported bank rails.</p><ul><li>✓ Launching first on Avalanche C-Chain</li><li>✓ Works with USDC and USDT when enabled</li><li>✓ Payouts in {payoutCurrencies}; NGN coming soon</li><li>✓ Unique deposit address per withdrawal</li><li>✓ Track confirmations and payout status</li></ul><div><strong>From {feePercent}%</strong><button className="primary-btn" onClick={onGetStarted}>Start selling →</button></div></article>
            <article className="direction-card buy"><span className="chip-pill purple">↙ Buy</span><em>Rollout ready</em><h3>Buy crypto directly with fiat.</h3><p>Pay by supported bank rails and receive stablecoins in a wallet you control once on-ramp backend rails are live.</p><ul><li>✓ Bank transfer flow planned</li><li>✓ Delivered after payment clears</li><li>✓ Self-custody wallet destination</li><li>✓ Same verification covers both directions</li></ul><div><strong>Provider rollout</strong><button className="secondary-btn" onClick={onBuy}>Start buying →</button></div></article>
          </div>
        </section>

        <section className="landing-section" id="how">
          <div className="section-head center"><p className="eyebrow center">How it works</p><h2>Three steps from crypto to cash.</h2><p>Whether you're buying or selling, the flow is guided end to end — no order books, no trading interface, no jargon.</p></div>
          <div className="steps-grid-premium">
            <StepCard n="01" icon="♢" title="Create and verify your account" body="Sign up with your email and complete a short identity check. Your verification unlocks supported payment flows." />
            <StepCard n="02" icon="▭" title="Choose rails and send funds" body="Pick your bank, asset, and network. Review the fee and safety warning before a deposit address is created." />
            <StepCard n="03" icon="◷" title="Receive your payout" body="Stablecoin deposits are detected by the provider, converted, and paid out to your selected bank account." />
          </div>
        </section>

        <section className="landing-section" id="business">
          <div className="section-head center"><p className="eyebrow center">Why Sivan</p><h2>Built for people who just want it to work.</h2><p>We've stripped out the complexity and built a regulated-grade ramp experience with everyday users in mind.</p></div>
          <div className="feature-grid-premium">
            <FeatureCard icon="⚡" title="Fast payouts" body="Create a deposit address quickly and track payout status as provider updates arrive." />
            <FeatureCard icon="🔒" title="Non-custodial by design" body="Provider-backed settlement flows handle deposits and payouts. Sivan never asks for private keys." />
            <FeatureCard icon="🌍" title="Global, multi-currency" body={`Cash out to ${payoutCurrencies}. NGN is coming soon as local partnerships progress.`} />
            <FeatureCard icon="▥" title="Transparent pricing" body={`The live Sivan fee is ${feePercent}%. It is displayed before users receive a deposit address.`} />
            <FeatureCard icon="🛡" title="Built-in compliance" body="Verification, sanctions screening, anti-fraud checks, and provider requirements are built into the guided flow." />
            <FeatureCard icon="☷" title="Clear transaction tracking" body="Users can follow address creation, deposit detection, conversion, payout processing, and completion." />
          </div>
        </section>

        <section className="landing-section faq-section" id="faq">
          <div className="section-head center"><p className="eyebrow center">Frequently asked</p><h2>Questions, answered.</h2></div>
          <div className="faq-list">{faqItems.map((item, index) => <div className={`faq-item ${openFaq === index ? 'open' : ''}`} key={item.q}><button onClick={() => setOpenFaq(openFaq === index ? null : index)}><strong>{item.q}</strong><span>⌄</span></button>{openFaq === index && <p>{item.a}</p>}</div>)}</div>
        </section>

        <section className="landing-section final-cta-section" id="start">
          <div className="final-cta-card"><p className="eyebrow center">Get started</p><h2>Your first transaction in about five minutes.</h2><p>Move between crypto and your bank with a few taps. No exchange account, no order books, no hassle.</p><button className="primary-btn" onClick={onGetStarted}>Create free account →</button><small>Already have an account? <button onClick={onDashboard}>Sign in</button></small></div>
        </section>
      </main>

      <LandingFooter onDashboard={onDashboard} onGetStarted={onGetStarted} onBuy={onBuy} />
    </div>
  );
}

function QuoteBox({ label, amount, asset, helper, editable = false, onAmountChange }: { label: string; amount: string; asset: string; helper: string; editable?: boolean; onAmountChange?: (value: string) => void }) {
  return <div className="quote-box"><div><small>{label}</small>{editable ? <input className="quote-amount-input" value={amount} inputMode="decimal" onChange={(event) => onAmountChange?.(event.target.value)} /> : <strong>{amount}</strong>}</div><div><span>{asset}</span><small>{helper}</small></div></div>;
}

function StepCard({ n, icon, title, body }: { n: string; icon: string; title: string; body: string }) {
  return <article className="step-card-premium"><i>{icon}</i><b>{n}</b><h3>{title}</h3><p>{body}</p></article>;
}

function FeatureCard({ icon, title, body }: { icon: string; title: string; body: string }) {
  return <article className="feature-card-premium"><i>{icon}</i><h3>{title}</h3><p>{body}</p></article>;
}

function LandingFooter({ onDashboard, onGetStarted, onBuy }: { onDashboard: () => void; onGetStarted: () => void; onBuy: () => void }) {
  return (
    <footer className="landing-footer">
      <div className="footer-grid">
        <div className="footer-brand-col">
          <div className="footer-brand"><img src="/asset/sivan-logo.png" alt="Sivan" /><strong>Sivan</strong></div>
          <p>Stablecoin-to-bank payment rails for verified users. Sivan helps users move supported stablecoins into bank payouts through provider-backed settlement flows.</p>
          <div className="footer-badges"><span>Avalanche C-Chain first</span><span>USDC / USDT ready</span><span>USD · GBP · EUR</span><span>NGN coming soon</span></div>
        </div>
        <FooterCol title="Product" links={[{ label: 'Sell crypto', action: onGetStarted }, { label: 'Buy crypto', action: onBuy }, { label: 'Open dashboard', action: onDashboard }, { label: 'Supported rails', href: '#rails' }]} />
        <FooterCol title="Business" links={[{ label: 'Payment operations', href: '#business' }, { label: 'On-ramp rollout', action: onBuy }, { label: 'Talk to support', href: 'mailto:support@sivantech.online' }]} />
        <FooterCol title="Resources" links={[{ label: 'How it works', href: '#how' }, { label: 'FAQ', href: '#faq' }, { label: 'Safety', href: '#safety' }, { label: 'Sivan website', href: 'https://www.sivantech.online/' }]} />
        <FooterCol title="Company" links={[{ label: 'Pilot access', href: 'https://waitlist.sivantech.online/' }, { label: 'Terms of Service', href: legalLinks.terms }, { label: 'Privacy Policy', href: legalLinks.privacy }, { label: 'Risk Disclosure', href: legalLinks.risk }, { label: 'Data Retention', href: legalLinks.dataRetention }, { label: 'AML/KYC', href: legalLinks.amlKyc }, { label: 'Jurisdictions', href: legalLinks.jurisdictions }, { label: 'Wrong Network Policy', href: legalLinks.wrongNetwork }, { label: 'Complaints', href: legalLinks.complaints }, { label: 'Cookies', href: legalLinks.cookies }]} />
      </div>
      <div className="footer-bottom">
        <p>© 2026 Sivan Technologies. All rights reserved. Cryptoassets and stablecoins are volatile and may not be protected by financial compensation schemes. Services depend on licensed/provider-supported payment rails and may be unavailable in some jurisdictions. Sivan does not ask for wallet private keys.</p>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: Array<{ label: string; href?: string; action?: () => void }> }) {
  return <div className="footer-col"><h4>{title}</h4>{links.map((link) => link.action ? <button key={link.label} onClick={link.action}>{link.label}</button> : <a key={link.label} href={link.href} target={link.href?.startsWith('http') ? '_blank' : undefined} rel={link.href?.startsWith('http') ? 'noreferrer' : undefined}>{link.label}</a>)}</div>;
}

function InfoCard({ n, title, body }: { n: string; title: string; body: string }) {
  return <article className="landing-info-card"><span>{n}</span><h3>{title}</h3><p>{body}</p></article>;
}

function RailsCard({ enabledControls, enabledAssets, enabledNetworks }: { enabledControls: PaymentControl[]; enabledAssets: AssetControl[]; enabledNetworks: NetworkControl[] }) {
  return (
    <article className="panel rails-card">
      <div className="panel-head"><div><p className="eyebrow">Available rails</p><h3>Configured by Sivan Controls</h3></div></div>
      <div className="rail-chips">{enabledControls.length ? enabledControls.map((control) => <span key={control.currency}>{control.currency.toUpperCase()}</span>) : <span>No payout rails</span>}</div>
      <div className="rail-chips muted-chips">{enabledAssets.length ? enabledAssets.map((asset) => <span key={asset.asset}>{asset.label}</span>) : <span>No assets</span>}<span>{enabledNetworks.length} networks</span><span>NGN coming soon</span></div>
      <p className="muted">Only enabled assets, networks, and payout currencies appear in the withdrawal flow.</p>
    </article>
  );
}

function OnRampView({ hasUser, isVerified, onGetStarted }: { hasUser: boolean; isVerified: boolean; onGetStarted: () => void }) {
  return (
    <section className="panel-grid two onramp-view">
      <article className="panel form-panel onramp-hero-card">
        <p className="eyebrow">Buy stablecoins</p>
        <h3>On-ramp experience prepared for rollout</h3>
        <p className="muted">Sivan can support the buy-side product experience, but live on-ramp actions should remain gated until the backend/provider rails are implemented and tested end to end.</p>
        <div className="details-box">
          <Kv label="Current access" value={hasUser ? isVerified ? 'Account ready' : 'Verification required' : 'Create account first'} />
          <Kv label="Planned assets" value="USDC / USDT" />
          <Kv label="Status" value="Provider rollout pending" />
          <Kv label="NGN" value="Coming soon" />
        </div>
        <button className="primary-btn" onClick={onGetStarted}>{hasUser ? isVerified ? 'Manage bank accounts' : 'Verify account' : 'Get started'}</button>
      </article>
      <article className="panel">
        <div className="panel-head"><div><p className="eyebrow">Future flow</p><h3>Fiat to stablecoin</h3></div></div>
        <div className="onramp-steps">
          <ProgressItem done={hasUser} label="Create or sign in" />
          <ProgressItem done={isVerified} label="Complete verification" />
          <ProgressItem done={false} label="Choose fiat payment method" />
          <ProgressItem done={false} label="Receive stablecoins to your wallet" />
        </div>
        <div className="verification-note">This screen is intentionally not creating live buy orders yet. We will wire it to real on-ramp APIs once those backend rails are ready.</div>
      </article>
    </section>
  );
}


type WithdrawalReviewState = { userId: string; externalAccountId: string; sourceCurrency: string; sourceChain: string; destinationCurrency: string; returnAddress?: string; bankLabel: string; assetLabel: string; networkLabel: string };

function OffRampWizard({ accounts, enabledControls, enabledAssets, enabledNetworks, primaryAccount, withdrawalReview, depositResult, feePercent, loading, canCreatePaymentActions, onSubmit, onCancelReview, onConfirm }: {
  accounts: ExternalAccountRecord[];
  enabledControls: PaymentControl[];
  enabledAssets: AssetControl[];
  enabledNetworks: NetworkControl[];
  primaryAccount?: ExternalAccountRecord;
  withdrawalReview: WithdrawalReviewState | null;
  depositResult: DepositResponse | null;
  feePercent?: string;
  loading: boolean;
  canCreatePaymentActions: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancelReview: () => void;
  onConfirm: () => void;
}) {
  const hasEnabledBank = accounts.some((account) => enabledControls.some((control) => control.currency === account.currency));
  const step = depositResult ? 3 : withdrawalReview ? 2 : 1;
  return (
    <section className="offramp-wizard">
      <div className="trade-head">
        <div>
          <p className="eyebrow">Sell stablecoins</p>
          <h3>Withdraw to your bank</h3>
          <p className="muted">Choose a verified bank account, asset, and network. Review carefully before a deposit address is created.</p>
        </div>
        <div className="wizard-stepper">
          <StepDot active={step === 1} done={step > 1} label="Details" />
          <StepDot active={step === 2} done={step > 2} label="Review" />
          <StepDot active={step === 3} done={false} label="Deposit" />
        </div>
      </div>
      <div className="trade-grid">
        <div>
          {step === 1 && <WithdrawalDetailsForm accounts={accounts} enabledControls={enabledControls} enabledAssets={enabledAssets} enabledNetworks={enabledNetworks} primaryAccount={primaryAccount} hasEnabledBank={hasEnabledBank} loading={loading} canCreatePaymentActions={canCreatePaymentActions} onSubmit={onSubmit} />}
          {step === 2 && <WithdrawalReviewCard review={withdrawalReview} feePercent={feePercent} loading={loading} onCancel={onCancelReview} onConfirm={onConfirm} />}
          {step === 3 && <DepositCard result={depositResult} />}
        </div>
        <OffRampSidePanel step={step} enabledAssets={enabledAssets} enabledNetworks={enabledNetworks} />
      </div>
    </section>
  );
}

function StepDot({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return <div className={`step-node ${active ? 'active' : ''} ${done ? 'done' : ''}`}><span>{done ? '✓' : active ? '•' : ''}</span>{label}</div>;
}

function WithdrawalDetailsForm({ accounts, enabledControls, enabledAssets, enabledNetworks, primaryAccount, hasEnabledBank, loading, canCreatePaymentActions, onSubmit }: {
  accounts: ExternalAccountRecord[];
  enabledControls: PaymentControl[];
  enabledAssets: AssetControl[];
  enabledNetworks: NetworkControl[];
  primaryAccount?: ExternalAccountRecord;
  hasEnabledBank: boolean;
  loading: boolean;
  canCreatePaymentActions: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  if (!hasEnabledBank) return <article className="panel form-panel trade-card"><p className="eyebrow">Step 1</p><h3>Add a bank first</h3><Empty>Add an enabled bank account before creating a withdrawal.</Empty></article>;
  if (!enabledAssets.length || !enabledNetworks.length) return <article className="panel form-panel trade-card"><p className="eyebrow">Step 1</p><h3>Deposits unavailable</h3><Empty>Deposits are temporarily unavailable.</Empty></article>;
  return (
    <article className="panel form-panel trade-card">
      <p className="eyebrow">Step 1</p>
      <h3>Choose payout and deposit rail</h3>
      <p className="muted">Your deposit address will be tied to this bank account, token, and network.</p>
      <form className="form premium-form" onSubmit={onSubmit}>
        <label>Bank payout
          <select name="externalAccountId" defaultValue={primaryAccount?.id}>{accounts.filter((account) => enabledControls.some((control) => control.currency === account.currency)).map((account) => <option key={account.id} value={account.id}>{account.bankName || 'Bank account'} · {account.currency.toUpperCase()} · ****{account.accountLast4 || '----'}</option>)}</select>
        </label>
        <div className="split">
          <label>Deposit asset<select name="sourceCurrency" defaultValue={enabledAssets[0]?.asset || 'usdc'}>{enabledAssets.map((asset) => <option key={asset.asset} value={asset.asset}>{asset.label}</option>)}</select></label>
          <label>Deposit network<select name="sourceChain" defaultValue={enabledNetworks[0]?.network || 'base'}>{enabledNetworks.map((network) => <option key={network.network} value={network.network}>{network.label}</option>)}</select></label>
        </div>
        <label>Refund wallet address<input name="returnAddress" placeholder="Wallet address for returned funds" defaultValue="0x0000000000000000000000000000000000000000" /></label>
        <div className="warning-box compact">You will review these details before a deposit address is created. Send only the selected token on the selected network.</div>
        <button className="primary-btn" disabled={loading || !canCreatePaymentActions}>{loading ? 'Preparing review...' : canCreatePaymentActions ? 'Review withdrawal' : 'Withdrawals paused'}</button>
      </form>
    </article>
  );
}

function OffRampSidePanel({ step, enabledAssets, enabledNetworks }: { step: number; enabledAssets: AssetControl[]; enabledNetworks: NetworkControl[] }) {
  return (
    <aside className="side-info-stack">
      <article className="panel">
        <p className="eyebrow">How this works</p>
        <h3>Provider-backed deposit address</h3>
        <ol className="ordered-steps">
          <li className={step >= 1 ? 'active' : ''}>Choose your bank, token, and network.</li>
          <li className={step >= 2 ? 'active' : ''}>Review the details and safety warning.</li>
          <li className={step >= 3 ? 'active' : ''}>Send the selected asset to the generated address.</li>
          <li>Track deposit detection, conversion, and bank payout.</li>
        </ol>
      </article>
      <article className="panel control-summary-card">
        <p className="eyebrow">Available now</p>
        <div className="rail-chips">{enabledAssets.map((asset) => <span key={asset.asset}>{asset.label}</span>)}</div>
        <div className="rail-chips muted-chips">{enabledNetworks.slice(0, 5).map((network) => <span key={network.network}>{network.label}</span>)}</div>
        <p className="muted">USDT support is controlled from Admin. Users only see enabled assets and networks.</p>
      </article>
    </aside>
  );
}


function OtpInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const digits = Array.from({ length: 6 }, (_, index) => value[index] || '');

  function setDigit(index: number, next: string) {
    const clean = next.replace(/\D/g, '').slice(-1);
    const values = digits.slice();
    values[index] = clean;
    const joined = values.join('').slice(0, 6);
    onChange(joined);
    if (clean && index < 5) {
      const nextInput = document.querySelector<HTMLInputElement>(`[data-otp-index="${index + 1}"]`);
      nextInput?.focus();
    }
  }

  return (
    <label>Verification code
      <div className="otp-row" onPaste={(event) => {
        event.preventDefault();
        const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
        onChange(pasted);
      }}>
        {digits.map((digit, index) => (
          <input
            key={index}
            data-otp-index={index}
            inputMode="numeric"
            maxLength={1}
            value={digit}
            onChange={(event) => setDigit(index, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Backspace' && !digit && index > 0) {
                document.querySelector<HTMLInputElement>(`[data-otp-index="${index - 1}"]`)?.focus();
              }
            }}
            aria-label={`Verification code digit ${index + 1}`}
          />
        ))}
      </div>
      <input type="hidden" name="code" value={value} />
    </label>
  );
}

function WithdrawalReviewCard({ review, feePercent, loading, onCancel, onConfirm }: { review: null | { bankLabel: string; assetLabel: string; networkLabel: string; destinationCurrency: string }; feePercent?: string; loading: boolean; onCancel: () => void; onConfirm: () => void }) {
  if (!review) return null;
  return (
    <article className="deposit-card review-card">
      <p className="eyebrow">Review withdrawal</p>
      <h3>Confirm before creating your deposit address</h3>
      <p className="muted">Check these details carefully. Your deposit address will be tied to the selected asset, network, and bank payout.</p>
      <div className="details-box">
        <Kv label="Asset" value={review.assetLabel} />
        <Kv label="Network" value={review.networkLabel} />
        <Kv label="Bank payout" value={review.bankLabel} />
        <Kv label="Payout currency" value={review.destinationCurrency.toUpperCase()} />
        <Kv label="Sivan fee" value={feePercent ? `${feePercent}%` : '—'} />
      </div>
      <div className="warning-box">Send only {review.assetLabel} on {review.networkLabel}. Sending any other token, or using the wrong network, can permanently lose your funds and may not be recoverable. <a href={legalLinks.risk} target="_blank" rel="noreferrer">Read Risk Disclosure</a>.</div>
      <div className="split-actions">
        <button className="ghost-btn" onClick={onCancel}>Edit details</button>
        <button className="primary-btn" disabled={loading} onClick={onConfirm}>{loading ? 'Creating...' : 'Create deposit address'}</button>
      </div>
    </article>
  );
}


function SetupChecklist({ hasUser, isVerified, hasBank, onContinue, nextStepLabel }: { hasUser: boolean; isVerified: boolean; hasBank: boolean; onContinue: () => void; nextStepLabel: string }) {
  return <article className="panel setup-card"><div className="panel-head"><div><p className="eyebrow">Setup checklist</p><h3>{[hasUser, isVerified, hasBank].filter(Boolean).length}/3 complete</h3></div></div><div className="checklist"><ProgressItem done={hasUser} label="Account created" /><ProgressItem done={isVerified} label="Identity verified" /><ProgressItem done={hasBank} label="Bank account added" /></div><button className="primary-btn animated-cta" onClick={onContinue}>{nextStepLabel}</button></article>;
}

function QuickActionCard({ hasUser, isVerified, hasBank, onContinue }: { hasUser: boolean; isVerified: boolean; hasBank: boolean; onContinue: () => void }) {
  const title = !hasUser ? 'Start with passwordless access' : !isVerified ? 'Verify once to unlock withdrawals' : !hasBank ? 'Add a bank account you own' : 'Create a stablecoin withdrawal';
  const body = !hasUser ? 'Use your email to create or access your Sivan account. No password required.' : !isVerified ? 'Verification protects your account and is required before bank payouts.' : !hasBank ? 'Your payout must go to a verified bank account in your name.' : 'Choose the asset, network, and bank account before creating a deposit address.';
  return <article className="panel quick-card"><div><p className="eyebrow">Quick action</p><h3>{title}</h3><p className="muted">{body}</p></div><button className="primary-btn" onClick={onContinue}>Continue</button></article>;
}

function NeedHelpCard() {
  return <article className="panel help-card"><p className="eyebrow">Need help?</p><h3>Support for withdrawals</h3><p className="muted">If you are unsure which asset or network to use, contact support before sending funds.</p><a className="secondary-btn support-link" href="mailto:support@sivantech.online">Contact support</a></article>;
}


function DashboardAccountNotice({ onVerify }: { onVerify: () => void }) {
  return <article className="kyc-outcome-notice action dashboard-account-notice">
    <span className="kyc-outcome-icon">◈</span>
    <div className="kyc-outcome-copy"><p className="eyebrow">Account status</p><h3>Verify your account</h3><p>Complete identity verification to unlock payments.</p></div>
    <div className="kyc-outcome-actions"><button className="primary-btn" onClick={onVerify}>Start verification</button></div>
  </article>;
}

function KycOutcomeNotice({ customer, hasBank, onContinue, onSupport, onRefresh, readyPrimaryLabel = 'Transfer & pay' }: { customer: CustomerRecord; hasBank: boolean; onContinue: () => void; onSupport: () => void; onRefresh: () => void; readyPrimaryLabel?: string }) {
  const status = customer.kycStatus;
  const kind = kycNoticeKind(status);
  const verificationLink = customer.hostedKycLink || customer.kycLink;
  const isApproved = status === 'kyc_approved';
  const isReview = status === 'kyc_under_review';
  const isFailed = ['kyc_rejected', 'failed', 'cancelled'].includes(status || '');
  const isIncomplete = status === 'kyc_incomplete';
  const copy = isApproved
    ? { icon: '✓', title: customer.customerAction?.title || (hasBank ? 'Account ready' : 'Verification complete'), body: customer.customerAction?.message || (hasBank ? 'You can buy, sell, transfer, and manage payment methods.' : 'You’re verified. Add a payout bank to start selling crypto or receiving bank payouts.'), primary: hasBank ? readyPrimaryLabel : 'Add bank account' }
    : isReview
      ? { icon: '⏳', title: customer.customerAction?.title || 'Verification under review', body: customer.customerAction?.message || 'Your verification has been submitted and is being reviewed by our provider. We will update this page automatically.', primary: 'Refresh status' }
      : isFailed
        ? { icon: '!', title: customer.customerAction?.title || 'Verification could not be completed', body: customer.customerAction?.message || 'Your secure verification was not approved. This can happen if a document is unclear or details do not match. You can retry or contact support.', primary: verificationLink ? 'Try verification again' : 'Refresh status' }
        : isIncomplete
          ? { icon: '🔔', title: customer.customerAction?.title || 'Verification needs one more step', body: customer.customerAction?.message || 'Your secure verification is not fully complete yet. Continue the Bridge verification flow to finish your identity check.', primary: verificationLink ? 'Continue verification' : 'Refresh status' }
          : { icon: '◈', title: customer.customerAction?.title || 'Verify your account', body: customer.customerAction?.message || 'Complete identity verification to unlock payments.', primary: 'Start verification' };
  const primaryAction = isApproved || (!isReview && !isIncomplete && !isFailed) ? onContinue : onRefresh;
  return <article className={`kyc-outcome-notice ${kind}`}>
    <span className="kyc-outcome-icon">{copy.icon}</span>
    <div className="kyc-outcome-copy"><p className="eyebrow">Verification status</p><h3>{copy.title}</h3><p>{copy.body}</p>{Boolean(customer.customerAction?.requirements?.length) && <small>Needed: {customer.customerAction?.requirements?.join(', ')}</small>}</div>
    <div className="kyc-outcome-actions">
      {(isIncomplete || isFailed) && verificationLink ? <a className="primary-btn small" href={verificationLink} target="_blank" rel="noreferrer">{copy.primary}</a> : <button className="primary-btn small" onClick={primaryAction}>{copy.primary}</button>}
      {!isApproved && <button className="secondary-btn small" onClick={onSupport}>Contact support</button>}
    </div>
  </article>;
}


function VerificationPage({ hasUser, customer, customerTypes, kycFailed, canSubmitKyc, kycActionLabel, verificationRedirectUri, onSubmit, onRefresh, onSupport, onAddBank, onSell, hasBank }: { hasUser: boolean; customer: CustomerRecord | null; customerTypes: Array<{ customerType: 'individual' | 'business'; enabled: boolean; label: string }>; kycFailed: boolean; canSubmitKyc: boolean; kycActionLabel: string; verificationRedirectUri: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onRefresh: () => void; onSupport: () => void; onAddBank: () => void; onSell: () => void; hasBank: boolean }) {
  const emailDone = hasUser;
  const identityDone = customer?.kycStatus === 'kyc_approved';
  const verificationLink = customer?.hostedKycLink || customer?.kycLink;
  const canOpenExistingVerification = Boolean(verificationLink && customer?.id && !identityDone && !kycFailed);
  const started = Boolean(customer?.id);
  const bankDone = hasBank;
  const steps = [emailDone, identityDone, customer?.tosStatus === 'approved', bankDone];
  const pct = Math.round((steps.filter(Boolean).length / steps.length) * 100);
  return (
    <section className="app-page verification-premium">
      <PageHero title="Verification" subtitle="A short, secure check so you can use Sivan payments with confidence." />
      {customer && <KycOutcomeNotice customer={customer} hasBank={hasBank} onContinue={customer.kycStatus === 'kyc_approved' ? (hasBank ? onSell : onAddBank) : onRefresh} onSupport={onSupport} onRefresh={onRefresh} readyPrimaryLabel="Sell crypto" />}
      <div className="verification-grid">
        <article className="dashboard-setup-panel verification-main-card">
          <div className="verification-progress-head"><div><p className="eyebrow">Progress</p><h3>{pct}% complete</h3></div><Badge status={identityDone ? 'verified' : 'pending'}>{identityDone ? 'Level 1 — Verified' : 'Level 0 — Starter'}</Badge></div>
          <div className="setup-progress big"><div><span style={{ width: `${pct}%` }} /></div></div>
          <div className="level-grid"><div className="active"><strong>Step 1</strong><span>Email confirmed</span></div><div className={identityDone ? 'active' : ''}><strong>Step 2</strong><span>Identity verified</span></div><div className={hasBank ? 'active' : ''}><strong>Step 3</strong><span>Payout ready</span></div></div>
          <div className="verification-steps-list">
            <VerificationStep done={emailDone} index={1} title="Email confirmed" sub="Signed in securely" action="Completed" />
            <div className={`verification-step ${identityDone ? 'done' : ''}`}><span>{identityDone ? '✓' : '2'}</span><div><strong>Identity verification</strong><small>Government-issued ID and selfie. Usually takes about 3 minutes.</small></div>{!hasUser ? <button className="primary-btn small" disabled>Create account</button> : canOpenExistingVerification ? <a className="primary-btn small" href={verificationLink} target="_blank" rel="noreferrer">{kycActionLabel}</a> : <form onSubmit={onSubmit} key={customer?.id || 'new-verification'}><select name="type" defaultValue={customer?.customerType || 'individual'} disabled={Boolean(customer?.id && !kycFailed)}>{customerTypes.map((type) => <option key={type.customerType} value={type.customerType} disabled={!type.enabled}>{type.label}{!type.enabled ? ' — unavailable' : ''}</option>)}</select><input name="redirectUri" type="hidden" value={verificationRedirectUri} /><button className="primary-btn small" disabled={!canSubmitKyc}>{kycActionLabel}</button></form>}</div>
            <VerificationStep done={customer?.tosStatus === 'approved'} index={3} title="Terms accepted" sub="Provider terms are accepted when required" action={customer?.tosStatus === 'approved' ? 'Completed' : started ? 'Continue' : 'Continue'} />
            <VerificationStep done={hasBank} index={4} title="Payout bank" sub="Add a bank when you are ready to sell crypto" action={hasBank ? 'Completed' : 'Continue'} />
          </div>
        </article>
        <div className="dashboard-side-stack">
          {customer && <article className="panel verification-status-card"><div className="panel-head"><div><p className="eyebrow">Current status</p><h3>Verification summary</h3></div><button className="ghost-btn small" onClick={onRefresh}>Refresh</button></div><CustomerDetails customer={customer} /></article>}
          <article className="panel verify-simple-card"><h3>Why we verify</h3><p className="muted">Verification keeps your account safe and helps Sivan meet payment partner requirements.</p><ul className="plain-list"><li>✓ Encrypted data</li><li>✓ Used only for compliance</li><li>✓ Status refreshes automatically</li></ul></article>
          <article className="security-card verify-help-card"><div className="security-icon">?</div><div><h3>Need help?</h3><p>If you are having trouble, support can review it with you.</p><button onClick={onSupport}>Contact support →</button><button onClick={onRefresh}>Refresh status →</button></div></article>
        </div>
      </div>
    </section>
  );
}

function VerificationStep({ done, index, title, sub, action }: { done: boolean; index: number; title: string; sub: string; action: string }) {
  return <div className={`verification-step ${done ? 'done' : ''}`}><span>{done ? '✓' : index}</span><div><strong>{title}</strong><small>{sub}</small></div><button className={`small ${done ? 'ghost-btn' : 'primary-btn'}`} disabled>{action}</button></div>;
}

function PaymentMethodsView({ accounts, onSubmit, loading, isVerified, controls, canCreatePaymentActions, isLiveEnv, onRefresh }: { accounts: ExternalAccountRecord[]; onSubmit: (event: FormEvent<HTMLFormElement>) => void; loading: boolean; isVerified: boolean; controls: PaymentControl[]; canCreatePaymentActions: boolean; isLiveEnv: boolean; onRefresh: () => void }) {
  return <section className="app-page payment-methods-premium"><PageHero title="Payment methods" subtitle="Manage payout banks you own for crypto-to-bank withdrawals." action={<button className="primary-btn small" onClick={onRefresh}>Refresh</button>} /><div className="payment-grid"><article className="dashboard-transactions payment-methods-card"><div className="dash-card-head"><h3>Verified bank accounts</h3></div><BankList accounts={accounts} /></article><BankForm onSubmit={onSubmit} loading={loading} isVerified={isVerified} controls={controls} canCreatePaymentActions={canCreatePaymentActions} isLiveEnv={isLiveEnv} /></div></section>;
}

function VirtualAccountsView({ requests, accounts, transactions, controls, loading, isVerified, canCreatePaymentActions, onRequest, onRefresh }: { requests: VirtualAccountRequestRecord[]; accounts: VirtualAccountRecord[]; transactions: VirtualAccountTransactionRecord[]; controls: VirtualAccountControl[]; loading: boolean; isVerified: boolean; canCreatePaymentActions: boolean; onRequest: (currency: 'usd' | 'gbp' | 'eur') => void; onRefresh: () => void }) {
  return <section className="app-page payment-methods-premium"><PageHero title="Virtual accounts" subtitle="Request reusable receiving accounts for fiat deposits into Sivan." action={<button className="primary-btn small" onClick={onRefresh}>Refresh</button>} /><VirtualAccountsCustomerPanel requests={requests} accounts={accounts} controls={controls} loading={loading} isVerified={isVerified} canCreatePaymentActions={canCreatePaymentActions} onRequest={onRequest} /><VirtualAccountDepositHistory transactions={transactions} /></section>;
}

const vaCurrencyMeta: Record<'usd' | 'gbp' | 'eur', { title: string; rails: string; account: string; flag: string }> = {
  usd: { title: 'USD Account', rails: 'ACH / Wire', account: 'US bank account', flag: '$' },
  gbp: { title: 'GBP Account', rails: 'Faster Payments', account: 'UK account number', flag: '£' },
  eur: { title: 'EUR Account', rails: 'SEPA', account: 'IBAN', flag: '€' }
};

function VirtualAccountsCustomerPanel({ requests, accounts, controls, loading, isVerified, canCreatePaymentActions, onRequest }: { requests: VirtualAccountRequestRecord[]; accounts: VirtualAccountRecord[]; controls: VirtualAccountControl[]; loading: boolean; isVerified: boolean; canCreatePaymentActions: boolean; onRequest: (currency: 'usd' | 'gbp' | 'eur') => void }) {
  const currencies: Array<'usd' | 'gbp' | 'eur'> = ['usd', 'gbp', 'eur'];
  const enabledControls = controls.filter((control) => control.enabled);
  return <article className="virtual-bank-panel"><div className="virtual-bank-head"><div><p className="eyebrow">Virtual Accounts</p><h3>Request virtual bank accounts</h3><p className="muted">After approval, Sivan shows customer-safe bank details only. Provider internals, destination wallets, and economics stay hidden.</p></div><Badge status={enabledControls.length ? 'active' : 'pending'}>{enabledControls.length ? `${enabledControls.length} enabled` : 'Disabled'}</Badge></div><div className="virtual-bank-grid">{currencies.map((currency) => <VirtualAccountCurrencyCard key={currency} currency={currency} request={requests.find((item) => item.currency === currency && !['rejected', 'canceled'].includes(item.status))} account={accounts.find((item) => item.currency === currency && item.status !== 'closed' && item.provider !== 'mock')} control={controls.find((item) => item.currency === currency)} loading={loading} isVerified={isVerified} canCreatePaymentActions={canCreatePaymentActions} onRequest={onRequest} />)}</div></article>;
}


function VirtualAccountDepositHistory({ transactions }: { transactions: VirtualAccountTransactionRecord[] }) {
  return <article className="virtual-bank-panel va-deposit-history"><div className="virtual-bank-head"><div><p className="eyebrow">Deposit history</p><h3>Virtual account deposits</h3><p className="muted">Fiat deposits and settlement events from Bridge virtual accounts. Completed deposits can credit your Sivan balance.</p></div><Badge status={transactions.length ? 'active' : 'pending'}>{transactions.length ? `${transactions.length} deposits` : 'No deposits'}</Badge></div>{!transactions.length ? <Empty>No virtual account deposits yet.</Empty> : <div className="table-wrap"><table className="table"><thead><tr><th>Deposit</th><th>Amount</th><th>Settled</th><th>Status</th><th>Rail</th><th>Date</th></tr></thead><tbody>{transactions.map((tx) => <tr key={tx.id}><td>{shortRef(tx.depositId)}</td><td>{tx.sourceAmount || '—'} {tx.sourceCurrency?.toUpperCase() || ''}</td><td>{tx.destinationAmount || '—'} {tx.destinationCurrency?.toUpperCase() || ''}</td><td><Badge status={tx.status}>{friendlyStatus(tx.status)}</Badge></td><td>{tx.paymentRail || '—'}</td><td>{new Date(tx.createdAt).toLocaleDateString()}</td></tr>)}</tbody></table></div>}</article>;
}

function virtualAccountInstructions(account?: VirtualAccountRecord) {
  const raw = account?.rawProviderPayload as any;
  const instructions = raw?.source_deposit_instructions ?? raw?.sourceDepositInstructions ?? raw?.source ?? {};
  return {
    bankName: instructions.bank_name || account?.bankName,
    accountName: instructions.bank_beneficiary_name || instructions.account_name || instructions.beneficiary_name || account?.accountName,
    accountNumber: instructions.bank_account_number || instructions.account_number || instructions.clabe || instructions.account?.account_number || account?.accountNumberMasked,
    routingNumber: instructions.bank_routing_number || instructions.routing_number || instructions.sort_code || account?.routingNumberMasked,
    iban: instructions.iban || instructions.iban_number || account?.ibanMasked,
    bic: instructions.bic,
    bankAddress: [instructions.bank_address, instructions.bank_city, instructions.bank_state, instructions.bank_country].filter(Boolean).join(', '),
    paymentRails: Array.isArray(instructions.payment_rails) ? instructions.payment_rails.join(', ') : undefined,
  };
}

function VirtualAccountCurrencyCard({ currency, request, account, control, loading, isVerified, canCreatePaymentActions, onRequest }: { currency: 'usd' | 'gbp' | 'eur'; request?: VirtualAccountRequestRecord; account?: VirtualAccountRecord; control?: VirtualAccountControl; loading: boolean; isVerified: boolean; canCreatePaymentActions: boolean; onRequest: (currency: 'usd' | 'gbp' | 'eur') => void }) {
  const [copied, setCopied] = useState(false);
  const meta = vaCurrencyMeta[currency];
  const enabled = Boolean(control?.enabled);
  const status = account?.status || request?.status || (enabled ? 'available' : 'disabled');
  const disabledReason = !enabled ? 'Not available yet' : !isVerified ? 'Complete verification first' : !canCreatePaymentActions ? 'Temporarily unavailable' : '';
  const instructions = virtualAccountInstructions(account);
  const detailRows = [
    ['Bank', instructions.bankName || 'Partner bank'],
    ['Account name', instructions.accountName || 'Sivan account'],
    ...(instructions.iban ? [['IBAN', instructions.iban], ...(instructions.bic ? [['BIC / SWIFT', instructions.bic]] : [])] : [['Account', instructions.accountNumber || 'Assigned'], ['Routing', instructions.routingNumber || meta.rails]]),
    ...(instructions.paymentRails ? [['Rails', instructions.paymentRails]] : []),
    ...(instructions.bankAddress ? [['Bank address', instructions.bankAddress]] : []),
    ['Status', friendlyStatus(account?.status)]
  ].filter(([, value]) => value && value !== '—') as string[][];
  const copyAll = async () => {
    if (!account) return;
    const text = [`${currency.toUpperCase()} virtual account`, ...detailRows.map(([label, value]) => `${label}: ${value}`)].join('\n');
    await navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };
  return <section className={`virtual-bank-card ${account ? 'active' : request ? 'pending' : ''}`}><div className="vb-card-top"><span>{meta.flag}</span><div><strong>{meta.title}</strong><small>{meta.rails} · {meta.account}</small></div></div><Badge status={status}>{friendlyStatus(status)}</Badge>{account ? <><div className="vb-details">{detailRows.map(([label, value]) => <Kv key={label} label={label} value={value} />)}</div><div className="vb-copy-actions"><button type="button" className="secondary-btn small" onClick={copyAll}>{copied ? 'Copied account details ✓' : 'Copy all account details'}</button><small>Copy bank, account, routing/IBAN, rails, and address in one tap.</small></div></> : request ? <div className="vb-pending"><strong>{request.status === 'requested' ? 'Request received' : friendlyStatus(request.status)}</strong><small>Submitted {new Date(request.createdAt).toLocaleString()}. Sivan operations will review and approve before account details appear here.</small>{request.rejectionReason && <small className="danger-text">{request.rejectionReason}</small>}</div> : <div className="vb-empty"><p>Request a reusable {currency.toUpperCase()} virtual account for fiat deposits.</p><button className="primary-btn small" disabled={loading || Boolean(disabledReason)} onClick={() => onRequest(currency)}>{disabledReason || `Request ${currency.toUpperCase()} account`}</button></div>}</section>;
}
type CustomerTransactionRow = {
  id: string;
  kind: 'withdrawal' | 'onramp_order';
  label: string;
  direction: 'sell' | 'buy';
  asset: string;
  amount: string;
  currency: string;
  status: string;
  createdAt: string;
  providerReference?: string;
  timeline?: TransactionTimeline;
  raw: WithdrawalRecord | OnrampOrderRecord;
};

function TransactionsView({ user, api, withdrawals, onrampOrders, onStart, onBuy }: { user: UserRecord | null; api: <T>(path: string, options?: RequestInit) => Promise<T>; withdrawals: WithdrawalRecord[]; onrampOrders: OnrampOrderRecord[]; onStart: () => void; onBuy: () => void }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'sell' | 'buy' | 'processing'>('all');
  const transactions = useMemo<CustomerTransactionRow[]>(() => {
    const sells = withdrawals.map((w): CustomerTransactionRow => ({
      id: w.id,
      kind: 'withdrawal',
      label: 'Sell crypto',
      direction: 'sell',
      asset: w.sourceCurrency?.toUpperCase() || 'USDC',
      amount: w.destinationAmount || w.sourceAmount || w.transactionTimeline?.amount || '—',
      currency: w.destinationCurrency?.toUpperCase() || w.transactionTimeline?.currency || '—',
      status: w.status,
      createdAt: w.createdAt,
      providerReference: w.transactionTimeline?.providerReference || w.providerDrainId || w.destinationReference,
      timeline: w.transactionTimeline || fallbackWithdrawalTimeline(w),
      raw: w
    }));
    const buys = onrampOrders.map((o): CustomerTransactionRow => ({
      id: o.id,
      kind: 'onramp_order',
      label: 'Buy crypto',
      direction: 'buy',
      asset: o.destinationCurrency?.toUpperCase() || 'USDC',
      amount: o.amount || o.transactionTimeline?.amount || '—',
      currency: o.sourceCurrency?.toUpperCase() || o.transactionTimeline?.currency || '—',
      status: o.status,
      createdAt: o.createdAt,
      providerReference: o.transactionTimeline?.providerReference || o.providerTransferId || o.providerReference,
      timeline: o.transactionTimeline || fallbackOnrampTimeline(o),
      raw: o
    }));
    return [...sells, ...buys].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [withdrawals, onrampOrders]);
  const filtered = transactions.filter((tx) => {
    if (filter === 'sell' && tx.direction !== 'sell') return false;
    if (filter === 'buy' && tx.direction !== 'buy') return false;
    if (filter === 'processing' && ['completed', 'failed', 'cancelled'].includes(tx.status)) return false;
    const haystack = [tx.id, tx.providerReference, tx.status, tx.amount, tx.currency, tx.asset, tx.label].join(' ').toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });
  const [selectedId, setSelectedId] = useState<string>('');
  const [aceAnswer, setAceAnswer] = useState<any>(null);
  const [aceLoading, setAceLoading] = useState(false);
  const selected = filtered.find((tx) => tx.id === selectedId) || filtered[0] || null;
  async function askAce(tx: CustomerTransactionRow | null) {
    if (!tx || !user) return;
    setAceLoading(true);
    try {
      const result = await api<any>(`/api/users/${user.id}/ace/support`, { method: 'POST', body: JSON.stringify({ message: tx.direction === 'sell' ? 'Where is my withdrawal?' : 'Where is my buy order?', resourceType: tx.kind, resourceId: tx.id, channel: 'web_dashboard' }) });
      setAceAnswer(result);
    } finally {
      setAceLoading(false);
    }
  }

  return <section className="app-page transactions-premium"><PageHero title="Transactions" subtitle="Follow every Sivan transaction from request to provider, settlement, bank or blockchain completion." action={<button className="primary-btn small" onClick={() => exportTransactions(filtered)}>Export CSV</button>} /><article className="transactions-table-card transaction-control-card"><div className="transactions-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by request ID, provider reference, amount..." /><div>{(['all','sell','buy','processing'] as const).map((item) => <button key={item} className={filter === item ? 'primary-btn small' : 'ghost-btn small'} onClick={() => setFilter(item)}>{item === 'all' ? 'All' : item === 'sell' ? 'Sells' : item === 'buy' ? 'Buys' : 'Processing'}</button>)}</div></div>{!transactions.length ? <div className="dashboard-empty"><p>No transactions yet.</p><div className="button-row"><button className="secondary-btn" onClick={onStart}>Start selling</button><button className="secondary-btn" onClick={onBuy}>Start buying</button></div></div> : <div className="transaction-ledger-layout"><div className="table-wrap"><table className="table premium-table"><thead><tr><th>Type</th><th>Asset</th><th>Amount</th><th>Status</th><th>Provider Ref</th><th>Request ID</th><th>Date</th></tr></thead><tbody>{filtered.map((tx) => <tr key={tx.id} className={selected?.id === tx.id ? 'selected-row' : ''} onClick={() => setSelectedId(tx.id)}><td><span className={`tx-type ${tx.direction}`}>{tx.direction === 'sell' ? '↗ Sell' : '↙ Buy'}</span></td><td>{tx.asset}</td><td>{tx.amount} {tx.currency}</td><td><Badge status={tx.status}>{friendlyStatus(tx.status)}</Badge></td><td>{tx.providerReference ? shortRef(tx.providerReference) : 'Pending'}</td><td>{shortRef(tx.id)}</td><td>{new Date(tx.createdAt).toLocaleDateString()}</td></tr>)}</tbody></table>{!filtered.length && <Empty>No transactions match your filter.</Empty>}</div><TransactionTimelinePanel transaction={selected} aceAnswer={aceAnswer} aceLoading={aceLoading} onAskAce={() => askAce(selected)} /></div>}</article></section>;
}

function TransactionTimelinePanel({ transaction, aceAnswer, aceLoading, onAskAce }: { transaction: CustomerTransactionRow | null; aceAnswer?: any; aceLoading?: boolean; onAskAce?: () => void }) {
  if (!transaction?.timeline) return <aside className="transaction-timeline-card"><Empty>Select a transaction to see its timeline.</Empty></aside>;
  const timeline = transaction.timeline;
  const currentStep = timeline.steps.find((step) => step.status === 'current') || timeline.steps.find((step) => step.status === 'failed') || timeline.steps[timeline.steps.length - 1];
  return <aside className="transaction-timeline-card"><div className="timeline-card-head"><div><p className="eyebrow">Transaction Timeline</p><h3>{transaction.label}</h3><small>{currentStep?.label || friendlyStatus(timeline.status)}</small></div><Badge status={timeline.status}>{friendlyStatus(timeline.status)}</Badge></div><div className="transaction-explanation-box">{timeline.explanation || transactionExplanation(timeline.transactionType, timeline.status)}</div><div className="timeline-meta-grid"><Kv label="Request ID" value={timeline.requestId} /><Kv label="Internal transaction ID" value={timeline.internalTransactionId} /><Kv label="Provider reference" value={timeline.providerReference || 'Pending'} /><Kv label="Amount" value={`${timeline.amount || transaction.amount} ${timeline.currency || transaction.currency}`} /><Kv label="Currency" value={timeline.currency || transaction.currency} /><Kv label="Asset" value={timeline.asset || transaction.asset} /></div><div className="customer-timeline-list">{timeline.steps.map((step, index) => <div className={`customer-timeline-step ${step.status}`} key={step.key}><div className="timeline-rail"><span>{step.status === 'completed' ? '✓' : step.status === 'failed' ? '!' : step.status === 'current' ? '•' : index + 1}</span>{index < timeline.steps.length - 1 && <i />}</div><div><strong>{step.label}</strong><time>{step.at ? new Date(step.at).toLocaleTimeString() : step.status === 'pending' ? 'Pending' : 'In progress'}</time><small>{step.description}</small></div></div>)}</div><div className="support-reference-box"><strong>Need support?</strong><span>Share the Request ID and Provider reference so support can trace this transaction faster.</span><button className="secondary-btn small" onClick={onAskAce} disabled={aceLoading}>{aceLoading ? 'Ace is checking...' : 'Ask Ace about this transaction'}</button>{aceAnswer && <pre className="ace-answer-box">{aceAnswer.answer}</pre>}</div></aside>;
}

function InlineTransactionTimeline({ timeline }: { timeline: TransactionTimeline }) {
  return <div className="inline-transaction-timeline"><div className="transaction-explanation-box">{timeline.explanation || transactionExplanation(timeline.transactionType, timeline.status)}</div><div className="timeline-meta-grid"><Kv label="Request ID" value={timeline.requestId} /><Kv label="Provider reference" value={timeline.providerReference || 'Pending'} /><Kv label="Amount" value={`${timeline.amount || '—'} ${timeline.currency || ''}`} /><Kv label="Internal transaction ID" value={timeline.internalTransactionId} /></div><div className="customer-timeline-list compact">{timeline.steps.map((step, index) => <div className={`customer-timeline-step ${step.status}`} key={step.key}><div className="timeline-rail"><span>{step.status === 'completed' ? '✓' : step.status === 'failed' ? '!' : step.status === 'current' ? '•' : index + 1}</span>{index < timeline.steps.length - 1 && <i />}</div><div><strong>{step.label}</strong><time>{step.at ? new Date(step.at).toLocaleTimeString() : step.status === 'pending' ? 'Pending' : 'In progress'}</time><small>{step.description}</small></div></div>)}</div></div>;
}

function transactionExplanation(type: string, status: string) {
  const withdrawal: Record<string, string> = {
    pending_deposit: 'We are waiting for your USDC/USDT to arrive on the selected network.',
    deposit_received: 'Your crypto has arrived. We are preparing your bank payout.',
    converting: 'Your crypto is being converted into your selected payout currency.',
    payout_processing: 'We are waiting for the banking partner to confirm your transfer.',
    completed: 'Your bank payout is complete.',
    failed: 'This withdrawal could not be completed. Contact support with your Request ID.',
    requires_action: 'This withdrawal needs additional review. Support may contact you for next steps.'
  };
  const onramp: Record<string, string> = {
    awaiting_payment: 'We are waiting for your bank payment using the exact reference shown.',
    payment_received: 'Your bank payment has been received. We are preparing crypto delivery.',
    processing: 'We are waiting for the provider to deliver crypto to your wallet.',
    completed: 'Your crypto delivery is complete.',
    failed: 'This buy order could not be completed. Contact support with your Request ID.',
    requires_action: 'This buy order needs additional review. Support may contact you for next steps.'
  };
  return (type === 'withdrawal' ? withdrawal : onramp)[status] || 'Your transaction is moving through provider processing.';
}

function fallbackWithdrawalTimeline(w: WithdrawalRecord): TransactionTimeline {
  const status = w.status;
  const doneAfterDeposit = ['deposit_received', 'converting', 'payout_processing', 'completed'].includes(status);
  const doneBank = ['payout_processing', 'completed'].includes(status);
  return {
    transactionType: 'withdrawal', requestId: w.id, internalTransactionId: w.id, providerReference: w.providerDrainId || w.destinationReference, amount: w.destinationAmount || w.sourceAmount, currency: w.destinationCurrency?.toUpperCase(), asset: w.sourceCurrency?.toUpperCase(), direction: 'sell', provider: w.provider, status, explanation: transactionExplanation('withdrawal', status), createdAt: w.createdAt, updatedAt: w.updatedAt, completedAt: w.completedAt,
    steps: [
      { key: 'withdrawal_created', label: 'Withdrawal Created', description: 'Your withdrawal request was created.', status: 'completed', at: w.createdAt },
      { key: 'identity_verified', label: 'Identity Verified', description: 'Your verified Sivan profile is attached to this transaction.', status: 'completed', at: w.createdAt },
      { key: 'provider_accepted', label: 'Provider Accepted', description: 'A provider-backed deposit address/reference was issued.', status: 'completed', at: w.createdAt },
      { key: 'blockchain_confirmed', label: 'Blockchain Confirmed', description: 'Waiting for blockchain confirmation.', status: doneAfterDeposit ? 'completed' : 'current', at: doneAfterDeposit ? w.updatedAt : undefined },
      { key: 'settlement_initiated', label: 'Settlement Initiated', description: 'Settlement into payout currency has started.', status: doneAfterDeposit ? 'completed' : 'pending', at: doneAfterDeposit ? w.updatedAt : undefined },
      { key: 'bank_processing', label: 'Bank Processing', description: 'Bank payout is being processed.', status: doneBank ? 'completed' : 'pending', at: doneBank ? w.updatedAt : undefined },
      { key: 'completed', label: 'Completed', description: 'The payout is complete.', status: status === 'completed' ? 'completed' : 'pending', at: w.completedAt }
    ]
  };
}

function fallbackOnrampTimeline(o: OnrampOrderRecord): TransactionTimeline {
  const status = o.status;
  const paymentReceived = ['payment_received', 'processing', 'completed'].includes(status);
  const processing = ['processing', 'completed'].includes(status);
  return {
    transactionType: 'onramp_order', requestId: o.id, internalTransactionId: o.id, providerReference: o.providerTransferId || o.providerReference, amount: o.amount, currency: o.sourceCurrency?.toUpperCase(), asset: o.destinationCurrency?.toUpperCase(), direction: 'buy', provider: o.provider, status, explanation: transactionExplanation('onramp_order', status), createdAt: o.createdAt, updatedAt: o.updatedAt, completedAt: o.completedAt,
    steps: [
      { key: 'order_created', label: 'Order Created', description: 'Your buy order was created.', status: 'completed', at: o.createdAt },
      { key: 'identity_verified', label: 'Identity Verified', description: 'Your verified Sivan profile is attached to this transaction.', status: 'completed', at: o.createdAt },
      { key: 'provider_accepted', label: 'Provider Accepted', description: 'Provider generated payment instructions.', status: 'completed', at: o.createdAt },
      { key: 'payment_instructions_issued', label: 'Payment Instructions Issued', description: 'Use the exact reference shown.', status: 'completed', at: o.createdAt },
      { key: 'fiat_payment_received', label: 'Fiat Payment Received', description: 'Waiting for bank payment detection.', status: paymentReceived ? 'completed' : 'current', at: paymentReceived ? o.updatedAt : undefined },
      { key: 'settlement_processing', label: 'Settlement Processing', description: 'Converting and preparing delivery.', status: processing ? 'completed' : 'pending', at: processing ? o.updatedAt : undefined },
      { key: 'blockchain_delivered', label: 'Blockchain Delivered', description: 'Crypto delivery to wallet.', status: status === 'completed' ? 'completed' : 'pending', at: o.completedAt },
      { key: 'completed', label: 'Completed', description: 'The buy order is complete.', status: status === 'completed' ? 'completed' : 'pending', at: o.completedAt }
    ]
  };
}

function exportTransactions(rows: CustomerTransactionRow[]) {
  const csv = ['type,requestId,status,amount,currency,providerReference,date', ...rows.map((tx) => [tx.direction, tx.id, tx.status, tx.amount, tx.currency, tx.providerReference || '', tx.createdAt].map(csvCell).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sivan-transactions.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function csvCell(value: unknown) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function BuyCryptoView({ hasUser, isVerified, feePercent, enabledControls, enabledAssets, enabledNetworks, orders, loading, onSubmit, onSell, onContinue, onSupport, onRefreshOrders }: { hasUser: boolean; isVerified: boolean; feePercent: string; enabledControls: PaymentControl[]; enabledAssets: AssetControl[]; enabledNetworks: NetworkControl[]; orders: OnrampOrderRecord[]; loading: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onSell: () => void; onContinue: () => void; onSupport: () => void; onRefreshOrders: () => Promise<void> }) {
  const [amount, setAmount] = useState('1000');
  const fee = (Number(amount || 0) * Number(feePercent || 0)) / 100;
  const receive = Math.max(0, Number(amount || 0) - fee);
  const latestOrder = orders[0];
  return <section className="app-page trade-premium"><div className="trade-page-head"><div><h1>Buy crypto</h1><p>Send fiat, receive crypto in your wallet.</p></div><div className="wizard-stepper"><button type="button" className="secondary-btn small" onClick={() => void onRefreshOrders()}>Refresh orders</button><StepDot active done={false} label="Quote" /><StepDot active={false} done={Boolean(latestOrder)} label="Review" /><StepDot active={false} done={false} label="Payment" /><StepDot active={false} done={latestOrder?.status === 'completed'} label="Tracking" /></div></div><div className="trade-grid"><article className="panel trade-card"><div className="seg"><button type="button" onClick={onSell}>↗ Sell</button><button type="button" className="active">↙ Buy</button></div>{!hasUser || !isVerified ? <div className="empty-state"><p>{hasUser ? 'Complete verification before buying stablecoins.' : 'Create your account before buying stablecoins.'}</p><button className="primary-btn" onClick={onContinue}>{hasUser ? 'Verify account →' : 'Get started →'}</button></div> : <form onSubmit={onSubmit} className="form premium-form"><div className="quote-box large"><div><small>You pay</small><input name="amount" className="quote-amount-input" value={amount} inputMode="decimal" onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))} /><small>Min 20 · Max 50,000</small></div><div><select name="sourceCurrency" defaultValue={enabledControls[0]?.currency || 'usd'}>{enabledControls.map((control) => <option value={control.currency} key={control.currency}>{control.currency.toUpperCase()}</option>)}</select><small>Bank transfer</small></div></div><div className="quote-swap">↓</div><div className="quote-box large"><div><small>You get</small><strong>{receive.toFixed(4)}</strong></div><div><select name="destinationCurrency" defaultValue={enabledAssets[0]?.asset || 'usdc'}>{enabledAssets.map((asset) => <option value={asset.asset} key={asset.asset}>{asset.label}</option>)}</select></div></div><label>Destination network<select name="destinationChain" defaultValue={enabledNetworks[0]?.network || 'base'}>{enabledNetworks.map((network) => <option value={network.network} key={network.network}>{network.label}</option>)}</select></label><label>Receiving wallet address<input name="destinationAddress" placeholder="Wallet address you control" required /></label><div className="quote-fees"><div><span>Rate</span><strong>1 fiat ≈ 1 stablecoin</strong></div><div><span>Fee ({feePercent}%)</span><strong className="danger">−${fee.toFixed(2)}</strong></div><div><span>Arrival</span><strong>Minutes after payment clears</strong></div><div><span>Payment method</span><strong>Bank transfer</strong></div></div><div className="verification-note">Your payment instructions are generated after you create the order. Send the exact amount and reference.</div><button className="primary-btn" disabled={loading || !enabledControls.length || !enabledAssets.length || !enabledNetworks.length}>{loading ? 'Creating order...' : 'Create buy order →'}</button></form>}{latestOrder && <OnrampInstructions order={latestOrder} />}</article><aside className="side-info-stack"><article className="panel"><h3>How this works</h3><ol className="ordered-steps"><li className="active">We generate a unique payment reference for your order.</li><li>Send the exact fiat amount to our licensed partner.</li><li>We detect payment and send crypto to your wallet.</li></ol></article><article className="security-card"><div className="security-icon">◈</div><div><h3>Secure & non-custodial</h3><p>Payments are processed by licensed partners. Funds are only held briefly during settlement.</p></div></article><article className="panel"><h3>Need help?</h3><p className="muted">Issues with a transfer, wrong network, or delayed payout? Our support team is on hand.</p><button className="secondary-btn" onClick={onSupport}>Contact support ↗</button></article></aside></div></section>;
}

function OnrampInstructions({ order }: { order: OnrampOrderRecord }) {
  const instructions = order.sourceDepositInstructions || {};
  const bankName = instructions.bank_name || instructions.bankName || 'Provided by Bridge';
  const bankAddress = instructions.bank_address || instructions.bankAddress;
  const accountNumber = instructions.bank_account_number || instructions.account_number || instructions.iban;
  const routingNumber = instructions.bank_routing_number || instructions.routing_number;
  const beneficiaryName = instructions.bank_beneficiary_name || instructions.account_name || instructions.beneficiary_name;
  const beneficiaryAddress = instructions.bank_beneficiary_address || instructions.beneficiary_address;
  const depositMessage = instructions.deposit_message || instructions.reference || order.providerReference || order.id;
  const rails = Array.isArray(instructions.payment_rails) ? instructions.payment_rails.join(', ') : (instructions.payment_rail || order.sourcePaymentRail);
  const copyValue = async (label: string, value?: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard can be blocked in some browsers; the value remains visible.
    }
  };
  const paymentMemo = [
    `Amount: ${order.amount} ${order.sourceCurrency.toUpperCase()}`,
    `Reference: ${depositMessage}`,
    `Bank: ${bankName}`,
    accountNumber ? `Account: ${accountNumber}` : undefined,
    routingNumber ? `Routing: ${routingNumber}` : undefined,
    beneficiaryName ? `Beneficiary: ${beneficiaryName}` : undefined,
  ].filter(Boolean).join('\n');
  return <div className="onramp-instructions premium-onramp-instructions">
    <div className="onramp-instruction-head"><div><p className="eyebrow">One-time payment instructions</p><h3>Send exactly {order.amount} {order.sourceCurrency.toUpperCase()}</h3><p>Use these bank details once for this buy order. Bridge will deliver {order.netAmount || '—'} {order.destinationCurrency.toUpperCase()} to your wallet after payment clears.</p></div><Badge status={order.status}>{friendlyStatus(order.status)}</Badge></div>
    <div className="payment-reference-callout"><span>Required payment reference / memo</span><strong>{depositMessage}</strong><button className="secondary-btn small" type="button" onClick={() => copyValue('reference', depositMessage)}>Copy reference</button></div>
    <div className="onramp-bank-grid">
      <Kv label="Bank" value={bankName} />
      <Kv label="Account number" value={accountNumber || 'See provider instructions'} />
      <Kv label="Routing number" value={routingNumber || '—'} />
      <Kv label="Beneficiary" value={beneficiaryName || '—'} />
      <Kv label="Payment rail" value={rails || 'bank transfer'} />
      <Kv label="Bank address" value={bankAddress || '—'} />
      <Kv label="Beneficiary address" value={beneficiaryAddress || '—'} />
      <Kv label="Order ID" value={order.id} />
    </div>
    <div className="quote-fees instruction-totals"><div><span>You pay</span><strong>{order.amount} {order.sourceCurrency.toUpperCase()}</strong></div><div><span>Sivan fee</span><strong className="danger">−{order.feeAmount || '0'} {order.sourceCurrency.toUpperCase()}</strong></div><div><span>You receive</span><strong>{order.netAmount || '—'} {order.destinationCurrency.toUpperCase()}</strong></div><div><span>Destination</span><strong>{order.destinationChain.replaceAll('_', ' ')} · {shortRef(order.destinationAddress)}</strong></div></div>
    <div className="split-actions"><button className="secondary-btn" type="button" onClick={() => copyValue('payment instructions', paymentMemo)}>Copy all details</button></div>
    {order.transactionTimeline && <InlineTransactionTimeline timeline={order.transactionTimeline} />}
    <div className="warning-box compact">Send the exact amount and include the reference/memo. Missing or incorrect references can delay matching and settlement.</div>
  </div>;
}
function TransferCryptoView({ hasUser, isVerified, balance, transfers, suppliers, supplierPayments, enabledNetworks, loading, onSubmit, onCreateSupplier, onSupplierPayment, onContinue, onRefresh }: { hasUser: boolean; isVerified: boolean; balance: BalanceSummary | null; transfers: BalanceTransferRecord[]; suppliers: SupplierRecord[]; supplierPayments: SupplierPaymentRecord[]; enabledNetworks: NetworkControl[]; loading: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onCreateSupplier: (event: FormEvent<HTMLFormElement>) => void; onSupplierPayment: (event: FormEvent<HTMLFormElement>) => void; onContinue: () => void; onRefresh: () => Promise<void> }) {
  const [activeRoute, setActiveRoute] = useState<'crypto' | 'supplier' | 'user'>('crypto');
  const [supplierCurrency, setSupplierCurrency] = useState<'gbp' | 'usd' | 'eur' | 'mxn' | 'brl'>('gbp');
  const usdc = balance?.balances.find((item) => item.asset === 'usdc');
  const available = Number(usdc?.available || 0);
  const pending = Number(usdc?.pending || 0);
  const held = Number(usdc?.held || 0);
  const networks = enabledNetworks.filter((network) => ['base', 'solana', 'avalanche_c_chain', 'polygon', 'ethereum', 'arbitrum'].includes(network.network));
  const approvedSuppliers = suppliers.filter((supplier) => supplier.status === 'approved');
  const supplierCurrencyLabel = { gbp: 'GBP · Faster Payments', usd: 'USD · ACH/Wire', eur: 'EUR · SEPA', mxn: 'MXN · SPEI', brl: 'BRL · PIX' }[supplierCurrency];
  return <section className="app-page transfer-premium"><PageHero title="Transfer & pay" subtitle="Send settled USDC to wallets or pay suppliers through Sivan’s provider routing. Sivan does not hold a live USD fiat balance for you." action={<button className="primary-btn small" onClick={() => void onRefresh()}>Refresh USDC balance</button>} />
    <div className="transfer-route-grid route-tabs">
      <button type="button" className={`transfer-route-card ${activeRoute === 'crypto' ? 'active' : ''}`} onClick={() => setActiveRoute('crypto')}><span>⇆</span><div><strong>Send crypto</strong><small>Transfer settled USDC to your own wallet on a supported network.</small></div><Badge status="active">Available</Badge></button>
      <button type="button" className={`transfer-route-card ${activeRoute === 'supplier' ? 'active' : ''}`} onClick={() => setActiveRoute('supplier')}><span>▭</span><div><strong>Pay supplier / cross-border</strong><small>Crypto-to-fiat payout to a saved supplier bank account after compliance checks.</small></div><Badge status="pending">Review</Badge></button>
      <button type="button" className={`transfer-route-card ${activeRoute === 'user' ? 'active' : ''}`} onClick={() => setActiveRoute('user')}><span>◇</span><div><strong>Send to Sivan user</strong><small>Future Sivan-user transfer between approved accounts.</small></div><Badge status="pending">Coming soon</Badge></button>
    </div>
    <div className="transfer-grid">
      <article className="panel transfer-balance-card"><p className="eyebrow">Settled USDC available</p><h2>{available.toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC</h2><div className="balance-mini-grid"><Kv label="Pending settlement" value={`${pending.toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC`} /><Kv label="Held for review" value={`${held.toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC`} /><Kv label="Spent" value={`${Number(usdc?.spent || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC`} /></div><p className="muted">This is an internal mirror of settled stablecoin funds from virtual-account deposits or approved adjustments. Virtual accounts are deposit-only: fiat goes in, the provider converts it, and only settled crypto becomes spendable.</p></article>
      {activeRoute === 'crypto' && <><article className="panel form-panel transfer-form-card"><p className="eyebrow">Send crypto from settled balance</p><h3>Transfer USDC to a wallet</h3>{!hasUser || !isVerified ? <div className="empty-state"><p>{hasUser ? 'Complete verification before transferring crypto.' : 'Create your account before transferring crypto.'}</p><button className="primary-btn" onClick={onContinue}>{hasUser ? 'Verify account →' : 'Get started →'}</button></div> : <form className="form premium-form" onSubmit={onSubmit}><label>Asset<select name="asset" defaultValue="usdc"><option value="usdc">USDC</option><option value="usdt">USDT later</option></select></label><label>Amount<input name="amount" inputMode="decimal" placeholder="20" required /></label><label>Destination network<select name="network" defaultValue={networks[0]?.network || 'base'}>{networks.map((network) => <option value={network.network} key={network.network}>{network.label}</option>)}</select></label><label>Destination wallet<input name="destinationAddress" placeholder="Wallet address you control" required /></label><label>Note optional<input name="note" placeholder="Internal note" /></label><div className="warning-box compact">Only send to a wallet on the selected network. Supplier/cross-border payouts use the Pay supplier route with saved bank details, not a stored USD fiat balance.</div><button className="primary-btn" disabled={loading || available <= 0}>{loading ? 'Creating transfer…' : available <= 0 ? 'No settled USDC available' : 'Review and create transfer →'}</button></form>}</article>
      <article className="panel transfer-history-card"><div className="panel-head"><div><p className="eyebrow">Transfer history</p><h3>Crypto sends</h3></div></div>{!transfers.length ? <Empty>No crypto transfers from settled balance yet.</Empty> : <div className="list">{transfers.map((transfer) => <div className="list-item" key={transfer.transferId}><strong>{transfer.amount} {transfer.asset.toUpperCase()} → {transfer.network.replaceAll('_', ' ')}</strong><Badge status={transfer.status}>{friendlyStatus(transfer.status)}</Badge><small>{shortRef(transfer.destinationAddress)} · {new Date(transfer.createdAt).toLocaleString()}</small>{transfer.note && <small>{transfer.note}</small>}</div>)}</div>}</article></>}
      {activeRoute === 'supplier' && <><article className="panel supplier-directory-card"><div className="panel-head"><div><p className="eyebrow">Supplier directory</p><h3>Saved suppliers</h3></div><Badge status={suppliers.length ? 'active' : 'pending'}>{suppliers.length ? `${suppliers.length} saved` : 'None yet'}</Badge></div>{!suppliers.length ? <Empty>No suppliers added yet.</Empty> : <div className="list supplier-list">{suppliers.map((supplier) => <div className="list-item" key={supplier.id}><strong>{supplier.supplierName}</strong><Badge status={supplier.status}>{friendlyStatus(supplier.status)}</Badge><small>{supplier.currency.toUpperCase()} · {supplier.supplierCountry} · {supplier.bankName} · ****{supplier.accountLast4 || '----'}</small><small>{supplier.status === 'approved' ? 'Ready for supplier payment requests.' : supplier.reviewReason || 'Waiting for compliance review.'}</small></div>)}</div>}<div className="warning-box compact">Sivan chooses the execution provider in the background. Customers see a single Transfer & Pay experience; provider diagnostics stay with operations.</div></article>
      <article className="panel form-panel supplier-form-card"><p className="eyebrow">Pay supplier / cross-border</p><h3>Add supplier bank</h3>{!hasUser || !isVerified ? <Empty>Complete verification before adding suppliers.</Empty> : <form className="form premium-form" onSubmit={onCreateSupplier}><label>Supplier business name<input name="supplierName" placeholder="ABC Trading Ltd" required /></label><div className="split"><label>Currency<select name="currency" value={supplierCurrency} onChange={(event) => setSupplierCurrency(event.target.value as any)}><option value="gbp">GBP · Faster Payments</option><option value="usd">USD · ACH/Wire</option><option value="eur">EUR · SEPA</option><option value="mxn">MXN · SPEI</option><option value="brl">BRL · PIX</option></select></label><label>Supplier country<input name="supplierCountry" defaultValue={supplierCurrency === 'gbp' ? 'GB' : supplierCurrency === 'usd' ? 'US' : supplierCurrency === 'mxn' ? 'MX' : supplierCurrency === 'brl' ? 'BR' : 'FR'} /></label></div><label>Bank name<input name="bankName" placeholder={supplierCurrency === 'gbp' ? 'Barclays' : supplierCurrency === 'usd' ? 'Lead Bank' : 'Supplier bank'} required /></label><label>Account owner name<input name="accountOwnerName" placeholder="ABC Trading Ltd" required /></label>{supplierCurrency === 'gbp' && <div className="split"><label>GBP account number<input name="gbAccountNumber" placeholder="12345678" required /></label><label>GBP sort code<input name="sortCode" placeholder="123456" required /></label></div>}{supplierCurrency === 'usd' && <div className="split"><label>USD account number<input name="accountNumber" placeholder="215268129123" required /></label><label>USD routing<input name="routingNumber" placeholder="101019644" required /></label></div>}{supplierCurrency === 'eur' && <><label>EUR IBAN<input name="ibanAccountNumber" placeholder="IE04MODR99035512826162" required /></label><label>BIC optional<input name="bic" placeholder="MODRIE22XXX" /></label></>}{supplierCurrency === 'mxn' && <label>CLABE<input name="clabeNumber" placeholder="18-digit CLABE" required /></label>}{supplierCurrency === 'brl' && <label>PIX key<input name="pixKey" placeholder="Supplier PIX key" required /></label>}<label>Supplier address<input name="street" placeholder="Supplier business address" /></label><div className="warning-box compact">{supplierCurrencyLabel} details are saved for compliance review. New suppliers stay pending until admin approval; AI can recommend, but never releases funds.</div><button className="primary-btn" disabled={loading}>{loading ? 'Adding supplier…' : 'Add supplier for review →'}</button></form>}</article>
      <article className="panel form-panel supplier-form-card"><p className="eyebrow">Create supplier payment</p><h3>Pay from settled USDC</h3>{!approvedSuppliers.length ? <Empty>Add a supplier and wait for approval before creating a payment.</Empty> : <form className="form premium-form" onSubmit={onSupplierPayment}><label>Supplier<select name="supplierId">{approvedSuppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.supplierName} · {supplier.currency.toUpperCase()} · approved</option>)}</select></label><label>Amount USDC<input name="amount" inputMode="decimal" placeholder="300" required /></label><label>Payment purpose<textarea name="paymentPurpose" placeholder="Invoice INV-1001 for software services" required /></label><label>Invoice URL<input name="invoiceUrl" placeholder="https://... optional but recommended" /></label><div className="warning-box compact">Sivan places a hold on settled USDC. Admin/backend risk controls release or reject. AI never releases funds.</div><button className="primary-btn" disabled={loading || available <= 0}>{loading ? 'Creating payment…' : available <= 0 ? 'No settled USDC available' : 'Create supplier payment →'}</button></form>}</article>
      <article className="panel transfer-history-card"><div className="panel-head"><div><p className="eyebrow">Supplier payment history</p><h3>Cross-border payouts</h3></div></div>{!supplierPayments.length ? <Empty>No supplier payments yet.</Empty> : <div className="list">{supplierPayments.map((payment) => <div className="list-item" key={payment.id}><strong>{payment.amount} USDC → {payment.destinationCurrency.toUpperCase()}</strong><Badge status={payment.status}>{friendlyStatus(payment.status)}</Badge><small>{payment.supplier?.supplierName || shortRef(payment.supplierId)} · Risk {payment.riskLevel} · {new Date(payment.createdAt).toLocaleString()}</small><small>{payment.reviewReason}</small></div>)}</div>}</article></>}
      {activeRoute === 'user' && <article className="panel transfer-history-card"><div className="panel-head"><div><p className="eyebrow">Coming soon</p><h3>Send to a Sivan user</h3></div><Badge status="pending">Roadmap</Badge></div><p className="muted">This future route will let approved Sivan customers send settled stablecoin value to another approved Sivan account without exposing provider internals.</p><div className="warning-box compact">For now, use Send crypto for wallet transfers or Pay supplier for cross-border bank payouts.</div></article>}
    </div>
    <article className="panel"><div className="panel-head"><div><p className="eyebrow">Stablecoin ledger</p><h3>Deposit, hold and spend trail</h3></div></div>{!balance?.ledger?.length ? <Empty>No stablecoin ledger entries yet. Deposit to your virtual account; after provider settlement, USDC can become spendable.</Empty> : <div className="table-wrap"><table className="table"><thead><tr><th>Type</th><th>Amount</th><th>Status</th><th>Source</th><th>Date</th></tr></thead><tbody>{balance.ledger.slice(0, 20).map((entry) => <tr key={entry.entryId}><td>{entry.kind.replaceAll('_', ' ')}</td><td>{entry.amount} {entry.asset.toUpperCase()}</td><td><Badge status={entry.status}>{friendlyStatus(entry.status)}</Badge></td><td>{entry.sourceType} · {shortRef(entry.sourceId)}</td><td>{new Date(entry.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div>}</article>
  </section>;
}



function NotificationCenter({ open, notifications, unreadCount, dotClass, readIds, timeNow, onToggle, onClose, onMarkAllRead, onOpen }: { open: boolean; notifications: UserNotification[]; unreadCount: number; dotClass: string; readIds: string[]; timeNow: number; onToggle: () => void; onClose: () => void; onMarkAllRead: () => void; onOpen: (item: UserNotification) => void }) {
  const visible = notifications.slice(0, 10);
  return <div className="notification-center-wrap">
    <button className={`icon-btn notification-button ${open ? 'active' : ''}`} aria-label="Notifications" aria-expanded={open} onClick={onToggle}>
      {unreadCount > 0 && <span className={`notif-dot ${dotClass}`}></span>}▢
    </button>
    {open && <div className="notification-panel" role="dialog" aria-label="Notifications">
      <div className="notification-head"><div><p className="eyebrow">Activity center</p><h3>Notifications</h3></div><button className="ghost-btn small" onClick={onClose}>Close</button></div>
      <div className="notification-summary"><span>{unreadCount ? `${unreadCount} unread` : 'All read'}</span>{notifications.length > 0 && <button onClick={onMarkAllRead}>Mark all as read</button>}</div>
      {!visible.length ? <div className="notification-empty"><strong>You’re all caught up</strong><small>Important updates about payments, verification, and support will appear here.</small></div> : <div className="notification-list">{visible.map((item) => {
        const read = readIds.includes(item.id);
        return <button key={item.id} className={`notification-item ${item.severity} ${read ? 'read' : 'unread'}`} onClick={() => onOpen(item)}>
          <span className="notification-icon">{item.icon}</span>
          <div><strong>{item.title}</strong><small>{item.message}</small><em>{timeAgo(item.createdAt, timeNow)}</em></div>
          {item.actionLabel && <b>{item.actionLabel} →</b>}
        </button>;
      })}</div>}
    </div>}
  </div>;
}

function IncidentBanner({ systemStatus }: { systemStatus: SystemStatus }) {
  const incidents = systemStatus.activeIncidents ?? [];
  if (incidents.length) {
    return <section className="maintenance-banner incident-banner dynamic"><strong>{incidents.some((item) => item.severity === 'critical') ? 'Service disruption' : 'Service notice'}</strong><div className="incident-banner-list">{incidents.map((incident) => <span key={incident.id}><b>{incident.provider}</b> · {incident.customerMessage || incident.message}{incident.eta ? ` ETA: ${incident.eta}` : ''}</span>)}</div></section>;
  }
  if (systemStatus.mode === 'active') return null;
  return <section className="maintenance-banner"><strong>{systemStatus.mode === 'maintenance' ? 'Maintenance mode' : 'Payments paused'}</strong><span>{systemStatus.message || (systemStatus.mode === 'maintenance' ? 'New withdrawals are temporarily unavailable while maintenance is in progress.' : 'New payment actions are temporarily paused.')}</span>{systemStatus.estimatedResumeAt && <small>Estimated resume: {new Date(systemStatus.estimatedResumeAt).toLocaleString()}</small>}</section>;
}

function PageHero({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) {
  return <div className="page-hero"><div><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>;
}

function LegalResources({ compact = false }: { compact?: boolean }) {
  const links = [
    { label: 'Terms', href: legalLinks.terms },
    { label: 'Privacy', href: legalLinks.privacy },
    { label: 'Risk Disclosure', href: legalLinks.risk },
    { label: 'Data Retention', href: legalLinks.dataRetention },
    { label: 'AML/KYC Policy', href: legalLinks.amlKyc },
    { label: 'Supported Jurisdictions', href: legalLinks.jurisdictions },
    { label: 'Wrong Network Policy', href: legalLinks.wrongNetwork },
    { label: 'Complaints Policy', href: legalLinks.complaints },
    { label: 'Cookie Policy', href: legalLinks.cookies }
  ];
  return <article className={compact ? 'legal-resource-card compact' : 'legal-resource-card'}><h3>Legal resources</h3><p className="muted">Review Sivan’s user terms, privacy practices, risk disclosures, and data retention policy.</p><div>{links.map((link) => <a key={link.label} href={link.href} target="_blank" rel="noreferrer">{link.label} ↗</a>)}</div></article>;
}

function SettingsView({ api, user, preferences, initialTab, twoFactorStatus, onTwoFactorStatusChanged, identityStatus, pairingCode, pairingExpiresAt, timeNow, onStartWhatsappLink, onCancelWhatsappLink, onUnlinkWhatsapp, onRefreshIdentity, onSavePreferences, onUpdatePreferences, loading, onLogout }: { api: <T>(path: string, options?: RequestInit) => Promise<T>; user: UserRecord | null; preferences: UserPreferencesRecord | null; initialTab: 'profile' | 'security' | 'notifications' | 'preferences'; twoFactorStatus: UserTwoFactorStatus | null; onTwoFactorStatusChanged: (status: UserTwoFactorStatus | null) => void; identityStatus: IdentityStatus | null; pairingCode: string; pairingExpiresAt: string; timeNow: number; onStartWhatsappLink: () => void; onCancelWhatsappLink: () => void; onUnlinkWhatsapp: () => void; onRefreshIdentity: () => Promise<void>; onSavePreferences: (event: FormEvent<HTMLFormElement>) => void; onUpdatePreferences: (patch: Partial<UserPreferencesRecord>) => Promise<void>; loading: boolean; onLogout: () => void }) {
  const [tab, setTab] = useState<'profile' | 'security' | 'notifications' | 'preferences'>(initialTab || 'profile');
  useEffect(() => { setTab(initialTab || 'profile'); }, [initialTab]);
  const nameParts = (user?.fullName || '').split(/\s+/);
  const currentPreferences = preferences ?? {
    userId: user?.id || '',
    defaultFiatCurrency: 'usd' as const,
    language: 'en-US' as const,
    transactionUpdates: true,
    marketingEmails: false,
    securityAlerts: true,
    emailConfirmationsForHighValue: false,
    updatedAt: new Date().toISOString()
  };
  return <section className="app-page settings-premium"><PageHero title="Settings" subtitle="Manage your account, security and preferences." /><div className="settings-grid-premium"><aside className="settings-tabs"><button className={tab === 'profile' ? 'active' : ''} onClick={() => setTab('profile')}>♙ Profile</button><button className={tab === 'security' ? 'active' : ''} onClick={() => setTab('security')}>▣ Security</button><button className={tab === 'notifications' ? 'active' : ''} onClick={() => setTab('notifications')}>♢ Notifications</button><button className={tab === 'preferences' ? 'active' : ''} onClick={() => setTab('preferences')}>◎ Preferences</button></aside><article className="settings-panel">{tab === 'profile' && <><h3>Profile</h3><p className="muted">Your personal information.</p><div className="profile-row"><div className="avatar-lg">{initials(user?.fullName || user?.email)}</div><div><strong>{user?.fullName || 'Sivan user'}</strong><small>{user?.email || '—'} · {user ? 'Verified email' : 'Guest'}</small><button className="ghost-btn small">Upload new photo</button></div></div><div className="split"><label>First name<input defaultValue={nameParts[0] || ''} /></label><label>Last name<input defaultValue={nameParts.slice(1).join(' ')} /></label></div><label>Email<input defaultValue={user?.email || ''} /></label><IdentityLinkCard identityStatus={identityStatus} pairingCode={pairingCode} pairingExpiresAt={pairingExpiresAt} timeNow={timeNow} loading={loading} onStart={onStartWhatsappLink} onCancel={onCancelWhatsappLink} onUnlink={onUnlinkWhatsapp} onRefresh={onRefreshIdentity} /><div className="split"><label>Country<select defaultValue="NG"><option value="NG">Nigeria</option><option value="US">United States</option><option value="GB">United Kingdom</option></select></label><label>Phone<input value={identityStatus?.link?.whatsappNumber || user?.whatsappNumber || ''} placeholder="Link WhatsApp to populate this securely" readOnly /></label></div><button className="primary-btn">Save changes</button></>}{tab === 'security' && <SecuritySettingsPanel api={api} user={user} preferences={currentPreferences} initialStatus={twoFactorStatus} onStatusChanged={onTwoFactorStatusChanged} loading={loading} onUpdate={onUpdatePreferences} onLogout={onLogout} />}{tab === 'notifications' && <NotificationPreferencesPanel preferences={currentPreferences} loading={loading} onUpdate={onUpdatePreferences} />}{tab === 'preferences' && <form onSubmit={onSavePreferences}><h3>Preferences</h3><p className="muted">Customize your experience.</p><label>Default fiat currency<select name="defaultFiatCurrency" defaultValue={currentPreferences.defaultFiatCurrency}><option value="usd">USD — US Dollar</option><option value="gbp">GBP — British Pound</option><option value="eur">EUR — Euro</option><option value="ngn">NGN — Coming soon</option></select></label><label>Language<select name="language" defaultValue={currentPreferences.language}><option value="en-US">English — United States</option><option value="en-GB">English — United Kingdom</option><option value="fr-FR">French — European Union</option><option value="de-DE">German — European Union</option><option value="es-ES">Spanish — European Union</option><option value="it-IT">Italian — European Union</option><option value="nl-NL">Dutch — European Union</option><option value="pt-PT">Portuguese — European Union</option></select><span className="field-hint">App language rollout for US, UK, and EU markets. Provider verification pages may use the closest supported language.</span></label><input type="hidden" name="transactionUpdates" value="on" checked={currentPreferences.transactionUpdates} readOnly /><input type="hidden" name="marketingEmails" value="on" checked={currentPreferences.marketingEmails} readOnly /><input type="hidden" name="securityAlerts" value="on" checked={currentPreferences.securityAlerts} readOnly /><input type="hidden" name="emailConfirmationsForHighValue" value="on" checked={currentPreferences.emailConfirmationsForHighValue} readOnly /><button className="primary-btn" disabled={loading}>{loading ? 'Saving...' : 'Save preferences'}</button><button type="button" className="secondary-btn" onClick={onLogout}>Sign out</button></form>}<LegalResources compact /></article></div></section>;
}


function IdentityLinkCard({ identityStatus, pairingCode, pairingExpiresAt, timeNow, loading, onStart, onCancel, onUnlink, onRefresh }: { identityStatus: IdentityStatus | null; pairingCode: string; pairingExpiresAt: string; timeNow: number; loading: boolean; onStart: () => void; onCancel: () => void; onUnlink: () => void; onRefresh: () => Promise<void> }) {
  const link = identityStatus?.link;
  const pending = identityStatus?.pendingPairing;
  const expiresAt = pairingExpiresAt || pending?.expiresAt || '';
  const secondsLeft = expiresAt ? Math.max(0, Math.ceil((new Date(expiresAt).getTime() - timeNow) / 1000)) : 0;
  const whatsappHref = pairingCode ? `https://wa.me/2349136717403?text=${encodeURIComponent(pairingCode)}` : '';
  const copyPairingCode = async () => {
    if (!pairingCode) return;
    await navigator.clipboard?.writeText(pairingCode).catch(() => undefined);
  };

  return <div className="identity-link-card"><div><p className="eyebrow">Sivan unified identity</p><h3>Linked WhatsApp / Escrow account</h3><p className="muted">Link your WhatsApp escrow identity so your web dashboard and WhatsApp use one Sivan customer profile.</p></div>{link ? <div className="identity-link-status linked"><span>Linked</span><strong>{link.whatsappNumber}</strong><small>Linked {link.linkedAt ? new Date(link.linkedAt).toLocaleString() : 'recently'}</small><div className="identity-link-actions"><button type="button" className="ghost-btn small" disabled={loading} onClick={() => void onRefresh()}>Refresh status</button><button type="button" className="ghost-btn small" disabled={loading} onClick={onUnlink}>Unlink</button></div></div> : pending ? <div className="identity-link-status pending"><span>Pairing code active</span><strong>{pairingCode || 'Code generated'}</strong><small>{secondsLeft ? `Expires in ${Math.floor(secondsLeft / 60)}m ${secondsLeft % 60}s` : `Expires ${new Date(pending.expiresAt).toLocaleString()}`}</small><div className="identity-link-actions"><button type="button" className="ghost-btn small" disabled={!pairingCode || loading} onClick={copyPairingCode}>Copy code</button>{whatsappHref && <a className="ghost-btn small" href={whatsappHref} target="_blank" rel="noreferrer">Open WhatsApp</a>}<button type="button" className="ghost-btn small" disabled={loading} onClick={() => void onRefresh()}>Refresh</button><button type="button" className="ghost-btn small" disabled={loading} onClick={onCancel}>Cancel code</button></div></div> : <div className="identity-link-status"><span>Not linked</span><strong>Connect WhatsApp Escrow</strong><small>Generate a code, then send it to Sivan on WhatsApp.</small><div className="identity-link-actions"><button type="button" className="secondary-btn" disabled={loading} onClick={onStart}>Generate pairing code</button><button type="button" className="ghost-btn small" disabled={loading} onClick={() => void onRefresh()}>Refresh status</button></div></div>}</div>;
}



function SecuritySettingsPanel({ api, user, preferences, initialStatus, onStatusChanged, loading, onUpdate, onLogout }: { api: <T>(path: string, options?: RequestInit) => Promise<T>; user: UserRecord | null; preferences: UserPreferencesRecord; initialStatus: UserTwoFactorStatus | null; onStatusChanged: (status: UserTwoFactorStatus | null) => void; loading: boolean; onUpdate: (patch: Partial<UserPreferencesRecord>) => Promise<void>; onLogout: () => void }) {
  const [status, setStatus] = useState<UserTwoFactorStatus | null>(initialStatus);
  const [setup, setSetup] = useState<{ manualEntryKey: string; otpauthUrl: string } | null>(null);
  const [setupCode, setSetupCode] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  useEffect(() => { setStatus(initialStatus); }, [initialStatus]);
  const [busy, setBusy] = useState(false);
  const emailConfirmations = Boolean(preferences.emailConfirmationsForHighValue);
  const securityAlerts = Boolean(preferences.securityAlerts);
  const enabled = Boolean(status?.enabled);
  const load2fa = useCallback(async () => {
    if (!user?.id) return;
    const result = await api<any>(`/api/users/${user.id}/2fa`).catch(() => null);
    if (result) { setStatus(result); onStatusChanged(result); }
  }, [api, onStatusChanged, user?.id]);
  useEffect(() => { void load2fa(); }, [load2fa]);
  async function startSetup() {
    if (!user?.id) return;
    setBusy(true);
    try {
      const result = await api<any>(`/api/users/${user.id}/2fa/setup`, { method: 'POST', body: '{}' });
      setSetup(result);
      setRecoveryCodes([]);
    } finally { setBusy(false); }
  }
  async function enableSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.id) return;
    setBusy(true);
    try {
      const result = await api<any>(`/api/users/${user.id}/2fa/enable`, { method: 'POST', body: JSON.stringify({ code: setupCode }) });
      setRecoveryCodes(result.recoveryCodes || []);
      setSetup(null);
      setSetupCode('');
      await load2fa();
    } finally { setBusy(false); }
  }
  async function disable2fa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.id) return;
    setBusy(true);
    try {
      await api<any>(`/api/users/${user.id}/2fa/disable`, { method: 'POST', body: JSON.stringify({ code: disableCode }) });
      setDisableCode('');
      setRecoveryCodes([]);
      await load2fa();
    } finally { setBusy(false); }
  }
  const score = enabled && emailConfirmations && securityAlerts ? 'Excellent' : enabled && securityAlerts ? 'Strong' : emailConfirmations && securityAlerts ? 'Strong' : 'Good';
  return <div className="security-settings-panel">
    <div className="settings-section-head"><h3>Security</h3><p className="muted">Protect access to your Sivan account with passwordless email, authenticator 2FA, and high-value confirmations.</p></div>
    <div className="security-health-card"><span>Security score</span><strong>{score}</strong><small>{enabled ? `Authenticator 2FA is enabled${status?.lastVerifiedAt ? ` · last verified ${new Date(status.lastVerifiedAt).toLocaleDateString()}` : ''}.` : 'Enable authenticator 2FA for stronger account protection.'}</small></div>
    <div className="security-settings-list">
      <div className="security-setting-row connected"><span>▣</span><div><strong>Passwordless email access</strong><small>Sign in with a one-time code sent to {user?.email || 'your verified email'}. Sivan does not store a password for your account.</small><em>Active</em></div><button type="button" className="ghost-btn small" onClick={onLogout}>Sign out</button></div>
      <div className={`security-setting-row connected ${enabled ? 'enabled' : ''}`}><span>⚿</span><div><strong>Authenticator 2FA</strong><small>{enabled ? `Enabled. Recovery codes remaining: ${status?.recoveryCodesRemaining ?? 0}.` : 'Use Google Authenticator, 1Password, Authy, iCloud Passwords, or any TOTP app.'}</small><em>{enabled ? 'Enabled' : 'Recommended'}</em></div>{enabled ? <form className="inline-security-form" onSubmit={disable2fa}><input value={disableCode} onChange={(event) => setDisableCode(event.target.value)} placeholder="Code to disable" /><button className="ghost-btn small" disabled={busy || disableCode.length < 6}>Disable</button></form> : <button type="button" className="secondary-btn small" disabled={busy} onClick={startSetup}>{busy ? 'Starting…' : 'Enable 2FA'}</button>}</div>
      {setup && <form className="two-factor-setup-card" onSubmit={enableSetup}><div><p className="eyebrow">Authenticator setup</p><h3>Add Sivan to your authenticator app</h3><p className="muted">Enter this setup key manually in your authenticator app, then type the 6-digit code it generates.</p></div><div className="manual-key-box"><span>Manual setup key</span><strong>{setup.manualEntryKey}</strong><button type="button" className="ghost-btn small" onClick={() => navigator.clipboard?.writeText(setup.manualEntryKey)}>Copy key</button></div><label>Authenticator code<input value={setupCode} onChange={(event) => setSetupCode(event.target.value.replace(/\s/g, ''))} placeholder="123456" inputMode="numeric" autoComplete="one-time-code" /></label><button className="primary-btn" disabled={busy || setupCode.length < 6}>{busy ? 'Verifying…' : 'Verify and enable 2FA'}</button></form>}
      {recoveryCodes.length > 0 && <div className="recovery-code-card"><p className="eyebrow">Save these recovery codes now</p><h3>Recovery codes</h3><p className="muted">Store these securely. Each code works once if you lose your authenticator app.</p><div>{recoveryCodes.map((code) => <code key={code}>{code}</code>)}</div><button className="secondary-btn small" onClick={() => navigator.clipboard?.writeText(recoveryCodes.join('\n'))}>Copy recovery codes</button></div>}
      <div className={`security-setting-row connected ${emailConfirmations ? 'enabled' : ''}`}><span>✉</span><div><strong>Email confirmations for high-value actions</strong><small>Require email confirmation for high-value transfers and sensitive payment actions where supported.</small><em>{emailConfirmations ? 'Enabled' : 'Disabled'}</em></div><label className="switch-toggle connected"><input type="checkbox" checked={emailConfirmations} disabled={loading} onChange={(event) => void onUpdate({ emailConfirmationsForHighValue: event.target.checked })} /><i /></label></div>
      <div className={`security-setting-row connected ${securityAlerts ? 'enabled' : ''}`}><span>◈</span><div><strong>Security alerts</strong><small>Receive notices about verification, account changes, risk events, support escalations, and important account safety updates.</small><em>{securityAlerts ? 'Enabled' : 'Disabled'}</em></div><label className="switch-toggle connected"><input type="checkbox" checked={securityAlerts} disabled={loading} onChange={(event) => void onUpdate({ securityAlerts: event.target.checked })} /><i /></label></div>
      <div className="security-setting-row"><span>◷</span><div><strong>Active session</strong><small>Current browser session active. Sign out if this is not your device.</small><em>Current device</em></div><button type="button" className="secondary-btn small" onClick={onLogout}>Sign out</button></div>
    </div>
    <div className="notification-settings-foot"><strong>Connected</strong><span>Authenticator 2FA is enforced during sign-in after email-code verification.</span></div>
  </div>;
}

function NotificationPreferencesPanel({ preferences, loading, onUpdate }: { preferences: UserPreferencesRecord; loading: boolean; onUpdate: (patch: Partial<UserPreferencesRecord>) => Promise<void> }) {
  const rows: Array<{ key: keyof Pick<UserPreferencesRecord, 'transactionUpdates' | 'marketingEmails' | 'securityAlerts' | 'emailConfirmationsForHighValue'>; icon: string; title: string; body: string; locked?: boolean }> = [
    { key: 'transactionUpdates', icon: '♢', title: 'Transaction updates', body: 'Deposits, on-ramp payments, payouts, balance credits, supplier payments, and transfer status.' },
    { key: 'securityAlerts', icon: '◈', title: 'Security alerts', body: 'Verification, account changes, support-risk events, and important account safety notices.' },
    { key: 'emailConfirmationsForHighValue', icon: '✉', title: 'High-value confirmations', body: 'Require email confirmation for high-value transfers where supported.' },
    { key: 'marketingEmails', icon: '◎', title: 'Marketing emails', body: 'Product news, feature updates, offers, and launch announcements.' }
  ];
  return <div className="notification-settings-panel"><div className="settings-section-head"><h3>Notifications</h3><p className="muted">These switches save directly to your Sivan preferences. Critical transactional and security notices may still be sent when required for account safety or compliance.</p></div><div className="notification-settings-list">{rows.map((row) => {
    const checked = Boolean(preferences[row.key]);
    return <div className={`notification-setting-row ${checked ? 'enabled' : ''}`} key={row.key}><span>{row.icon}</span><div><strong>{row.title}</strong><small>{row.body}</small><em>{checked ? 'Enabled' : 'Disabled'}</em></div><label className="switch-toggle connected"><input name={row.key} type="checkbox" checked={checked} disabled={loading} onChange={(event) => void onUpdate({ [row.key]: event.target.checked } as Partial<UserPreferencesRecord>)} /><i /></label></div>;
  })}</div><div className="notification-settings-foot"><strong>Connected</strong><span>Saved to your account preferences and used by Sivan notification surfaces.</span></div></div>;
}

function SettingsRows({ rows, preferences }: { rows: string[][]; preferences?: UserPreferencesRecord }) {
  return <div className="settings-row-list">{rows.map((row) => {
    const key = row[3];
    const isToggle = ['transactionUpdates', 'marketingEmails', 'securityAlerts', 'emailConfirmationsForHighValue'].includes(key);
    const checked = key === 'transactionUpdates' ? preferences?.transactionUpdates : key === 'marketingEmails' ? preferences?.marketingEmails : key === 'securityAlerts' ? preferences?.securityAlerts : key === 'emailConfirmationsForHighValue' ? preferences?.emailConfirmationsForHighValue : false;
    return <div className="settings-row" key={row[1]}><span>{row[0]}</span><div><strong>{row[1]}</strong><small>{row[2]}</small></div>{isToggle ? <label className="switch-toggle"><input name={key} type="checkbox" defaultChecked={Boolean(checked)} /><i /></label> : <button type="button" className="ghost-btn small">{key}</button>}</div>;
  })}</div>;
}


function SupportView({ hasUser, tickets, withdrawals, onrampOrders, accounts, customer, api, onCreateTicket, onTicketsChanged, loading }: { hasUser: boolean; tickets: SupportTicketRecord[]; withdrawals: WithdrawalRecord[]; onrampOrders: OnrampOrderRecord[]; accounts: ExternalAccountRecord[]; customer: CustomerRecord | null; api: <T>(path: string, options?: RequestInit) => Promise<T>; onCreateTicket: (event: FormEvent<HTMLFormElement>) => void; onTicketsChanged: (tickets: SupportTicketRecord[]) => void; loading: boolean }) {
  const [selectedTicket, setSelectedTicket] = useState<SupportTicketRecord | null>(null);
  const faqs = ['How long does a sell take?', 'What fees does Sivan charge?', 'My payout is delayed. What should I do?', 'What happens if I send the wrong network?'];
  async function openTicket(ticket: SupportTicketRecord) {
    const detail = await api<SupportTicketRecord>(`/api/support/tickets/${ticket.id}`);
    setSelectedTicket(detail);
  }
  async function reply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTicket) return;
    const data = getForm(event.currentTarget);
    await api(`/api/support/tickets/${selectedTicket.id}/messages`, { method: 'POST', body: JSON.stringify({ message: data.message }) });
    const detail = await api<SupportTicketRecord>(`/api/support/tickets/${selectedTicket.id}`);
    setSelectedTicket(detail);
    onTicketsChanged(tickets.map((ticket) => ticket.id === detail.id ? { ...ticket, ...detail } : ticket));
    (event.currentTarget as HTMLFormElement).reset();
  }
  return <section className="app-page support-premium"><PageHero title="Support" subtitle="Report an issue, track your ticket, or find quick answers when something needs attention." /><div className="support-card-grid"><SupportCard icon="▢" title="Live chat" body="Chat with our team · Response within hours" action="Start chat" /><SupportCard icon="✉" title="Email support" body="support@sivantech.online" action="Send email" href="mailto:support@sivantech.online" /><SupportCard icon="☷" title="Help center" body="Guides, FAQs, and troubleshooting" action="Browse docs" /><a className="support-card" href="#report-issue"><span>☎</span><h3>Report an issue</h3><p>Problem with a transaction? Open a ticket.</p><strong>Open ticket →</strong></a></div><div className="support-legal-grid support-workspace-grid"><article className="support-faq-card support-report-card" id="report-issue"><p className="eyebrow">Support workspace</p><h3>Report an issue</h3><p className="muted">Tell us what happened. Add a transaction, bank reference, wallet address, or screenshot if available.</p>{!hasUser ? <Empty>Create your account or sign in before opening a support ticket.</Empty> : <form className="form" onSubmit={onCreateTicket}><label>Issue type<select name="type" defaultValue="withdrawal"><option value="verification">Verification issue</option><option value="bank_account">Bank account issue</option><option value="withdrawal">Withdrawal issue</option><option value="deposit_not_detected">Deposit sent but not detected</option><option value="wrong_token_or_network">Wrong token or wrong network</option><option value="payout_delayed">Payout delayed</option><option value="onramp_payment">On-ramp payment issue</option><option value="onramp_delivery">On-ramp crypto not received</option><option value="account_access">Account access issue</option><option value="other">Other</option></select></label><label>Related item<select name="relatedItem" defaultValue="general:"><option value="general:">General issue</option>{customer && <option value={`customer:${customer.id}`}>Verification · {friendlyStatus(customer.kycStatus)}</option>}{withdrawals.map((withdrawal) => <option key={withdrawal.id} value={`withdrawal:${withdrawal.id}`}>Withdrawal {shortRef(withdrawal.id)} · {friendlyStatus(withdrawal.status)}</option>)}{onrampOrders.map((order) => <option key={order.id} value={`onramp_order:${order.id}`}>Buy order {shortRef(order.id)} · {friendlyStatus(order.status)}</option>)}{accounts.map((account) => <option key={account.id} value={`external_account:${account.id}`}>Bank account {account.currency.toUpperCase()} · ****{account.accountLast4 || '----'}</option>)}</select></label><div className="split"><label>Transaction hash<input name="transactionHash" placeholder="Optional" /></label><label>Bank reference<input name="bankReference" placeholder="Optional" /></label></div><label>Wallet address<input name="walletAddress" placeholder="Optional wallet involved" /></label><label>Upload screenshot or receipt<input name="attachment" type="file" accept="image/png,image/jpeg,image/webp,image/heic,application/pdf" /></label><label>Attachment URL<input name="attachmentUrl" placeholder="Optional screenshot/receipt URL" /></label><label>Subject<input name="subject" placeholder="Short summary" required /></label><label>Description<textarea name="description" placeholder="Tell us what happened. Include date, amount, wallet address, transaction hash, bank reference, or error message if available." required /></label><button className="primary-btn" disabled={loading}>{loading ? 'Creating ticket...' : 'Create ticket'}</button></form>}</article><article className="support-faq-card support-ticket-card"><p className="eyebrow">Ticket center</p><h3>Your recent tickets</h3>{!tickets.length ? <Empty>No tickets yet. When you create a ticket, updates will appear here.</Empty> : <div className="list">{tickets.slice(0, 6).map((ticket) => <button className="list-item ticket-list-button" key={ticket.id} onClick={() => openTicket(ticket)}><strong>{ticket.subject}</strong><Badge status={ticket.status}>{friendlyStatus(ticket.status)}</Badge><small>{ticket.type.replaceAll('_', ' ')} · {ticket.priority}</small><small>{new Date(ticket.createdAt).toLocaleString()}</small></button>)}</div>}</article></div><div className="support-legal-grid support-resources-grid"><article className="support-faq-card"><p className="eyebrow">Self-help</p><h3>Frequently asked</h3>{faqs.map((faq) => <button key={faq}>{faq}<span>+</span></button>)}</article><LegalResources /></div>{selectedTicket && <TicketConversation ticket={selectedTicket} onClose={() => setSelectedTicket(null)} onReply={reply} />}</section>;
}

function TicketConversation({ ticket, onClose, onReply }: { ticket: SupportTicketRecord; onClose: () => void; onReply: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="ticket-drawer"><div className="ticket-drawer-card"><div className="panel-head"><div><p className="eyebrow">Ticket {ticket.id}</p><h3>{ticket.subject}</h3></div><button className="ghost-btn small" onClick={onClose}>Close</button></div><div className="details-box"><Kv label="Status" value={friendlyStatus(ticket.status)} /><Kv label="Priority" value={ticket.priority} /><Kv label="Type" value={ticket.type.replaceAll('_', ' ')} /><Kv label="Related" value={`${ticket.resourceType}${ticket.resourceId ? ` · ${ticket.resourceId}` : ''}`} /></div><div className="ticket-thread">{(ticket.messages ?? []).filter((message) => !message.internalNote).map((message) => <div className={`ticket-message ${message.senderType}`} key={message.id}><strong>{message.senderType === 'admin' ? 'Sivan Support' : 'You'}</strong><p>{message.message}</p><small>{new Date(message.createdAt).toLocaleString()}</small></div>)}</div><form className="form" onSubmit={onReply}><label>Reply<textarea name="message" required /></label><button className="primary-btn">Send reply</button></form></div></div>;
}


function SupportCard({ icon, title, body, action, href }: { icon: string; title: string; body: string; action: string; href?: string }) {
  const content = <><span>{icon}</span><h3>{title}</h3><p>{body}</p><strong>{action} →</strong></>;
  return href ? <a className="support-card" href={href}>{content}</a> : <button className="support-card">{content}</button>;
}


function ProgressItem({ done, label }: { done: boolean; label: string }) {
  return <div className={`progress-item ${done ? 'done' : ''}`}><span>{done ? '✓' : '•'}</span>{label}</div>;
}

function Stat({ label, value, helper }: { label: string; value: string; helper: string }) {
  return <article className="stat-card"><p>{label}</p><strong>{value}</strong><span>{helper}</span></article>;
}

function CustomerDetails({ customer }: { customer: CustomerRecord }) {
  const verificationLink = customer.hostedKycLink || customer.kycLink;
  const termsLink = customer.tosLink;
  const approved = customer.kycStatus === 'kyc_approved';
  const underReview = customer.kycStatus === 'kyc_under_review';
  const termsApproved = customer.tosStatus === 'approved';
  const actionLabel = approved ? 'Verification complete' : underReview ? 'Review in progress' : 'Open verification page';
  return (
    <div className="verification-summary-clean">
      <div className="verification-status-list">
        <div><span>Status</span><strong>{friendlyStatus(customer.kycStatus)}</strong></div>
        <div><span>Account type</span><strong>{customer.customerType === 'business' ? 'Business' : 'Individual'}</strong></div>
        <div><span>Terms</span><strong>{customer.tosStatus ? friendlyStatus(customer.tosStatus) : 'Pending'}</strong></div>
      </div>
      {verificationLink && !approved && !underReview && (
        <a className="verification-action-card" href={verificationLink} target="_blank" rel="noreferrer">
          <span>Secure verification</span>
          <strong>Continue your verification</strong>
          <small>Your secure link opens in a new tab. We hide the long URL to keep this page clean.</small>
          <em>{actionLabel} →</em>
        </a>
      )}
      {termsLink && !termsApproved && (
        <a className="verification-action-card terms-card" href={termsLink} target="_blank" rel="noreferrer">
          <span>Terms required</span>
          <strong>Accept terms to finish</strong>
          <small>Complete this step, then return here and refresh status.</small>
          <em>Accept terms →</em>
        </a>
      )}
      {!approved && !underReview && !termsApproved && <div className="verification-note">If you already finished, allow a few moments for processing and refresh status.</div>}
      {underReview && <div className="verification-note success-note">Your verification is under review. We will update your account as soon as it is approved.</div>}
      {approved && <div className="verification-note success-note">You are verified. You can now add a bank account and use Sivan payment features.</div>}
    </div>
  );
}

function Kv({ label, value }: { label: string; value?: string | number | null }) {
  return <div className="kv"><span>{label}</span><strong>{value ?? '—'}</strong></div>;
}

function BankForm({ onSubmit, loading, isVerified, controls, canCreatePaymentActions, isLiveEnv }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; loading: boolean; isVerified: boolean; controls: PaymentControl[]; canCreatePaymentActions: boolean; isLiveEnv: boolean }) {
  const [currency, setCurrency] = useState<'usd' | 'gbp' | 'eur'>((controls[0]?.currency ?? 'usd') as 'usd' | 'gbp' | 'eur');
  useEffect(() => {
    if (controls.length && !controls.some((control) => control.currency === currency)) {
      setCurrency(controls[0].currency);
    }
  }, [controls, currency]);
  if (!isVerified) return <article className="panel form-panel"><p className="eyebrow">Step 3</p><h3>Add your bank</h3><Empty>Complete verification before adding a bank account.</Empty></article>;
  if (!controls.length) return <article className="panel form-panel"><p className="eyebrow">Step 3</p><h3>Add your bank</h3><Empty>Bank payouts are temporarily unavailable.</Empty></article>;
  const isUsd = currency === 'usd';
  const isGbp = currency === 'gbp';
  return (
    <article className="panel form-panel">
      <p className="eyebrow">Step 3</p>
      <h3>Add your bank</h3>
      <p className="muted">Your payout must go to a bank account you own. Available payout currencies are controlled by Sivan.</p>
      <form className="form" onSubmit={onSubmit}>
        <label>Payout currency
          <select name="currency" value={currency} onChange={(event) => setCurrency(event.target.value as 'usd' | 'gbp' | 'eur')}>
            {controls.map((control) => <option key={control.currency} value={control.currency}>{control.label}</option>)}
          </select>
        </label>
        <label>Bank name<input name="bankName" placeholder={isUsd ? 'Bank name' : isGbp ? 'Bank name' : 'SEPA bank name'} defaultValue={isLiveEnv ? '' : isUsd ? 'Lead Bank' : isGbp ? 'Example UK Bank' : 'Example SEPA Bank'} required /></label>
        <label>Account owner name<input name="accountOwnerName" placeholder="Account holder name" defaultValue={isLiveEnv ? '' : 'Ada Lovelace'} required /></label>
        <div className="split"><label>First name<input name="firstName" placeholder="First name" defaultValue={isLiveEnv ? '' : 'Ada'} /></label><label>Last name<input name="lastName" placeholder="Last name" defaultValue={isLiveEnv ? '' : 'Lovelace'} /></label></div>
        {isUsd ? <>
          <label>Routing number<input name="routingNumber" placeholder="Routing number" defaultValue={isLiveEnv ? '' : '101019644'} /></label>
          <label>Account number<input name="accountNumber" placeholder="Account number" defaultValue={isLiveEnv ? '' : '215268129123'} /></label>
        </> : isGbp ? <>
          <label>Sort code<input name="sortCode" placeholder="Sort code" defaultValue={isLiveEnv ? '' : '123456'} /></label>
          <label>Account number<input name="gbAccountNumber" placeholder="Account number" defaultValue={isLiveEnv ? '' : '12345678'} /></label>
        </> : <>
          <label>IBAN<input name="ibanAccountNumber" placeholder="FR7630006000011234567890189" required /></label>
          <label>BIC / SWIFT<input name="bic" placeholder="AGRIFRPP" /></label>
          <label>Bank country<input name="ibanCountry" defaultValue="FRA" maxLength={3} /></label>
        </>}
        <button className="primary-btn" disabled={loading || !canCreatePaymentActions}>{loading ? 'Adding...' : canCreatePaymentActions ? 'Add bank account' : 'Temporarily unavailable'}</button>
      </form>
    </article>
  );
}

function BankList({ accounts }: { accounts: ExternalAccountRecord[] }) {
  if (!accounts.length) return <Empty>No bank account added yet.</Empty>;
  return <div className="list">{accounts.map((account) => <div className="list-item" key={account.id}><strong>{account.bankName || 'Bank account'} • {account.currency.toUpperCase()}</strong><Badge status={account.status}>{friendlyStatus(account.status)}</Badge><small>{account.paymentRail.replaceAll('_', ' ')} · ****{account.accountLast4 || '----'}</small></div>)}</div>;
}

function DepositCard({ result }: { result: DepositResponse | null }) {
  if (!result) return <article className="deposit-card"><p className="eyebrow">Deposit address</p><h3>Ready when you are</h3><p className="muted">Create a withdrawal to receive a deposit address. You will review the asset, network, fee, and payout currency before sending.</p></article>;
  return (
    <article className="deposit-card live-deposit-card">
      <p className="eyebrow">Step 3</p>
      <h3>Deposit address created</h3>
      <p className="muted">Send only {result.deposit.currency.toUpperCase()} on {result.deposit.chain}. Sending any other token, or using the wrong network, can permanently lose your funds and may not be recoverable. <a href={legalLinks.risk} target="_blank" rel="noreferrer">Read Risk Disclosure</a>.</p>
      <div className="qr-wrap premium-qr"><img src={qrUrl(result.deposit.address)} alt="Deposit address QR code" /><div><span className="address-label">Deposit address</span><div className="deposit-address">{result.deposit.address}</div><button className="secondary-btn" onClick={() => { navigator.clipboard?.writeText(result.deposit.address); }}>Copy address</button></div></div>
      <div className="details-box"><Kv label="Reference" value={shortRef(result.withdrawal.id)} /><Kv label="Payout currency" value={result.withdrawal.destinationCurrency.toUpperCase()} /><Kv label="Fee" value={`${result.withdrawal.feePercent || '0'}%`} /><Kv label="Status" value={friendlyStatus(result.withdrawal.status)} /></div>
      {result.withdrawal.transactionTimeline ? <InlineTransactionTimeline timeline={result.withdrawal.transactionTimeline} /> : <div className="tracking-timeline">
        <TimelineItem done title="Address created" body="A unique provider-backed deposit address is ready." />
        <TimelineItem active={result.withdrawal.status === 'pending_deposit'} done={result.withdrawal.status !== 'pending_deposit'} title="Awaiting deposit" body="Send only the selected token and network." />
        <TimelineItem active={['deposit_received', 'payout_processing'].includes(result.withdrawal.status)} done={result.withdrawal.status === 'completed'} title="Convert and payout" body="Bridge detects the deposit, liquidates, and sends fiat to your bank." />
        <TimelineItem done={result.withdrawal.status === 'completed'} title="Completed" body="Bank payout completed once provider status confirms." />
      </div>}
    </article>
  );
}

function TimelineItem({ title, body, done = false, active = false }: { title: string; body: string; done?: boolean; active?: boolean }) {
  return <div className={`timeline-item ${done ? 'done' : ''} ${active ? 'active' : ''}`}><span>{done ? '✓' : active ? '•' : ''}</span><div><strong>{title}</strong><small>{body}</small></div></div>;
}

function WithdrawalsList({ withdrawals, compact = false }: { withdrawals: WithdrawalRecord[]; compact?: boolean }) {
  return <article className="panel"><div className="panel-head"><div><p className="eyebrow">Withdrawals</p><h3>{compact ? 'Recent activity' : 'Withdrawal activity'}</h3></div></div>{!withdrawals.length ? <Empty>No withdrawals yet.</Empty> : compact ? <div className="list">{withdrawals.map((w) => <div className="list-item" key={w.id}><strong>{w.destinationCurrency.toUpperCase()} withdrawal</strong><Badge status={w.status}>{friendlyStatus(w.status)}</Badge><small>Reference {shortRef(w.id)}</small></div>)}</div> : <div className="table-wrap"><table className="table"><thead><tr><th>Reference</th><th>Status</th><th>Currency</th><th>Amount</th><th>Fee</th><th>Date</th></tr></thead><tbody>{withdrawals.map((w) => <tr key={w.id}><td>{shortRef(w.id)}</td><td><Badge status={w.status}>{friendlyStatus(w.status)}</Badge></td><td>{w.destinationCurrency.toUpperCase()}</td><td>{w.destinationAmount || '—'}</td><td>{w.feeAmount || (w.feePercent ? `${w.feePercent}%` : '—')}</td><td>{new Date(w.createdAt).toLocaleDateString()}</td></tr>)}</tbody></table></div>}</article>;
}

function UserGuidePanel() {
  return <article className="panel"><div className="panel-head"><div><p className="eyebrow">How it works</p><h3>A simple withdrawal flow</h3></div></div><div className="details-box"><Kv label="1" value="Create your account" /><Kv label="2" value="Complete verification" /><Kv label="3" value="Add your bank account" /><Kv label="4" value="Send the selected stablecoin to your deposit address" /><Kv label="5" value="Receive USD, GBP, or EUR in your bank account" /></div></article>;
}
