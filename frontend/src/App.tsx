import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import type { CustomerRecord, DepositResponse, ExternalAccountRecord, AssetControl, FeePolicy, NetworkControl, OfframpControls, PaymentControl, SystemStatus, UserRecord, ViewKey, WithdrawalRecord } from './types';

const views: Array<{ key: ViewKey; icon: string; label: string }> = [
  { key: 'overview', icon: '◇', label: 'Dashboard' },
  { key: 'withdraw', icon: '↗', label: 'Sell stablecoins' },
  { key: 'buy', icon: '↙', label: 'Buy stablecoins' },
  { key: 'history', icon: '☷', label: 'Withdrawals' },
  { key: 'banks', icon: '▣', label: 'Bank accounts' },
  { key: 'kyc', icon: '◈', label: 'Verification' },
  { key: 'settings', icon: '⚙', label: 'Settings' },
  { key: 'help', icon: '?', label: 'Help' }
];

const pathByView: Record<ViewKey, string> = {
  landing: '/',
  overview: '/dashboard',
  withdraw: '/withdraw',
  buy: '/buy',
  history: '/withdrawals',
  banks: '/bank-accounts',
  kyc: '/verification',
  settings: '/settings',
  help: '/help',
  signup: '/signup'
};

function viewFromPath(pathname: string): ViewKey {
  const clean = pathname.replace(/\/$/, '') || '/';
  if (clean === '/dashboard' || clean === '/app') return 'overview';
  if (clean === '/withdraw' || clean === '/app/sell') return 'withdraw';
  if (clean === '/buy' || clean === '/on-ramp' || clean === '/app/buy') return 'buy';
  if (clean === '/withdrawals' || clean === '/history' || clean === '/app/transactions') return 'history';
  if (clean === '/bank-accounts' || clean === '/banks' || clean === '/app/payment-methods') return 'banks';
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

const fallbackCustomerTypes = [
  { customerType: 'individual' as const, enabled: true, label: 'Individual', updatedAt: new Date().toISOString() },
  { customerType: 'business' as const, enabled: false, label: 'Business', updatedAt: new Date().toISOString() }
];

const fallbackSourceAssets: AssetControl[] = [
  { asset: 'usdc', enabled: true, label: 'USDC', updatedAt: new Date().toISOString() },
  { asset: 'usdt', enabled: false, label: 'USDT', updatedAt: new Date().toISOString() }
];

const fallbackSourceNetworks: NetworkControl[] = [
  { network: 'base', enabled: true, label: 'Base', sortOrder: 10, updatedAt: new Date().toISOString() },
  { network: 'polygon', enabled: true, label: 'Polygon', sortOrder: 20, updatedAt: new Date().toISOString() },
  { network: 'ethereum', enabled: true, label: 'Ethereum', sortOrder: 30, updatedAt: new Date().toISOString() },
  { network: 'solana', enabled: true, label: 'Solana', sortOrder: 40, updatedAt: new Date().toISOString() },
  { network: 'arbitrum', enabled: true, label: 'Arbitrum', sortOrder: 50, updatedAt: new Date().toISOString() },
  { network: 'avalanche_c_chain', enabled: true, label: 'Avalanche C-Chain', sortOrder: 60, updatedAt: new Date().toISOString() }
];

function normalizeOfframpControls(value: unknown): OfframpControls {
  const data = value as Partial<OfframpControls> | PaymentControl[] | undefined;
  if (Array.isArray(data)) {
    return {
      customerTypes: fallbackCustomerTypes,
      payoutCurrencies: data,
      sourceAssets: fallbackSourceAssets,
      sourceNetworks: fallbackSourceNetworks
    };
  }
  return {
    customerTypes: data?.customerTypes ?? fallbackCustomerTypes,
    payoutCurrencies: data?.payoutCurrencies ?? [],
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

export default function App() {
  const [view, setView] = useState<ViewKey>(() => viewFromPath(window.location.pathname));
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const apiBase = useMemo(() => import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000', []);
  const appEnv = import.meta.env.VITE_APP_ENV || 'local';
  const isLiveEnv = appEnv === 'live' || appEnv === 'production';
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [authToken, setAuthToken] = useState(() => localStorage.getItem('sivan.authToken') || '');
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
  const [feePolicy, setFeePolicy] = useState<FeePolicy | null>(null);
  const [paymentControls, setPaymentControls] = useState<OfframpControls>({ customerTypes: fallbackCustomerTypes, payoutCurrencies: [], sourceAssets: [], sourceNetworks: [] });
  const [systemStatus, setSystemStatus] = useState<SystemStatus>({ id: 'global', mode: 'active', updatedAt: new Date().toISOString() });
  const [depositResult, setDepositResult] = useState<DepositResponse | null>(null);
  const [withdrawalReview, setWithdrawalReview] = useState<null | { userId: string; externalAccountId: string; sourceCurrency: string; sourceChain: string; destinationCurrency: string; returnAddress?: string; bankLabel: string; assetLabel: string; networkLabel: string }>(null);
  const [otpCode, setOtpCode] = useState('');
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
    const nextPath = pathByView[nextView] ?? '/dashboard';
    if (window.location.pathname !== nextPath) window.history.pushState({}, '', nextPath);
  };
  const enabledCustomerTypes = (paymentControls.customerTypes ?? fallbackCustomerTypes).filter((control) => control.enabled);
  const enabledControls = (paymentControls.payoutCurrencies ?? []).filter((control) => control.enabled);
  const enabledAssets = (paymentControls.sourceAssets ?? []).filter((control) => control.enabled);
  const enabledNetworks = (paymentControls.sourceNetworks ?? []).filter((control) => control.enabled);
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
  const completedWithdrawalCount = withdrawals.filter((withdrawal) => withdrawal.status === 'completed').length;
  const primaryAssetLabel = enabledAssets.map((asset) => asset.label).join(', ') || 'USDC';
  const primaryNetworkLabel = enabledNetworks.slice(0, 3).map((network) => network.label).join(', ') || 'Base';

  const logout = useCallback((message = 'You have been signed out.') => {
    setAuthToken('');
    setUser(null);
    setCustomer(null);
    setAccounts([]);
    setWithdrawals([]);
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
    setDevCode(undefined);
    setResendAvailableAt(0);
  }, []);

  const api = useCallback(async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...(options.headers || {})
      }
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && authToken) logout('Session expired. Please sign in again.');
      throw new Error(json?.error?.message || 'Something went wrong. Please try again.');
    }
    return (json.data ?? json) as T;
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
    const [customerResult, accountsResult, withdrawalsResult] = await Promise.allSettled([
      api<CustomerRecord>(`/api/customers/${user.id}`),
      api<ExternalAccountRecord[]>(`/api/users/${user.id}/external-accounts`),
      api<WithdrawalRecord[]>(`/api/users/${user.id}/withdrawals`)
    ]);
    if (customerResult.status === 'fulfilled') setCustomer(customerResult.value);
    if (accountsResult.status === 'fulfilled') setAccounts(accountsResult.value);
    if (withdrawalsResult.status === 'fulfilled') setWithdrawals(withdrawalsResult.value);
  }, [api, user?.id, authToken]);

  const refreshKycStatus = useCallback(async (showToast = false) => {
    if (!user?.id || !authToken) {
      if (showToast) notify('Create or sign in to your account first.', 'error');
      return null;
    }
    try {
      const refreshed = await api<CustomerRecord>(`/api/customers/${user.id}/kyc-status`);
      setCustomer(refreshed);
      if (showToast) notify('Verification status refreshed.');
      return refreshed;
    } catch (error) {
      if (showToast) notify((error as Error).message, 'error');
      return null;
    }
  }, [api, authToken, notify, user?.id]);

  const loadControls = useCallback(async () => {
    const [controls, status] = await Promise.all([
      api<unknown>('/api/offramp/controls').then(normalizeOfframpControls).catch(() => ({ customerTypes: fallbackCustomerTypes, payoutCurrencies: [], sourceAssets: fallbackSourceAssets, sourceNetworks: fallbackSourceNetworks })),
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
    const interval = window.setInterval(refreshControls, 10_000);
    window.addEventListener('focus', refreshControls);
    document.addEventListener('visibilitychange', refreshControls);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshControls);
      document.removeEventListener('visibilitychange', refreshControls);
    };
  }, [loadControls]);

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
      void loadUserData();
      void refreshKycStatus(false);
      notify('Welcome back. We are checking your verification status.');
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
          intent: authTab
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
          intent: authTab
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
      const result = await api<{ token: string; user: UserRecord; expiresInMinutes: number }>('/api/auth/email/verify', {
        method: 'POST',
        body: JSON.stringify({ email: pendingEmail, code: body.code || otpCode })
      });
      setAuthToken(result.token);
      setUser(result.user);
      setPendingEmail('');
      setOtpCode('');
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
        body: JSON.stringify({ userId: user.id, type: body.type, redirectUri: body.redirectUri || undefined })
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

  if (view === 'landing') {
    return <LandingPage
      isLiveEnv={isLiveEnv}
      appEnv={appEnv}
      hasUser={hasUser}
      assets={primaryAssetLabel}
      networks={primaryNetworkLabel}
      payoutCurrencies={enabledControls.map((control) => control.currency.toUpperCase()).join(', ') || 'USD, GBP, EUR'}
      onGetStarted={() => goToView(hasUser ? 'overview' : 'signup')}
      onDashboard={() => goToView('overview')}
      onBuy={() => goToView('buy')}
    />;
  }

  return (
    <div className={`app-shell ${mobileMenuOpen ? 'menu-open' : ''}`}>
      <button className="mobile-menu-overlay" aria-label="Close menu" onClick={() => setMobileMenuOpen(false)} />
      <aside className={`sidebar ${mobileMenuOpen ? 'open' : ''}`}>
        <button className="mobile-menu-close" aria-label="Close menu" onClick={() => setMobileMenuOpen(false)}>×</button>
        <div className="brand">
          <img className="brand-logo" src="/asset/sivan-logo.png" alt="Sivan logo" />
          <div>
            <h1>Sivan</h1>
          </div>
        </div>

        <nav className="nav">
          {views.map((item) => (
            <button key={item.key} className={`nav-item ${view === item.key ? 'active' : ''}`} onClick={() => goToView(item.key)}>
              <span>{item.icon}</span> {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-status"><span></span>{isLiveEnv ? 'Live' : appEnv === 'test' ? 'Test environment' : 'Local'}</div>
          <div className="sidebar-links">
            <button onClick={() => goToView('help')}>Support</button>
            <a href="https://www.sivantech.online/" target="_blank" rel="noreferrer">Terms</a>
            <a href="https://www.sivantech.online/" target="_blank" rel="noreferrer">Privacy</a>
          </div>
          <small>© 2026 Sivan</small>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="mobile-menu-button" aria-label="Open menu" onClick={() => setMobileMenuOpen(true)}><span></span><span></span><span></span></button>
          <div>
            <p className="eyebrow">Stablecoin to bank</p>
            <h2>{pageTitle}</h2>
          </div>
          <div className="top-actions">
            <div className={`status-pill ${appEnv === 'test' ? 'warning' : 'ok'}`}><span /> {environmentLabel}</div>
            
            {hasUser && <div className="user-menu-wrap"><button className="avatar-button" onClick={() => setUserMenuOpen((open) => !open)}>{initials(user?.fullName || user?.email)}</button>{userMenuOpen && <div className="user-menu"><button onClick={() => goToView('settings')}>Settings</button><button onClick={() => logout('Signed out successfully.')}>Sign out</button></div>}</div>}
          </div>
        </header>

        {toast && <section className={`toast ${toast.type === 'error' ? 'error' : ''}`}>{toast.message}</section>}

        {systemStatus.mode !== 'active' && <section className="maintenance-banner"><strong>{systemStatus.mode === 'maintenance' ? 'Maintenance mode' : 'Payments paused'}</strong><span>{systemStatus.message || (systemStatus.mode === 'maintenance' ? 'New withdrawals are temporarily unavailable while maintenance is in progress.' : 'New payment actions are temporarily paused.')}</span>{systemStatus.estimatedResumeAt && <small>Estimated resume: {new Date(systemStatus.estimatedResumeAt).toLocaleString()}</small>}</section>}

        {view === 'overview' && (
          <section className="view active dashboard-view fintech-dashboard">
            <div className={`welcome-card ${isVerified ? 'ok' : 'warn'}`}>
              <div>
                <p className="eyebrow">Account command center</p>
                <h3>{hasUser ? isVerified ? `Welcome back, ${firstName}.` : `Finish setup, ${firstName}.` : 'Start your Sivan account.'}</h3>
                <p>{hasUser ? isVerified && hasBank ? 'You are ready to sell supported stablecoins to your verified bank account.' : 'Complete verification and add a verified bank account before creating your first deposit address.' : 'Create an account, verify once, add your bank, then receive bank payouts from supported stablecoins.'}</p>
              </div>
              <button className="primary-btn animated-cta" onClick={() => goToView(nextStepView)}>{nextStepLabel}</button>
            </div>

            <div className="quick-actions-grid">
              <button className="quick-action-tile sell" onClick={() => goToView('withdraw')}>
                <span className="tile-icon">↗</span><strong>Sell stablecoins</strong><small>Send {primaryAssetLabel} and receive fiat to bank</small><em>Start</em>
              </button>
              <button className="quick-action-tile buy" onClick={() => goToView('buy')}>
                <span className="tile-icon">↙</span><strong>Buy stablecoins</strong><small>On-ramp experience prepared for provider rollout</small><em>View</em>
              </button>
              <button className="quick-action-tile" onClick={() => goToView('banks')}>
                <span className="tile-icon">▣</span><strong>Bank accounts</strong><small>{hasBank ? `${accounts.length} verified account${accounts.length === 1 ? '' : 's'}` : 'Add your payout destination'}</small><em>Manage</em>
              </button>
            </div>

            <div className="kpi-grid">
              <Stat label="Setup" value={`${setupPercent}%`} helper={activeStep} />
              <Stat label="Verification" value={friendlyStatus(customer?.kycStatus)} helper="Required before bank payouts" />
              <Stat label="Bank accounts" value={String(accounts.length)} helper="Verified payout destinations" />
              <Stat label="Completed payouts" value={String(completedWithdrawalCount)} helper={feePolicy ? `${feePolicy.percent}% Sivan fee` : 'Fee shown before deposit'} />
            </div>

            <div className="panel-grid two dashboard-grid">
              <SetupChecklist hasUser={hasUser} isVerified={isVerified} hasBank={hasBank} onContinue={() => goToView(nextStepView)} nextStepLabel={nextStepLabel} />
              <RailsCard enabledControls={enabledControls} enabledAssets={enabledAssets} enabledNetworks={enabledNetworks} />
              <WithdrawalsList withdrawals={withdrawals.slice(0, 4)} compact />
              <NeedHelpCard />
            </div>
          </section>
        )}


        {view === 'signup' && (
          <section className="form-layout">
            <article className="panel form-panel">
              <p className="eyebrow">Secure access</p>
              <h3>{authTab === 'signup' ? 'Create your account' : 'Welcome back'}</h3>
              <p className="muted">Use passwordless email access. We will send a short verification code.</p>
              <div className="auth-tabs">
                <button className={authTab === 'signup' ? 'active' : ''} onClick={() => { setAuthTab('signup'); resetPendingEmail(); }}>Create account</button>
                <button className={authTab === 'signin' ? 'active' : ''} onClick={() => { setAuthTab('signin'); resetPendingEmail(); }}>Sign in</button>
              </div>
              {!pendingEmail ? (
                <form className="form" onSubmit={handleEmailAuthStart}>
                  <label>Email<input name="email" type="email" placeholder="you@example.com" required /></label>
                  {authTab === 'signup' && <label>Full name<input name="fullName" placeholder="Ada Lovelace" required /></label>}
                  <button className="primary-btn" disabled={loading}>{loading ? 'Sending...' : authTab === 'signup' ? 'Send verification code' : 'Send login code'}</button>
                </form>
              ) : (
                <form className="form" onSubmit={handleEmailAuthVerify}>
                  <div className="email-confirmation">
                    <span>Code sent to</span>
                    <strong>{pendingEmail}</strong>
                    <button type="button" onClick={resetPendingEmail}>Change email</button>
                  </div>
                  <OtpInput value={otpCode} onChange={setOtpCode} />
                  {devCode && <div className="dev-code">Test code: <strong>{devCode}</strong></div>}
                  <button className="primary-btn" disabled={loading || otpCode.length < 6}>{loading ? 'Checking...' : 'Continue'}</button>
                  <button type="button" className="ghost-btn" disabled={loading || resendSeconds > 0} onClick={handleResendCode}>{resendSeconds > 0 ? `Resend code in ${resendSeconds}s` : 'Resend code'}</button>
                </form>
              )}
            </article>
            <article className="premium-card">
              <span className="orb" />
              <h3>Fast access, no passwords.</h3>
              <p>Sign in securely with your email today. WhatsApp sign-in will be added for existing escrow users later.</p>
              <ul><li>Passwordless login</li><li>Auto logout after inactivity</li><li>Web and WhatsApp-ready identity</li></ul>
            </article>
          </section>
        )}


        {view === 'kyc' && (
          <section className="panel-grid two">
            <article className="panel form-panel">
              <p className="eyebrow">Step 2</p>
              <h3>Verify your identity</h3>
              <p className="muted">Verification helps protect your account and enables bank withdrawals.</p>
              {!hasUser ? <Empty>Create your account first.</Empty> : (
                <form className="form" onSubmit={handleKyc} key={customer?.id || 'new-verification'}>
                  <label>Account type<select name="type" defaultValue={customer?.customerType || 'individual'} disabled={Boolean(customer?.id && !kycFailed)}>{(paymentControls.customerTypes ?? fallbackCustomerTypes).map((type) => <option key={type.customerType} value={type.customerType} disabled={!type.enabled}>{type.label}{!type.enabled ? ' — currently unavailable' : ''}</option>)}</select></label>
                  {customer?.id && !kycFailed && <p className="form-note">Your verification has already started. Continue with the same account type, or contact support if you need to change it.</p>}
                  <input name="redirectUri" type="hidden" value={verificationRedirectUri} />
                  <button className="primary-btn" disabled={!canSubmitKyc}>{kycActionLabel}</button>
                </form>
              )}
            </article>
            <article className="panel">
              <div className="panel-head"><h3>Verification status</h3><button className="ghost-btn small" onClick={refreshKyc}>Refresh</button></div>
              {customer ? <CustomerDetails customer={customer} /> : <Empty>No verification started yet.</Empty>}
            </article>
          </section>
        )}

        {view === 'banks' && (
          <section className="panel-grid two">
            <BankForm onSubmit={handleBank} loading={loading} isVerified={isVerified} controls={enabledControls} canCreatePaymentActions={canCreatePaymentActions} isLiveEnv={isLiveEnv} />
            <article className="panel">
              <div className="panel-head"><h3>Your bank accounts</h3><button className="ghost-btn small" onClick={loadUserData}>Refresh</button></div>
              <BankList accounts={accounts} />
            </article>
          </section>
        )}

        {view === 'withdraw' && (
          <section className="panel-grid two">
            <article className="panel form-panel">
              <p className="eyebrow">New withdrawal</p>
              <h3>Withdraw stablecoins</h3>
              <p className="muted">Choose a verified bank account, asset, and network before creating a deposit address.</p>
              {!accounts.some((account) => enabledControls.some((control) => control.currency === account.currency)) ? <Empty>Add an enabled bank account first.</Empty> : !enabledAssets.length || !enabledNetworks.length ? <Empty>Deposits are temporarily unavailable.</Empty> : (
                <form className="form" onSubmit={handleWithdraw}>
                  <label>Bank account<select name="externalAccountId" defaultValue={primaryAccount?.id}>{accounts.filter((account) => enabledControls.some((control) => control.currency === account.currency)).map((account) => <option key={account.id} value={account.id}>{account.bankName || 'Bank account'} · {account.currency.toUpperCase()} · ****{account.accountLast4 || '----'}</option>)}</select></label>
                  <label>Deposit asset<select name="sourceCurrency" defaultValue={enabledAssets[0]?.asset || 'usdc'}>{enabledAssets.map((asset) => <option key={asset.asset} value={asset.asset}>{asset.label}</option>)}</select></label>
                  <label>Deposit network<select name="sourceChain" defaultValue={enabledNetworks[0]?.network || 'base'}>{enabledNetworks.map((network) => <option key={network.network} value={network.network}>{network.label}</option>)}</select></label>
                  <label>Refund wallet address<input name="returnAddress" placeholder="Wallet address for returned funds" defaultValue="0x0000000000000000000000000000000000000000" /></label>
                  <button className="primary-btn" disabled={loading || !canCreatePaymentActions}>{loading ? 'Creating...' : canCreatePaymentActions ? 'Get deposit address' : 'Withdrawals paused'}</button>
                </form>
              )}
            </article>
            <WithdrawalReviewCard review={withdrawalReview} feePercent={feePolicy?.percent} loading={loading} onCancel={() => setWithdrawalReview(null)} onConfirm={confirmWithdrawal} />
            {!withdrawalReview && <DepositCard result={depositResult} />}
          </section>
        )}

        {view === 'buy' && <OnRampView hasUser={hasUser} isVerified={isVerified} onGetStarted={() => goToView(hasUser ? isVerified ? 'banks' : 'kyc' : 'signup')} />}

        {view === 'history' && <WithdrawalsList withdrawals={withdrawals} />}

        {view === 'settings' && <SettingsView user={user} onLogout={() => logout('Signed out successfully.')} />}
        {view === 'help' && <HelpView />}

      </main>
    </div>
  );
}


function LandingPage({ isLiveEnv, appEnv, hasUser, assets, networks, payoutCurrencies, onGetStarted, onDashboard, onBuy }: { isLiveEnv: boolean; appEnv: string; hasUser: boolean; assets: string; networks: string; payoutCurrencies: string; onGetStarted: () => void; onDashboard: () => void; onBuy: () => void }) {
  return (
    <div className="landing-shell">
      <header className="landing-nav">
        <a className="landing-brand" href="https://www.sivantech.online/" aria-label="Sivan home">
          <img src="/asset/sivan-logo.png" alt="Sivan" /><strong>Sivan</strong>
        </a>
        <nav>
          <a href="#how">How it works</a>
          <a href="#rails">Rails</a>
          <a href="#safety">Safety</a>
          <button className="ghost-btn" onClick={onDashboard}>Open dashboard</button>
          <button className="primary-btn" onClick={onGetStarted}>{hasUser ? 'Continue' : 'Get started'}</button>
        </nav>
      </header>

      <main>
        <section className="landing-hero">
          <div className="landing-copy">
            <p className="eyebrow">Stablecoin to bank</p>
            <h1>Stablecoin to bank, made simple.</h1>
            <p className="lead">Send supported stablecoins and receive {payoutCurrencies} in your verified bank account. Built with guided verification, network controls, and clear deposit instructions.</p>
            <div className="landing-actions">
              <button className="primary-btn" onClick={onGetStarted}>{hasUser ? 'Go to dashboard' : 'Get started'}</button>
              <button className="secondary-btn" onClick={onDashboard}>Open dashboard</button>
            </div>
            <div className="landing-trust"><span>Licensed-provider rails</span><span>No password required</span><span>NGN coming soon</span></div>
          </div>
          <div className="landing-widget">
            <div className="widget-tabs"><span className="active">Sell</span><button onClick={onBuy}>Buy</button></div>
            <div className="mock-flow-card">
              <div><small>You send</small><strong>{assets}</strong><span>{networks}</span></div>
              <div className="flow-arrow">→</div>
              <div><small>You receive</small><strong>{payoutCurrencies}</strong><span>To your bank account</span></div>
            </div>
            <div className="deposit-preview"><span>Unique deposit address</span><code>0x7a9c…42f8</code></div>
            <p>Choose a bank account, asset, and network. Sivan generates a provider-backed deposit address for that off-ramp.</p>
          </div>
        </section>

        <section className="landing-strip" id="rails">
          <span>Assets: {assets}{assets.toLowerCase().includes('usdt') ? '' : ' · USDT ready when enabled'}</span>
          <span>Payouts: {payoutCurrencies}</span>
          <span>Networks: {networks} + more controlled by admin</span>
        </section>

        <section className="landing-section" id="how">
          <div className="section-head"><p className="eyebrow">How it works</p><h2>Four guided steps from wallet to bank.</h2></div>
          <div className="landing-card-grid">
            <InfoCard n="01" title="Create your account" body="Use secure passwordless email access. No password to manage." />
            <InfoCard n="02" title="Verify once" body="Complete Individual verification, or Business onboarding when enabled by Sivan controls." />
            <InfoCard n="03" title="Add your bank" body="Add a verified bank account for enabled payout currencies." />
            <InfoCard n="04" title="Send stablecoins" body="Create a deposit address, send only the selected asset/network, and track your payout." />
          </div>
        </section>

        <section className="landing-section split-landing" id="safety">
          <div><p className="eyebrow">On-ramp roadmap</p><h2>Buy stablecoins is part of the product direction.</h2><p className="muted">The UI is prepared for on-ramp flows, while production actions stay gated until backend/provider rails are ready. That keeps the app honest without blocking the future experience.</p><button className="secondary-btn" onClick={onBuy}>Preview buy flow</button></div>
          <div className="safety-panel"><strong>Safety rule</strong><p>Always send only the selected token on the selected network. Sending another token or using the wrong network can permanently lose funds and may not be recoverable.</p><small>{appEnv === 'test' ? '⚠ Test environment — no real money moves' : isLiveEnv ? '● Live environment' : 'Local environment'}</small></div>
        </section>
      </main>
    </div>
  );
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
      <div className="warning-box">Send only {review.assetLabel} on {review.networkLabel}. Sending any other token, or using the wrong network, can permanently lose your funds and may not be recoverable.</div>
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

function SettingsView({ user, onLogout }: { user: UserRecord | null; onLogout: () => void }) {
  return <section className="panel-grid two"><article className="panel"><p className="eyebrow">Profile</p><h3>Account settings</h3><div className="details-box"><Kv label="Name" value={user?.fullName || '—'} /><Kv label="Email" value={user?.email || '—'} /><Kv label="Security" value="Passwordless email" /></div></article><article className="panel"><p className="eyebrow">Session</p><h3>Security</h3><p className="muted">You are automatically signed out after 30 minutes of inactivity.</p><button className="secondary-btn" onClick={onLogout}>Sign out</button></article></section>;
}

function HelpView() {
  return <section className="panel-grid two"><article className="panel"><p className="eyebrow">Help</p><h3>Before you send funds</h3><div className="details-box"><Kv label="Token" value="Send only the selected asset" /><Kv label="Network" value="Use only the selected network" /><Kv label="Bank" value="Use a bank account you own" /><Kv label="Support" value="support@sivantech.online" /></div></article><article className="panel"><p className="eyebrow">Resources</p><h3>Legal and support</h3><div className="details-box"><Kv label="Terms" value="sivantech.online" /><Kv label="Privacy" value="sivantech.online" /><Kv label="Response time" value="Usually within 24 hours" /></div></article></section>;
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
  const actionLabel = approved ? 'Verification complete' : underReview ? 'Review in progress' : 'Open secure verification page';
  return (
    <div className="details-box verification-details">
      <Kv label="Status" value={friendlyStatus(customer.kycStatus)} />
      <Kv label="Account type" value={customer.customerType === 'business' ? 'Business' : 'Individual'} />
      <Kv label="Terms" value={customer.tosStatus ? friendlyStatus(customer.tosStatus) : 'Pending'} />
      {verificationLink && !approved && !underReview && (
        <div className="verification-link-card">
          <div>
            <span>Secure verification page</span>
            <strong>Ready to continue</strong>
            <small>Opens in a new tab. Your long secure link is hidden so this page stays clean.</small>
          </div>
          <a className="secondary-btn" href={verificationLink} target="_blank" rel="noreferrer">{actionLabel}</a>
        </div>
      )}
      {termsLink && !termsApproved && (
        <div className="verification-link-card terms-card">
          <div>
            <span>Terms required</span>
            <strong>Accept terms to finish verification</strong>
            <small>Bridge is still reporting Terms as pending. Complete this step, then return here and the status will refresh automatically.</small>
          </div>
          <a className="secondary-btn" href={termsLink} target="_blank" rel="noreferrer">Accept terms</a>
        </div>
      )}
      {!approved && !underReview && !termsApproved && <div className="verification-note">If you already finished the identity check, Terms may still be pending. Accept the terms above and allow Bridge a few moments for post-processing.</div>}
      {underReview && <div className="verification-note success-note">Your verification is under review. We will update your account as soon as it is approved.</div>}
      {approved && <div className="verification-note success-note">You are verified. You can now add a bank account and withdraw stablecoins.</div>}
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
  return <article className="deposit-card"><p className="eyebrow">Send selected asset</p><h3>Deposit address created</h3><p className="muted">Send only {result.deposit.currency.toUpperCase()} on {result.deposit.chain}. Sending any other token, or using the wrong network, can permanently lose your funds and may not be recoverable.</p><p className="muted">We will convert it and send {result.withdrawal.destinationCurrency.toUpperCase()} to your selected bank account.</p><div className="qr-wrap"><img src={qrUrl(result.deposit.address)} alt="Deposit address QR code" /><div className="deposit-address">{result.deposit.address}</div></div><button className="secondary-btn" onClick={() => { navigator.clipboard?.writeText(result.deposit.address); }}>Copy address</button><Kv label="Reference" value={shortRef(result.withdrawal.id)} /><Kv label="Fee" value={`${result.withdrawal.feePercent || '0'}%`} /><Kv label="Status" value={friendlyStatus(result.withdrawal.status)} /></article>;
}

function WithdrawalsList({ withdrawals, compact = false }: { withdrawals: WithdrawalRecord[]; compact?: boolean }) {
  return <article className="panel"><div className="panel-head"><div><p className="eyebrow">Withdrawals</p><h3>{compact ? 'Recent activity' : 'Withdrawal activity'}</h3></div></div>{!withdrawals.length ? <Empty>No withdrawals yet.</Empty> : compact ? <div className="list">{withdrawals.map((w) => <div className="list-item" key={w.id}><strong>{w.destinationCurrency.toUpperCase()} withdrawal</strong><Badge status={w.status}>{friendlyStatus(w.status)}</Badge><small>Reference {shortRef(w.id)}</small></div>)}</div> : <div className="table-wrap"><table className="table"><thead><tr><th>Reference</th><th>Status</th><th>Currency</th><th>Amount</th><th>Fee</th><th>Date</th></tr></thead><tbody>{withdrawals.map((w) => <tr key={w.id}><td>{shortRef(w.id)}</td><td><Badge status={w.status}>{friendlyStatus(w.status)}</Badge></td><td>{w.destinationCurrency.toUpperCase()}</td><td>{w.destinationAmount || '—'}</td><td>{w.feeAmount || (w.feePercent ? `${w.feePercent}%` : '—')}</td><td>{new Date(w.createdAt).toLocaleDateString()}</td></tr>)}</tbody></table></div>}</article>;
}

function UserGuidePanel() {
  return <article className="panel"><div className="panel-head"><div><p className="eyebrow">How it works</p><h3>A simple withdrawal flow</h3></div></div><div className="details-box"><Kv label="1" value="Create your account" /><Kv label="2" value="Complete verification" /><Kv label="3" value="Add your bank account" /><Kv label="4" value="Send the selected stablecoin to your deposit address" /><Kv label="5" value="Receive USD, GBP, or EUR in your bank account" /></div></article>;
}
