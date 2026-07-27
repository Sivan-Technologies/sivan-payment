import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import type { CustomerRecord, DepositResponse, ExternalAccountRecord, AssetControl, FeePolicy, NetworkControl, OfframpControls, PaymentControl, SystemStatus, UserRecord, ViewKey, WithdrawalRecord, OnrampOrderRecord, SupportTicketRecord, UserPreferencesRecord, IdentityStatus, TransactionTimeline, VirtualAccountControl, VirtualAccountRecord, VirtualAccountRequestRecord, VirtualAccountTransactionRecord, SupplierRecord, SupplierPaymentRecord, BalanceSummary, BalanceTransferRecord } from './types';
import { BuyCryptoView, DashboardAccountNotice, DashboardSetupPanel, DashboardTransactions, EmailRecoveryConfirmView, IncidentBanner, KycOutcomeNotice, KpiCard, LandingPage, NotificationCenter, OtpInput, OffRampWizard, PaymentMethodsView, PublicSidebarCta, SettingsView, SupportView, TransactionsView, TransferCryptoView, TwoFactorRecommendationCard, UserAvatar, VerificationPage, VirtualAccountsView } from './components/AppSections';
import { fallbackCustomerTypes, fallbackSourceAssets, fallbackSourceNetworks, fallbackVirtualAccounts, friendlyStatus, getForm, isRetryableHttpStatus, isRetryableNetworkError, kycOutcomeMessage, legalLinks, legalVersions, normalizeFrontendApiBase, normalizeOfframpControls, pathByView, publicViews, readStorage, shortRef, sleep, timeAgo, viewFromPath, views } from './appUtils';
import type { UserTwoFactorStatus } from './appUtils';
import { useNotifications } from './hooks/useNotifications';
import { useSessionActivity } from './hooks/useAuth';
import { usePaymentDataLoader } from './hooks/usePaymentData';

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
  const [twoFactorRecoveryMode, setTwoFactorRecoveryMode] = useState(false);
  const [twoFactorRecoveryQuestions, setTwoFactorRecoveryQuestions] = useState<Array<{ questionId: string; questionText: string }>>([]);
  const [twoFactorRecoveryAnswers, setTwoFactorRecoveryAnswers] = useState<Record<string, string>>({});
  const [twoFactorRecoveryMessage, setTwoFactorRecoveryMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const pageTitle = useMemo(() => view === 'landing' ? 'Sivan Payments' : view === 'emailRecovery' ? 'Email recovery' : views.find((item) => item.key === view)?.label ?? 'Home', [view]);
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


  const { notifications, readNotificationIds, unreadNotifications, notificationDotClass, markNotificationRead, markAllNotificationsRead } = useNotifications({ systemStatus, customer, hasBank, hasUser, user, twoFactorEnabled: Boolean(twoFactorStatus?.enabled), onrampOrders, withdrawals, balanceTransfers, supplierPayments, virtualAccountTransactions, supportTickets });
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

  const clearLocalSession = useCallback(() => {
    setAuthToken('');
    setUser(null);
    setCustomer(null);
    setAccounts([]);
    setWithdrawals([]);
    setOnrampOrders([]);
    setSupportTickets([]);
    setVirtualAccountRequests([]);
    setVirtualAccounts([]);
    setVirtualAccountTransactions([]);
    setBalance(null);
    setBalanceTransfers([]);
    setSuppliers([]);
    setSupplierPayments([]);
    setUserPreferences(null);
    setIdentityStatus(null);
    setTwoFactorStatus(null);
    setDepositResult(null);
    localStorage.removeItem('sivan.authToken');
    localStorage.removeItem('sivan.user');
    localStorage.removeItem('sivan.customer');
    localStorage.removeItem('sivan.accounts');
  }, []);

  const logout = useCallback((message = 'You have been signed out.') => {
    clearLocalSession();
    setView('landing');
    window.history.pushState({}, '', '/');
    setToast({ message, type: 'success' });
    window.setTimeout(() => setToast(null), 4200);
  }, [clearLocalSession]);

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
    setTwoFactorRecoveryMode(false);
    setTwoFactorRecoveryQuestions([]);
    setTwoFactorRecoveryAnswers({});
    setTwoFactorRecoveryMessage('');
    setDevCode(undefined);
    setResendAvailableAt(0);
  }, []);

  const handleEmailRecoveryConfirmed = useCallback((updatedUser: UserRecord) => {
    clearLocalSession();
    resetPendingEmail();
    setAuthTab('signin');
    setView('signup');
    window.history.pushState({}, '', '/login');
    notify(`Email confirmed. Sign in with ${updatedUser.email}.`);
  }, [clearLocalSession, notify, resetPendingEmail]);

  const handleEmailRecoverySignIn = useCallback(() => {
    resetPendingEmail();
    setAuthTab('signin');
    goToView('signup');
  }, [resetPendingEmail]);

  const handleEmailRecoverySupport = useCallback(() => {
    goToView('help');
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

    const timeoutMs = path.includes('/ace/support') ? 60000 : 20000;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
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
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new Error(path.includes('/ace/support') ? 'Sivan Assistant is taking longer than expected. Please try again or create a support ticket.' : 'Request timed out. Please try again.');
        }
        const message = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase();
        if (message.includes('signal is aborted') || message.includes('aborted without reason')) {
          throw new Error(path.includes('/ace/support') ? 'Sivan Assistant is taking longer than expected. Please try again or create a support ticket.' : 'Request timed out. Please try again.');
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

  useSessionActivity(authToken, logout);

  const loadUserData = usePaymentDataLoader({
    userId: user?.id,
    authToken,
    api,
    setCustomer,
    setAccounts,
    setWithdrawals,
    setOnrampOrders,
    setVirtualAccountRequests,
    setVirtualAccounts,
    setVirtualAccountTransactions,
    setBalance,
    setBalanceTransfers,
    setSuppliers,
    setSupplierPayments,
    setSupportTickets,
    setUserPreferences,
    setIdentityStatus,
    setTwoFactorStatus
  });

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
      setTwoFactorRecoveryMode(false);
      setTwoFactorRecoveryQuestions([]);
      setTwoFactorRecoveryAnswers({});
      setTwoFactorRecoveryMessage('');
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

  async function startTwoFactorRecovery() {
    if (!pendingTwoFactorToken) return notify('Two-factor session expired. Sign in again.', 'error');
    setLoading(true);
    setTwoFactorRecoveryMessage('');
    try {
      const result = await api<{ questions: Array<{ questionId: string; questionText: string }> }>('/api/auth/2fa/recovery-questions/challenge', {
        method: 'POST',
        body: JSON.stringify({ twoFactorToken: pendingTwoFactorToken })
      });
      setTwoFactorRecoveryQuestions(result.questions || []);
      setTwoFactorRecoveryAnswers({});
      setTwoFactorRecoveryMode(true);
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function submitTwoFactorRecovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingTwoFactorToken) return notify('Two-factor session expired. Sign in again.', 'error');
    setLoading(true);
    setTwoFactorRecoveryMessage('');
    try {
      const result = await api<{ verified: boolean; recoveryVerificationId: string; message: string }>('/api/auth/2fa/recovery-questions/verify', {
        method: 'POST',
        body: JSON.stringify({ twoFactorToken: pendingTwoFactorToken, answers: twoFactorRecoveryQuestions.map((question) => ({ questionId: question.questionId, answer: twoFactorRecoveryAnswers[question.questionId] || '' })) })
      });
      setTwoFactorRecoveryMessage(`${result.message} Reference: ${result.recoveryVerificationId}`);
      notify('Recovery questions verified. Contact support to complete 2FA reset review.');
    } catch (error) {
      setTwoFactorRecoveryMessage(error instanceof Error ? error.message : 'Recovery questions could not be verified.');
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
            {hasUser ? <div className="user-menu-wrap"><button className="user-pill" onClick={() => setUserMenuOpen((open) => !open)}><UserAvatar user={user} className="avatar-button small-avatar" /><span><strong>{user?.fullName || 'Sivan user'}</strong><small>{user?.email}</small></span></button>{userMenuOpen && <div className="user-menu"><button onClick={() => goToView('settings')}>Settings</button><button onClick={() => logout('Signed out successfully.')}>Sign out</button></div>}</div> : <button className="primary-btn small topbar-signin" onClick={() => goToPublicView('signin')}>Sign in</button>}
          </div>
        </header>

        {toast && <section className={`toast ${toast.type === 'error' ? 'error' : ''}`}>{toast.message}</section>}

        {(systemStatus.activeIncidents?.length || systemStatus.mode !== 'active') && <IncidentBanner systemStatus={systemStatus} />}

        {view === 'emailRecovery' && <EmailRecoveryConfirmView api={api} loading={loading} onConfirmed={handleEmailRecoveryConfirmed} onSignIn={handleEmailRecoverySignIn} onSupport={handleEmailRecoverySupport} />}

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
                <div className="two-factor-login-stack">
                  {!twoFactorRecoveryMode ? <form className="form auth-form-premium" onSubmit={handleTwoFactorLoginVerify}>
                    <div className="email-confirmation auth-email-confirmation"><span>Two-factor required</span><strong>{pendingEmail}</strong><button type="button" onClick={resetPendingEmail}>Start over</button></div>
                    <label>Authenticator or recovery code<input value={twoFactorCode} onChange={(event) => setTwoFactorCode(event.target.value)} placeholder="123456 or recovery code" autoComplete="one-time-code" required /></label>
                    <button className="primary-btn auth-submit" disabled={loading || twoFactorCode.replace(/\s/g, '').length < 6}>{loading ? 'Verifying…' : 'Verify and continue →'}</button>
                    <button type="button" className="ghost-btn" disabled={loading} onClick={startTwoFactorRecovery}>Lost authenticator? Verify recovery questions</button>
                  </form> : <form className="form auth-form-premium recovery-login-form" onSubmit={submitTwoFactorRecovery}>
                    <div className="email-confirmation auth-email-confirmation"><span>Recover 2FA access</span><strong>{pendingEmail}</strong><button type="button" onClick={() => setTwoFactorRecoveryMode(false)}>Use authenticator</button></div>
                    <p className="muted">Answer your recovery questions. If verified, Sivan Support can review and reset 2FA. This does not automatically disable 2FA.</p>
                    {twoFactorRecoveryQuestions.map((question) => <label key={question.questionId}>{question.questionText}<input value={twoFactorRecoveryAnswers[question.questionId] || ''} onChange={(event) => setTwoFactorRecoveryAnswers((answers) => ({ ...answers, [question.questionId]: event.target.value }))} placeholder="Private answer" autoComplete="off" required /></label>)}
                    {twoFactorRecoveryMessage && <div className={twoFactorRecoveryMessage.includes('Reference:') ? 'success-note' : 'form-error'}>{twoFactorRecoveryMessage}</div>}
                    <button className="primary-btn auth-submit" disabled={loading || twoFactorRecoveryQuestions.some((question) => !(twoFactorRecoveryAnswers[question.questionId] || '').trim())}>{loading ? 'Verifying…' : 'Verify recovery questions →'}</button>
                    <button type="button" className="ghost-btn" onClick={() => goToView('help')}>Contact support</button>
                  </form>}
                </div>
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

        {view === 'settings' && <SettingsView api={api} user={user} isVerified={isVerified} onUserUpdated={(updated) => { setUser(updated); localStorage.setItem('sivan.user', JSON.stringify(updated)); }} preferences={userPreferences} initialTab={settingsInitialTab} twoFactorStatus={twoFactorStatus} onTwoFactorStatusChanged={setTwoFactorStatus} identityStatus={identityStatus} pairingCode={pairingCode} pairingExpiresAt={pairingExpiresAt} timeNow={timeNow} onStartWhatsappLink={handleStartWhatsappLink} onCancelWhatsappLink={handleCancelWhatsappLink} onUnlinkWhatsapp={handleUnlinkWhatsapp} onRefreshIdentity={loadUserData} onSavePreferences={handleSaveUserPreferences} onUpdatePreferences={handleUpdateUserPreferences} loading={loading} onLogout={() => logout('Signed out successfully.')} />}
        {view === 'help' && <SupportView hasUser={hasUser} user={user} tickets={supportTickets} withdrawals={withdrawals} onrampOrders={onrampOrders} accounts={accounts} customer={customer} api={api} onCreateTicket={handleCreateSupportTicket} onTicketsChanged={setSupportTickets} loading={loading} />}

      </main>
    </div>
  );
}
