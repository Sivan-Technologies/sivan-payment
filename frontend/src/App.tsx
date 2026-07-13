import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import type { CustomerRecord, DepositResponse, ExternalAccountRecord, AssetControl, FeePolicy, NetworkControl, OfframpControls, PaymentControl, SystemStatus, UserRecord, ViewKey, WithdrawalRecord } from './types';

const views: Array<{ key: ViewKey; icon: string; label: string }> = [
  { key: 'overview', icon: '◇', label: 'Dashboard' },
  { key: 'withdraw', icon: '↗', label: 'New withdrawal' },
  { key: 'history', icon: '☷', label: 'Withdrawals' },
  { key: 'banks', icon: '▣', label: 'Bank accounts' },
  { key: 'kyc', icon: '◈', label: 'Verification' },
  { key: 'settings', icon: '⚙', label: 'Settings' },
  { key: 'help', icon: '?', label: 'Help' }
];

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
    kyc_approved: 'Verified',
    kyc_under_review: 'Under review',
    kyc_incomplete: 'Incomplete',
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

function initials(nameOrEmail?: string) {
  const value = nameOrEmail || 'User';
  const parts = value.includes('@') ? [value[0]] : value.trim().split(/\s+/);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'U';
}

function qrUrl(value: string) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(value)}`;
}

export default function App() {
  const [view, setView] = useState<ViewKey>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const apiBase = useMemo(() => import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000', []);
  const appEnv = import.meta.env.VITE_APP_ENV || 'local';
  const isLiveEnv = appEnv === 'live' || appEnv === 'production';
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [authToken, setAuthToken] = useState(() => localStorage.getItem('sivan.authToken') || '');
  const [authTab, setAuthTab] = useState<'signup' | 'signin'>('signup');
  const [pendingEmail, setPendingEmail] = useState('');
  const [devCode, setDevCode] = useState<string | undefined>();
  const [user, setUser] = useState<UserRecord | null>(() => readStorage<UserRecord | null>('sivan.user', null));
  const [customer, setCustomer] = useState<CustomerRecord | null>(() => readStorage<CustomerRecord | null>('sivan.customer', null));
  const [accounts, setAccounts] = useState<ExternalAccountRecord[]>(() => readStorage<ExternalAccountRecord[]>('sivan.accounts', []));
  const [withdrawals, setWithdrawals] = useState<WithdrawalRecord[]>([]);
  const [feePolicy, setFeePolicy] = useState<FeePolicy | null>(null);
  const [paymentControls, setPaymentControls] = useState<OfframpControls>({ payoutCurrencies: [], sourceAssets: [], sourceNetworks: [] });
  const [systemStatus, setSystemStatus] = useState<SystemStatus>({ id: 'global', mode: 'active', updatedAt: new Date().toISOString() });
  const [depositResult, setDepositResult] = useState<DepositResponse | null>(null);
  const [withdrawalReview, setWithdrawalReview] = useState<null | { userId: string; externalAccountId: string; sourceCurrency: string; sourceChain: string; destinationCurrency: string; returnAddress?: string; bankLabel: string; assetLabel: string; networkLabel: string }>(null);
  const [otpCode, setOtpCode] = useState('');
  const [loading, setLoading] = useState(false);

  const pageTitle = useMemo(() => views.find((item) => item.key === view)?.label ?? 'Home', [view]);
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
  };
  const enabledControls = paymentControls.payoutCurrencies.filter((control) => control.enabled);
  const enabledAssets = paymentControls.sourceAssets.filter((control) => control.enabled);
  const enabledNetworks = paymentControls.sourceNetworks.filter((control) => control.enabled);

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
    setView('overview');
    setToast({ message, type: 'success' });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const notify = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 4800);
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

  const loadControls = useCallback(async () => {
    const [controls, status] = await Promise.all([
      api<OfframpControls>('/api/offramp/controls').catch(() => ({ payoutCurrencies: [], sourceAssets: [], sourceNetworks: [] })),
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
    const refreshControls = () => {
      if (document.visibilityState === 'visible') void loadControls();
    };
    const interval = window.setInterval(refreshControls, 60_000);
    window.addEventListener('focus', refreshControls);
    document.addEventListener('visibilitychange', refreshControls);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshControls);
      document.removeEventListener('visibilitychange', refreshControls);
    };
  }, [loadControls]);

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
      setDevCode(result.devCode);
      notify(authTab === 'signup' ? 'Verification code sent. Enter it to create your account.' : 'Login code sent. Enter it to continue.');
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
      setView('overview');
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
    setLoading(true);
    try {
      const body = getForm(event.currentTarget);
      const created = await api<CustomerRecord>('/api/customers/kyc-link', {
        method: 'POST',
        body: JSON.stringify({ userId: user.id, type: body.type, redirectUri: body.redirectUri || undefined })
      });
      setCustomer(created);
      notify('Verification started. Complete verification to unlock withdrawals.');
      setView('banks');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function refreshKyc() {
    if (!user?.id) return notify('Create your account first.', 'error');
    try {
      const refreshed = await api<CustomerRecord>(`/api/customers/${user.id}/kyc-status`);
      setCustomer(refreshed);
      notify('Verification status refreshed.');
    } catch (error) {
      notify((error as Error).message, 'error');
    }
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
            <button className="secondary-btn" onClick={loadUserData} disabled={loading}>{loading ? 'Please wait...' : 'Refresh'}</button>
            {hasUser && <div className="user-menu-wrap"><button className="avatar-button" onClick={() => setUserMenuOpen((open) => !open)}>{initials(user?.fullName || user?.email)}</button>{userMenuOpen && <div className="user-menu"><button onClick={() => goToView('settings')}>Settings</button><button onClick={() => logout('Signed out successfully.')}>Sign out</button></div>}</div>}
          </div>
        </header>

        {toast && <section className={`toast ${toast.type === 'error' ? 'error' : ''}`}>{toast.message}</section>}

        {systemStatus.mode !== 'active' && <section className="maintenance-banner"><strong>{systemStatus.mode === 'maintenance' ? 'Maintenance mode' : 'Payments paused'}</strong><span>{systemStatus.message || (systemStatus.mode === 'maintenance' ? 'New withdrawals are temporarily unavailable while maintenance is in progress.' : 'New payment actions are temporarily paused.')}</span>{systemStatus.estimatedResumeAt && <small>Estimated resume: {new Date(systemStatus.estimatedResumeAt).toLocaleString()}</small>}</section>}

        {view === 'overview' && (
          <section className="view active dashboard-view">
            <div className="status-strip">
              <div>
                <p className="eyebrow">Next step</p>
                <h3>{hasUser ? activeStep === 'Ready to withdraw' ? 'You are ready to create a withdrawal' : `Finish setup: ${activeStep}` : 'Create your account to start withdrawing'}</h3>
                <p>{hasUser ? 'Complete each setup step once, then withdraw supported stablecoins to your bank account.' : 'Create an account, verify, add your bank, and get a deposit address in a guided flow.'}</p>
              </div>
              <button className="primary-btn animated-cta" onClick={() => goToView(nextStepView)}>{nextStepLabel}</button>
            </div>

            <div className="stats-grid">
              <Stat label="Account" value={hasUser ? 'Created' : 'Not started'} helper={user?.email || 'Start with your email'} />
              <Stat label="Verification" value={friendlyStatus(customer?.kycStatus)} helper="Required for withdrawals" />
              <Stat label="Bank accounts" value={String(accounts.length)} helper="Bank accounts you can send to" />
              <Stat label="Payout methods" value={enabledControls.map((c) => c.currency.toUpperCase()).join(', ') || '—'} helper={feePolicy ? `${feePolicy.percent}% fee before deposit` : 'Shown before you deposit'} />
            </div>

            <div className="panel-grid two dashboard-grid">
              <SetupChecklist hasUser={hasUser} isVerified={isVerified} hasBank={hasBank} onContinue={() => goToView(nextStepView)} nextStepLabel={nextStepLabel} />
              <QuickActionCard hasUser={hasUser} isVerified={isVerified} hasBank={hasBank} onContinue={() => goToView(nextStepView)} />
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
                <button className={authTab === 'signup' ? 'active' : ''} onClick={() => { setAuthTab('signup'); setPendingEmail(''); setOtpCode(''); setDevCode(undefined); }}>Create account</button>
                <button className={authTab === 'signin' ? 'active' : ''} onClick={() => { setAuthTab('signin'); setPendingEmail(''); setOtpCode(''); setDevCode(undefined); }}>Sign in</button>
              </div>
              {!pendingEmail ? (
                <form className="form" onSubmit={handleEmailAuthStart}>
                  <label>Email<input name="email" type="email" placeholder="you@example.com" required /></label>
                  {authTab === 'signup' && <label>Full name<input name="fullName" placeholder="Ada Lovelace" required /></label>}
                  <button className="primary-btn" disabled={loading}>{loading ? 'Sending...' : authTab === 'signup' ? 'Send verification code' : 'Send login code'}</button>
                </form>
              ) : (
                <form className="form" onSubmit={handleEmailAuthVerify}>
                  <OtpInput value={otpCode} onChange={setOtpCode} />
                  {devCode && <div className="dev-code">Test code: <strong>{devCode}</strong></div>}
                  <button className="primary-btn" disabled={loading}>{loading ? 'Checking...' : 'Continue'}</button>
                  <button type="button" className="ghost-btn" onClick={() => { setPendingEmail(''); setOtpCode(''); setDevCode(undefined); }}>Use another email</button>
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
                <form className="form" onSubmit={handleKyc}>
                  <label>Account type<select name="type" defaultValue="individual"><option value="individual">Individual</option><option value="business">Business</option></select></label>
                  <input name="redirectUri" type="hidden" value="https://sivan-payments-user-test.vercel.app/verification-complete" />
                  <button className="primary-btn" disabled={loading || !canStartKyc}>{loading ? 'Starting...' : canStartKyc ? 'Start verification' : 'Verification paused'}</button>
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

        {view === 'history' && <WithdrawalsList withdrawals={withdrawals} />}

        {view === 'settings' && <SettingsView user={user} onLogout={() => logout('Signed out successfully.')} />}
        {view === 'help' && <HelpView />}

      </main>
    </div>
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
  return <div className="details-box"><Kv label="Status" value={friendlyStatus(customer.kycStatus)} /><Kv label="Account type" value={customer.customerType || 'individual'} /><Kv label="Terms" value={customer.tosStatus || 'Pending'} />{customer.kycLink && <Kv label="Verification link" value={customer.kycLink} />}</div>;
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
