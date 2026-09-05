import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VerificationSummary, UserWalletRecord, CustomerRecord, DepositResponse, ExternalAccountRecord, AssetControl, FeePolicy, NetworkControl, OfframpControls, PaymentControl, SystemStatus, UserRecord, ViewKey, WithdrawalRecord, OnrampOrderRecord, SupportTicketRecord, UserPreferencesRecord, IdentityStatus, TransactionTimeline, VirtualAccountControl, VirtualAccountRecord, VirtualAccountRequestRecord, VirtualAccountTransactionRecord, SupplierRecord, SupplierPaymentRecord, BalanceSummary, UnifiedBalance, BalanceTransferRecord, NgnTransferRecord, WalletDepositRecord, TransactionTimelineStep, ServiceAgreementsSummary } from './types';
import { ReceiveView } from './components/ReceiveView';
import { BuyCryptoView, DashboardAccountNotice, DashboardSetupPanel, DashboardTransactions, EmailRecoveryConfirmView, IncidentBanner, KycOutcomeNotice, KpiCard, LandingPage, NotificationCenter, OtpInput, OffRampWizard, PaymentMethodsView, PublicSidebarCta, SettingsView, SupportView, TransactionsView, TransferCryptoView, TwoFactorRecommendationCard, UserAvatar, VerificationPage, VirtualAccountsView } from './components/AppSections';
import { buildActivityFeed, type ActivityRow } from './activityFeed';
import { inProgressKpi, limitKpi, stableUsdBalanceKpi } from './dashboardKpis';
import { resolveDisplayCurrency } from './displayCurrency';
import { buildApiUrl, fallbackCustomerTypes, fallbackSourceAssets, fallbackSourceNetworks, fallbackVirtualAccounts, friendlyStatus, getForm, isRetryableHttpStatus, isRetryableNetworkError, kycOutcomeMessage, legalLinks, legalVersions, normalizeFrontendApiBase, normalizeOfframpControls, userFacingMessage, pathByView, publicViews, readStorage, shortRef, sleep, timeAgo, viewFromPath, views } from './appUtils';
import type { UserTwoFactorStatus } from './appUtils';
import { isNgnCurrency, payoutRailFor, withdrawalEndpointFor, type PayoutCurrency } from './rails';
import { VerificationModal } from './components/verification/VerificationModal';
import { bridgeFlowBlockedReason, canUseBridgeFlows, localVerificationPlan, type VerificationPathPlan, type VerificationPath } from './verificationPath';
import { payoutAccountOutcomeMessage, type SavedNgnPayoutAccount } from './ngnBank';
import { closeHandoffTab, deliverHandoff, handoffMessage, paintHandoffTab } from './kycHandoff';
import { offrampClears, typicalGasUsd } from './ngnMinimum';
import type { NgnNetworkLists } from './rails';
import type { WithdrawalReviewState } from './components/AppSections';
import { useNotifications } from './hooks/useNotifications';
import { useSessionActivity } from './hooks/useAuth';
import { usePaymentDataLoader } from './hooks/usePaymentData';
import { useTheme } from './hooks/useTheme';
import { ThemeToggle } from './components/ThemeToggle';
import { PinPadModal } from './components/tma/PinPadModal';
import { ConfirmModal } from './components/ConfirmModal';
import { ServiceAgreementsView } from './components/agreements/ServiceAgreementsView';

/**
 * Server-enforced gap between OTP emails, mirrored here so the countdown tells
 * the truth. The backend default is AUTH_OTP_RESEND_COOLDOWN_SECONDS=60; if
 * that is ever tuned, this must move with it.
 *
 * One second of padding, because the server measures from when it STORED the
 * challenge and the client from when it received the response - without it a
 * click on the exact boundary still 400s.
 */
const OTP_RESEND_COOLDOWN_MS = 61_000;

/**
 * How often the live deposit card re-reads its transfer.
 *
 * 5s, not 10s. At 10s a 13-second observation window saw only ONE poll -
 * measured, by counting responses in a browser - which is too tight a margin
 * for a screen a user is actively watching for progress. Halving it is one
 * indexed query per tick against the user's own transfers, not a dashboard
 * refresh, and the card stops polling entirely once the order is terminal.
 */
const POLL_INTERVAL_MS = 5_000;

export default function App() {
  const [view, setView] = useState<ViewKey>(() => viewFromPath(window.location.pathname));
  const { resolved: resolvedTheme, toggle: toggleTheme } = useTheme();
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
  const [authTab, setAuthTab] = useState<'signup' | 'signin'>(() => {
    const path = typeof window !== 'undefined' ? window.location.pathname.toLowerCase() : '';
    return path.includes('signin') || path.includes('login') ? 'signin' : 'signup';
  });
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
  const [userWallets, setUserWallets] = useState<UserWalletRecord[]>([]);
  const [virtualAccountRequests, setVirtualAccountRequests] = useState<VirtualAccountRequestRecord[]>([]);
  const [virtualAccounts, setVirtualAccounts] = useState<VirtualAccountRecord[]>([]);
  const [virtualAccountTransactions, setVirtualAccountTransactions] = useState<VirtualAccountTransactionRecord[]>([]);
  const [supportTickets, setSupportTickets] = useState<SupportTicketRecord[]>([]);
  const [balance, setBalance] = useState<BalanceSummary | null>(null);
  /**
   * THE ONE BALANCE. chain + ledger credits - holds, from the server.
   *
   * Reported: a deposit visible on Receive showed as zero on the dashboard and
   * the transfer screen. Receive read the Privy wallet; everything else summed
   * a ledger that nothing credits from an on-chain deposit. Two sources, one
   * of which could not see the user's actual money.
   */
  const [unifiedBalance, setUnifiedBalance] = useState<UnifiedBalance | null>(null);
  const [balanceTransfers, setBalanceTransfers] = useState<BalanceTransferRecord[]>([]);
  // Inbound deposits - money arriving from outside Sivan, the seventh feed source.
  const [walletDeposits, setWalletDeposits] = useState<WalletDepositRecord[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierRecord[]>([]);
  const [supplierPayments, setSupplierPayments] = useState<SupplierPaymentRecord[]>([]);
  const [userPreferences, setUserPreferences] = useState<UserPreferencesRecord | null>(null);
  const [identityStatus, setIdentityStatus] = useState<IdentityStatus | null>(null);
  const [serviceAgreements, setServiceAgreements] = useState<ServiceAgreementsSummary>({ linked: false, deals: [] });
  const [twoFactorStatus, setTwoFactorStatus] = useState<UserTwoFactorStatus | null>(null);
  const [pairingCode, setPairingCode] = useState('');
  const [pairingExpiresAt, setPairingExpiresAt] = useState('');
  /**
   * Telegram pairing, held separately from the WhatsApp pair above.
   *
   * The plain code is returned ONLY by .../link-telegram/start - publicToken()
   * omits it from the identity status - so it cannot be recovered on reload.
   * That is why it lives in component state, and why the card falls back to
   * "a code is pending" rather than an empty box after a refresh.
   */
  const [telegramPairingCode, setTelegramPairingCode] = useState('');
  const [telegramPairingExpiresAt, setTelegramPairingExpiresAt] = useState('');
  const [unlinkModal, setUnlinkModal] = useState<{
    open: boolean;
    channel: 'whatsapp' | 'telegram';
    title: string;
    description: string;
  }>({
    open: false,
    channel: 'whatsapp',
    title: '',
    description: ''
  });

  const [feePolicy, setFeePolicy] = useState<FeePolicy | null>(null);
  const [paymentControls, setPaymentControls] = useState<OfframpControls>({ customerTypes: fallbackCustomerTypes, payoutCurrencies: [], virtualAccounts: fallbackVirtualAccounts, sourceAssets: [], sourceNetworks: [], supplierPayoutsEnabled: true });
  const [systemStatus, setSystemStatus] = useState<SystemStatus>({ id: 'global', mode: 'active', updatedAt: new Date().toISOString() });
  const [depositResult, setDepositResult] = useState<DepositResponse | null>(null);
  // The shape was written out inline here AND in AppSections, two copies of
  // one contract that had to be edited in lockstep. Now imported.
  const [withdrawalReview, setWithdrawalReview] = useState<WithdrawalReviewState | null>(null);
  // Per-direction network lists for the NGN rail, from GET /api/ngn/networks.
  // TWO lists, not one: Base can off-ramp but cannot on-ramp, so a shared list
  // would offer a user a network naira cannot settle to.
  const [ngnNetworks, setNgnNetworks] = useState<NgnNetworkLists | null>(null);
  // Naira withdrawal is a different first step, not a variation of the Bridge
  // one: it needs a NUBAN and a quote rather than a saved external account.
  const [ngnMode, setNgnMode] = useState(false);
  /**
   * DEFAULT THE SELL SCREEN TO THE RAIL THE USER ACTUALLY HAS.
   *
   * ngnMode was hardcoded false, so a verified Nigerian landed on the Bridge
   * tab - which reads `accounts` (Bridge external accounts) and, finding none,
   * told them "Add a bank first". They had already added a bank; it is a NUBAN,
   * on the other tab, and nothing pointed them there.
   *
   * Caught in a browser on the deployed app: Level 1, payout account approved,
   * and the sell screen still said add a bank.
   *
   * Only flips the default once, and never fights the user: if they have
   * switched tabs themselves this must not drag them back, which is what the
   * ref guards.
   */
  const ngnDefaultApplied = useRef(false);
  /**
   * WHICH CHAIN THE CRYPTO LEG MOVES ON - CHOSEN, NOT ASSUMED.
   *
   * This was useState('solana') and setNgnNetwork was never called anywhere,
   * so it was a constant wearing a hook's clothes. Every naira withdrawal was
   * priced, gas-estimated and - on the "I'll send crypto myself" path -
   * ADDRESSED on Solana, no matter what the user held or what an admin had
   * enabled.
   *
   * That is not a cosmetic default. The deposit address is chain-specific:
   * a user holding Base USDC was handed a Solana address with no way to say
   * otherwise, and stablecoin sent to an address on the wrong chain is gone.
   * ngn-transfers.service.ts already makes the neighbouring point - the
   * address is base58, "a user cannot be expected to identify a chain by an
   * address format."
   *
   * Empty until /api/ngn/networks answers. Empty is the honest state: the
   * enabled set is the admin's to decide, and guessing here is what produced
   * the bug. Nothing that consumes a network renders until this is filled.
   */
  const [ngnNetwork, setNgnNetwork] = useState('');
  const [ngnAsset, setNgnAsset] = useState<'usdc' | 'usdt'>('usdc');
  const ngnAssetUserChosen = useRef(false);

  const [otpCode, setOtpCode] = useState('');
  const [pendingTwoFactorToken, setPendingTwoFactorToken] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [twoFactorRecoveryMode, setTwoFactorRecoveryMode] = useState(false);
  const [twoFactorRecoveryQuestions, setTwoFactorRecoveryQuestions] = useState<Array<{ questionId: string; questionText: string }>>([]);
  const [twoFactorRecoveryAnswers, setTwoFactorRecoveryAnswers] = useState<Record<string, string>>({});
  const [twoFactorRecoveryMessage, setTwoFactorRecoveryMessage] = useState('');
  const [loading, setLoading] = useState(false);
  // Level 1 verification lives in a modal so it can be opened from anywhere -
  // the dashboard, the verification page, or halfway through a withdrawal -
  // without losing the screen the user was on.
  const [verificationOpen, setVerificationOpen] = useState(false);
  // The server's plan. Authoritative, but arrives a round trip late, so the
  // modal renders a local mirror of the same routing rule until it lands.
  const [verificationPlan, setVerificationPlan] = useState<VerificationPathPlan | null>(null);
  /**
   * A path the user explicitly asked for, overriding the country default.
   *
   * Cleared whenever the modal closes, so the next open starts from the
   * country default again - a sticky override would silently keep showing the
   * document check to someone who only wanted to look once.
   */
  const [requestedVerificationPath, setRequestedVerificationPath] = useState<VerificationPath | undefined>(undefined);
  /**
   * True only while POST /api/customers/kyc-link is in flight.
   *
   * Distinct from the global `loading`, which every other call in this file
   * also sets. The modal has to say something specific and honest here - the
   * measured p50 on that endpoint is TWELVE SECONDS - and a shared flag cannot
   * carry "we are talking to the verification partner right now".
   */
  const [startingBridge, setStartingBridge] = useState(false);
  /**
   * A verification URL we could NOT open for the user.
   *
   * Set when the browser blocked the popup. Rendered as a real link in the
   * modal, because at that point the only thing that will open the tab is a
   * fresh user gesture - our second window.open is exactly the call that gets
   * refused. Before this, that case notified "opened in a new tab" and opened
   * nothing.
   */
  const [manualKycUrl, setManualKycUrl] = useState<string | undefined>(undefined);
  // The backend's answer to "how verified, and for how much". Every gate and
  // every limit below reads from this. Nothing is derived locally, because the
  // local derivation was Bridge-only and got Nigerian users wrong.
  const [verificationSummary, setVerificationSummary] = useState<VerificationSummary | null>(null);
  /**
   * "NOT YET ANSWERED" IS NOT THE SAME AS "ANSWERED: NOTHING".
   *
   * null meant both, and the verification page treated it as the second. So
   * for as long as the summary was in flight, a Nigerian with a bank check in
   * the review queue was shown the Bridge document flow - "Government-issued
   * ID and selfie", Level 0, 25% - and told to start a verification they had
   * already completed.
   *
   * That was not hypothetical. Measured in a real browser against the
   * deployed app, six cold loads of /verification: FOUR rendered the Bridge
   * copy, two rendered the correct pending card. Same user, same server
   * state. The endpoint answered in ~9s (three whole-database reads, since
   * fixed) and the page had long since painted.
   *
   * Speed alone cannot fix this - it only narrows the window. A user on a bad
   * Lagos connection would still lose the race. So the page now waits for an
   * answer instead of inventing one.
   */
  const [verificationSummaryLoaded, setVerificationSummaryLoaded] = useState(false);
  // Naira on/off-ramps. Bridge withdrawals and NGN transfers are different
  // tables; the Transactions page only read the Bridge ones, so a naira sell
  // was invisible to the person who had just created it.
  const [ngnTransfers, setNgnTransfers] = useState<NgnTransferRecord[]>([]);
  const [claimToken, setClaimToken] = useState(() => new URLSearchParams(window.location.search).get('token') || '');
  const [claimInfo, setClaimInfo] = useState<{ amount: number; asset: string; senderName: string; status: string; recipientPhone?: string } | null>(null);
  const [claiming, setClaiming] = useState(false);

  const pageTitle = useMemo(() => view === 'landing' ? 'Sivan Payments' : view === 'emailRecovery' ? 'Email recovery' : views.find((item) => item.key === view)?.label ?? 'Home', [view]);
  const primaryAccount = accounts[0];
  const hasUser = Boolean(user?.id && authToken);
  /**
   * VERIFIED MEANS "COMPLETED THE PATH MY COUNTRY REQUIRES".
   *
   * This was `customer?.kycStatus === 'kyc_approved'` - a Bridge-only fact. A
   * Nigerian who passed the bank name check never becomes a Bridge customer,
   * so they showed as unverified forever while the backend had already granted
   * them Level 1 and a NGN 50,000 ceiling.
   *
   * The fallback keeps pre-existing Bridge users working if the summary call
   * fails, rather than logging everyone out of their own verification.
   */
  const isVerified = verificationSummary
    ? verificationSummary.pathComplete
    : customer?.kycStatus === 'kyc_approved';

  /**
   * BRIDGE-BACKED FLOWS NEED BRIDGE'S OWN CHECK, NOT THE COUNTRY PATH.
   *
   * `isVerified` above is `pathComplete` - "did you finish what your country
   * asks". Correct for naira payouts, which run on Breet. Wrong for buying
   * stablecoins, which runs on Bridge and which Bridge refuses without its own
   * identity verification.
   *
   * Reported from a phone: a Nigerian at Level 1 got the whole buy form,
   * pressed the button, and was refused by the server 18 seconds later behind
   * a gateway timeout that said the request "was NOT retried" - the scariest
   * message we own, on a screen where they had committed nothing.
   */
  const canUseBridge = canUseBridgeFlows(customer?.kycStatus);
  const buyBlockedReason = bridgeFlowBlockedReason(
    customer?.kycStatus,
    verificationSummary?.path ?? localVerificationPlan(user?.country).path,
    'Buying stablecoins'
  );

  /**
   * A payout destination exists - NUBAN or Bridge external account.
   *
   * `accounts` is /external-accounts, which is Bridge-shaped and can never
   * hold a NUBAN. A Nigerian's payout account lives in a different table.
   */
  const hasBank = verificationSummary
    ? verificationSummary.hasPayoutAccount
    : accounts.length > 0;

  /** The NGN off-ramp allowance, straight from the server. Never computed here. */
  const ngnOfframpAllowance = verificationSummary?.allowances.find(
    (item) => item.flow === 'offramp' && item.rail === 'ngn'
  );
  const systemPaused = systemStatus.mode === 'paused';
  const systemMaintenance = systemStatus.mode === 'maintenance';
  const canStartKyc = !systemPaused;
  const canCreatePaymentActions = systemStatus.mode === 'active';
  const activeStep = !hasUser ? 'Create account' : !isVerified ? 'Verify identity' : !hasBank ? 'Add bank' : 'Ready to withdraw';
  const nextStepView: ViewKey = !hasUser ? 'signup' : !isVerified ? 'kyc' : !hasBank ? 'banks' : 'withdraw';
  const nextStepLabel = !hasUser ? 'Create account' : !isVerified ? 'Verify identity' : !hasBank ? 'Add bank account' : 'Withdraw stablecoins';
  const environmentLabel = appEnv === 'test' ? '⚠ Test environment: no real money moves' : isLiveEnv ? '● Live' : 'Local environment';
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
      setView('signup');
      setMobileMenuOpen(false);
      setUserMenuOpen(false);
      setNotificationOpen(false);
      if (window.location.pathname !== '/signin') window.history.pushState({}, '', '/signin');
      return;
    }
    if (nextView === 'signup') {
      setAuthTab('signup');
      resetPendingEmail();
      setView('signup');
      setMobileMenuOpen(false);
      setUserMenuOpen(false);
      setNotificationOpen(false);
      if (window.location.pathname !== '/signup') window.history.pushState({}, '', '/signup');
      return;
    }
    goToView('help');
  };
  const enabledCustomerTypes = (paymentControls.customerTypes ?? fallbackCustomerTypes).filter((control) => control.enabled);
  const enabledControls = (paymentControls.payoutCurrencies ?? []).filter((control) => control.enabled);
  const enabledAssets = (paymentControls.sourceAssets ?? []).filter((control) => control.enabled);
  const enabledNetworks = (paymentControls.sourceNetworks ?? []).filter((control) => control.enabled);
  const { notifications, readNotificationIds, unreadNotifications, notificationDotClass, markNotificationRead, markAllNotificationsRead } = useNotifications({ systemStatus, customer, hasBank, hasUser, user, twoFactorEnabled: Boolean(twoFactorStatus?.enabled), onrampOrders, withdrawals, balanceTransfers, supplierPayments, virtualAccountTransactions, supportTickets, serviceAgreements });
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

  /**
   * Does BRIDGE have something the user must act on?
   *
   * Deliberately narrow. A Bridge customer row exists the moment anyone taps
   * "Verify with ID instead", or from any earlier experiment, and its default
   * state is kyc_not_started - which is not news, it is the absence of news.
   * Treating the row's existence as a reason to show Bridge's card is what put
   * "Verification needs one more step" on the dashboard of a user who was
   * already Level 1 and 100% set up.
   *
   * Only three states are worth interrupting someone for:
   *
   * Bridge attempt on top of that is not a problem to solve on the dashboard.
   * It still shows on /verification, where they went looking for it.
   */
  /**
   * AND NOT UNTIL THE SUMMARY HAS ACTUALLY LANDED.
   *
   * `verificationSummary` is null while the request is in flight, so
   * `!verificationSummary?.pathComplete` is TRUE during the whole load window.
   * A verified user with any leftover Bridge row - a failed check, or one they
   * abandoned by tapping "Verify with ID instead" once - therefore tripped this
   * flag on every fresh login, and the dashboard handed them the Bridge card
   * telling them to verify an account they had already finished. It corrected
   * itself a moment later when the summary arrived, which is exactly what makes
   * it feel broken rather than slow.
   *
   * DashboardAccountNotice already guards this with a skeleton, but the guard
   * lives INSIDE that component - and this flag decides whether that component
   * renders at all, so the skeleton never got the chance to run. The gate
   * belongs here, on the branch condition itself.
   *
   * Gated on `verificationSummaryLoaded` and not `verificationSummary !== null`
   * so a FAILED summary call still falls through to Bridge's opinion, rather
   * than suppressing a real "your check needs attention" notice forever.
   */
  const bridgeNeedsAttention = Boolean(
    verificationSummaryLoaded
    && customer
    && !verificationSummary?.pathComplete
    && (kycUnderReview || kycFailed || kycStatus === 'kyc_incomplete')
  );

  /**
   * ONE FEED, BUILT ONCE, USED BY BOTH SCREENS.
   *
   * The dashboard was passed only withdrawals and onrampOrders, so a user with
   * crypto sends and naira transfers saw "No transactions yet" - 15 real
   * records against 0 rows on the reporter's live account. All six sources are
   * already loaded here; only two were being handed on.
   */
  const activityFeed = useMemo(() => {
    const baseFeed = buildActivityFeed({ withdrawals, onrampOrders, ngnTransfers, balanceTransfers, supplierPayments, virtualAccountTransactions, walletDeposits });
    if (!serviceAgreements?.deals || serviceAgreements.deals.length === 0) return baseFeed;
    const dealRows: ActivityRow[] = serviceAgreements.deals.map((d: any) => ({
      id: d.escrowId || d.id,
      kind: 'withdrawal',
      label: d.title ? `Agreement: ${d.title}` : 'Service Agreement',
      direction: d.role === 'buyer' ? 'out' : 'in',
      amount: d.amount || '—',
      asset: 'USDC',
      network: ((d as any).network || 'solana').toLowerCase(),
      providerReference: (d as any).txHash || (d as any).txSignature,
      currency: (d.currency || 'USDC').toUpperCase(),
      status: d.status || 'PENDING',
      statusLabel: friendlyStatus(d.status),
      state: (String(d.status).toLowerCase() === 'funded' || String(d.status).toLowerCase() === 'in_delivery' || String(d.status).toLowerCase() === 'pending_payment' ? 'pending' : String(d.status).toLowerCase() === 'released' ? 'success' : 'failed') as any,
      createdAt: d.createdAt || new Date().toISOString(),
      raw: d as any
    }));
    const map = new Map<string, ActivityRow>();
    for (const r of [...dealRows, ...baseFeed]) {
      map.set(r.id, r);
    }
    return Array.from(map.values()).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }, [withdrawals, onrampOrders, ngnTransfers, balanceTransfers, supplierPayments, virtualAccountTransactions, walletDeposits, serviceAgreements]);
  /**
   * Which row the Transactions page should open on, set when a dashboard row
   * is clicked. A dashboard row is a POINTER to the real detail view, not a
   * second detail view of its own.
   */
  const [selectedActivityId, setSelectedActivityId] = useState<string>('');

  /**
   * The two derived KPI cards. Pure functions of data already on the client,
   * so they cannot disagree with the activity list below them - which is
   * exactly how "Payout volume $0.00" ended up above six real transactions.
   */
  const inProgress = useMemo(() => inProgressKpi(activityFeed), [activityFeed]);

  /**
   * THE CURRENCY THE USER ASKED FOR, RESOLVED ONCE.
   *
   * Settings > Preferences has offered a "Default fiat currency" select for
   * months and nothing read it back - the dashboard decided naira-or-not from
   * `summary.path`, which is derived from COUNTRY. So a Nigerian who switched
   * to USD saved the preference successfully and watched the screen not
   * change.
   *
   * Resolved HERE, once, and passed down. Four components had their own copy
   * of "is this a naira user" and they are exactly the four places the answer
   * could disagree; one value threaded through them is the only arrangement
   * where the KPI card and the sentence beneath it cannot contradict.
   *
   * Falls back to the old country behaviour when no preference is saved, so
   * this cannot change the screen for someone who never touched the setting.
   */
  const displayCurrency = useMemo(
    () => resolveDisplayCurrency(userPreferences?.defaultFiatCurrency, verificationSummary?.path),
    [userPreferences?.defaultFiatCurrency, verificationSummary?.path]
  );
  const displayFx = paymentControls.displayFx;

  const limitCard = useMemo(
    () => limitKpi(verificationSummary as any, verificationSummaryLoaded, displayCurrency, displayFx),
    [verificationSummary, verificationSummaryLoaded, displayCurrency, displayFx]
  );

  const setupPercent = Math.round(([hasUser, isVerified, hasBank].filter(Boolean).length / 3) * 100);
  /**
   * ONE SOURCE FOR EVERY BALANCE ON EVERY SCREEN.
   *
   * Read here rather than recomputed per screen.
   *
   * The dashboard balance is a DISPLAY aggregate: USDC + USDT read as USD,
   * because a user asks "how many stable dollars can I spend?" before they ask
   * which token carried them. Spending paths still stay asset-specific below:
   * a USDT deposit is never silently treated as USDC for an on-chain transfer.
   */
  const withdrawAssetOptions = useMemo(() => {
    const enabledStableAssets = enabledAssets.filter((asset) => asset.asset === 'usdc' || asset.asset === 'usdt');
    return enabledStableAssets.map((asset) => {
      const balance = unifiedBalance?.balances.find((item) => item.asset.toLowerCase() === asset.asset);
      const spendable = !unifiedBalance
        ? undefined
        : balance?.chainUnavailable
          ? null
          : Number(balance?.spendable ?? 0);
      return {
        asset: asset.asset,
        label: asset.label || asset.asset.toUpperCase(),
        spendable,
        chainUnavailable: Boolean(balance?.chainUnavailable),
      };
    }).sort((a, b) => Number(b.spendable ?? -1) - Number(a.spendable ?? -1));
  }, [enabledAssets, unifiedBalance]);
  const selectedNgnBalance = withdrawAssetOptions.find((option) => option.asset === ngnAsset);
  const selectedNgnSpendable = !unifiedBalance
    ? undefined
    : selectedNgnBalance?.chainUnavailable
      ? null
      : Number(selectedNgnBalance?.spendable ?? 0);
  const stableBalanceCard = useMemo(
    () => stableUsdBalanceKpi(unifiedBalance),
    [unifiedBalance]
  );
  const firstName = user?.fullName?.split(/\s+/)[0] || user?.email?.split('@')[0] || 'there';
  const completedWithdrawals = withdrawals.filter((withdrawal) => withdrawal.status === 'completed');
  const completedWithdrawalCount = completedWithdrawals.length;
  // completedVolume was deleted with the Payout volume card. It summed
  // destinationAmount across withdrawals whose destinationCurrency is
  // 'usd' | 'gbp' | 'eur' and the UI prefixed "$", so a GBP and a EUR payout
  // would have displayed as one dollar figure. Leaving it here as an unused
  // cross-currency sum would be leaving a loaded gun for the next KPI.
  const completedActivityCount = completedWithdrawalCount
    + onrampOrders.filter((order) => order.status === 'completed').length
    + supplierPayments.filter((payment) => payment.status === 'completed').length
    + balanceTransfers.filter((transfer) => transfer.status === 'completed').length
    + virtualAccountTransactions.filter((tx) => ['completed', 'payment_processed'].includes(String(tx.status))).length;
  const showTwoFactorRecommendation = Boolean(isVerified && !twoFactorStatus?.enabled && Date.now() > twoFactorPromptDismissedUntil);

  const primaryAssetLabel = enabledAssets.map((asset) => asset.label).join(', ') || 'USDC';
  const primaryNetworkLabel = enabledNetworks.slice(0, 3).map((network) => network.label).join(', ') || 'Solana';

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
    setUnifiedBalance(null);
    setBalanceTransfers([]);
    setWalletDeposits([]);
    setSuppliers([]);
    setSupplierPayments([]);
    setUserPreferences(null);
    setIdentityStatus(null);
    setPairingCode('');
    setPairingExpiresAt('');
    setTelegramPairingCode('');
    setTelegramPairingExpiresAt('');
    setTwoFactorStatus(null);
    // Must be cleared: a stale summary would carry one account's verification
    // level and ceilings into the next sign-in.
    setVerificationSummary(null);
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

  /**
   * EVERY toast in the app goes through here, which is why the guard lives
   * here and not at twenty-three call sites.
   *
   * `notify((error as Error).message, 'error')` appears all over this file.
   * Each one trusts whatever the API said. One of them showed a real user
   * "Bank verification is unavailable right now (provider: breet)" on
   * production. Sanitising the funnel covers the sites nobody remembers to
   * check, including any added later.
   *
   * Success messages are written by us and pass through untouched unless they
   * somehow leak too - the check is cheap and applies to both.
   */
  const notify = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message: userFacingMessage(message), type });
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
        const response = await fetch(buildApiUrl(apiBase, path), {
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
            const retryAfterHeader = response.headers?.get('Retry-After');
            const retryDelay = response.status === 429
              ? (retryAfterHeader ? Math.min(Number(retryAfterHeader) * 1000, 5000) : 1500 * attempt)
              : 500 * attempt;
            await sleep(retryDelay);
            continue;
          }
          /**
           * ONLY A TOKEN THE SERVER REJECTED ENDS THE SESSION.
           *
           * Any 401 used to log the user out, and that is half of the
           * "signed out every few minutes" report. api-live sleeps on
           * Render's free tier: a cold start answers 503, and a proxied call
           * was measured taking 34 seconds to fail with UPSTREAM_UNAVAILABLE.
           * The gateway can return 401-shaped answers that have nothing to do
           * with the credential, and destroying a valid session over
           * infrastructure is how an hour-long token feels like minutes.
           *
           * The server names the difference precisely, so use its code:
           * auth_required and invalid_token mean the token is the problem.
           * Anything else is infrastructure, and the session survives - the
           * sliding refresh renews it once the backend is awake again.
           */
          const authCode = json?.error?.code;
          const authMsg = json?.error?.message || json?.message || '';
          /**
           * 'forbidden' IS NOT AN AUTH FAILURE, AND TREATING IT AS ONE LOGGED
           * PEOPLE OUT MID-TRANSFER.
           *
           * shared/errors.ts gives EVERY business refusal the code
           * 'forbidden' - transfers disabled, PIN attempts exceeded, email not
           * verified. Listing it here meant any of those signed the user out.
           *
           * Reported: pressing Send on the transfer screen returned
           * 403 forbidden ("Transfers from settled USDC balance are currently
           * disabled") and the session was destroyed. Nothing was wrong with
           * the token; the feature was switched off.
           *
           * The genuine mismatch now has its own code, 'user_mismatch'
           * (app.ts). The message check stays as a belt-and-braces fallback
           * for an older backend that still sends the generic code with that
           * wording.
           */
          const tokenIsRejected = authCode === 'invalid_token' || authCode === 'auth_required' || authCode === 'user_mismatch' || authMsg === 'Authentication required.' || (typeof authMsg === 'string' && authMsg.includes('another user account'));
          if ((response.status === 401 || response.status === 403) && authToken && tokenIsRejected) {
            logout('Session expired or user mismatch. Please sign in again.');
          }
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
          // `cause` preserves the DOMException. Without it the original abort
          // is discarded and Sentry only ever sees the friendly copy, which
          // says nothing about which request died or why.
          throw new Error(path.includes('/ace/support') ? 'Sivan Assistant is taking longer than expected. Please try again or create a support ticket.' : 'Request timed out. Please try again.', { cause: error });
        }
        const message = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase();
        if (message.includes('signal is aborted') || message.includes('aborted without reason')) {
          throw new Error(path.includes('/ace/support') ? 'Sivan Assistant is taking longer than expected. Please try again or create a support ticket.' : 'Request timed out. Please try again.', { cause: error });
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

  /**
   * KEEP THE DEPOSIT CARD ALIVE WHILE THE MONEY MOVES.
   *
   * Reported with a screenshot: the crypto had been sent, Breet had it
   * (trade.pending, confirmations: 1, real txHash), the BACKEND had already
   * advanced the transfer to settlement_processing - and the screen still read
   * "Waiting for crypto deposit". Confirmed by reading the same transfer off
   * the API while the user was looking at the stale version:
   *
   *     server:  status settlement_processing, current step settlement_processing
   *     screen:  Waiting for crypto deposit
   *
   * The cause was not the reconciler this time. `depositResult` is set once,
   * when the POST returns, and nothing ever asked again - there was no polling
   * anywhere on this screen. So the card was a photograph of the instant the
   * order was created, and it could never show progress no matter how well the
   * backend tracked it. A user watching it would conclude their crypto never
   * arrived.
   *
   * Polls the user's own transfer list and re-renders the card from the live
   * record. Deliberately:
   *
   *   - only while a deposit card is on screen, so it costs nothing elsewhere
   *   - stops at a terminal status, so a completed order does not poll forever
   *   - 5s, which is under the reconciler's own cadence and cheap: this is
   *     one indexed query per tick, not the whole dashboard refresh
   *   - failures are swallowed. A missed tick means the card shows slightly
   *     old data for 10 more seconds; throwing here would take down a screen
   *     whose entire job is to display a deposit address the user still needs.
   */
  useEffect(() => {
    const transferId = depositResult?.withdrawal?.id;
    if (!transferId || !user?.id) return;

    const TERMINAL = ['completed', 'failed', 'expired', 'cancelled'];
    if (TERMINAL.includes(String(depositResult?.withdrawal?.status ?? ''))) return;

    let cancelled = false;

    const refresh = async () => {
      try {
        /**
         * api() ALREADY UNWRAPS `data` - it returns `json.data ?? json`.
         *
         * My first version typed this as `{ data: any[] }` and then read
         * `response.data`, which on an already-unwrapped array is undefined,
         * so `live` was never found and the card never moved. The poll was
         * firing correctly the whole time - verified by counting responses in
         * a browser and seeing blockchain_confirmed come back on the wire -
         * which made it look like a rendering bug when it was this line.
         */
        const rows = await api<any[]>(`/api/users/${user.id}/ngn-transfers`);
        if (cancelled) return;
        const live = (Array.isArray(rows) ? rows : []).find((row) => row?.id === transferId);
        if (!live) return;

        setDepositResult((previous) => {
          if (!previous) return previous;
          // Nothing changed - return the SAME object so React skips the render.
          if (previous.withdrawal?.status === live.status) return previous;
          return {
            ...previous,
            withdrawal: {
              ...previous.withdrawal,
              status: live.status,
              destinationTxHash: live.destinationTxHash ?? previous.withdrawal?.destinationTxHash,
              transactionTimeline: normalizeTimeline(live, {
                sourceCurrency: previous.withdrawal?.sourceCurrency,
              } as WithdrawalReviewState) ?? previous.withdrawal?.transactionTimeline,
            } as WithdrawalRecord,
          };
        });
      } catch {
        // See the comment above: a failed poll must never break this screen.
      }
    };

    void refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [api, user?.id, depositResult?.withdrawal?.id, depositResult?.withdrawal?.status]);


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

  useSessionActivity(authToken, logout, apiBase, useCallback((token: string) => {
    // Persist as well as set state: a reload must not drop back to the old
    // token, which would expire on its original schedule and undo the refresh.
    localStorage.setItem('sivan.authToken', token);
    setAuthToken(token);
  }, []));

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
    setUnifiedBalance,
    setBalanceTransfers,
    setWalletDeposits,
    setSuppliers,
    setSupplierPayments,
    setSupportTickets,
    setUserPreferences,
    setIdentityStatus,
    setServiceAgreements,
    setTwoFactorStatus,
    setVerificationSummary,
    setVerificationSummaryLoaded,
    setNgnTransfers
  });

  const refreshKycStatus = useCallback(async (showToast = false) => {
    if (!user?.id || !authToken) {
      if (showToast) notify('Create or sign in to your account first.', 'error');
      return null;
    }
    try {
      const refreshed = await api<CustomerRecord | null>(`/api/customers/${user.id}/kyc-status`);
      /**
       * NULL IS THE NIGERIAN PATH, AND IT IS FINE.
       *
       * The endpoint used to 404 for anyone without a Bridge customer, which
       * is every user who verifies by bank check. It now answers 200 with
       * null instead - a stated absence rather than an error - so the console
       * stops filling with red for the normal case.
       *
       * Handled BEFORE setCustomer: writing null over an existing customer
       * would wipe a Bridge user's KYC state on a transient blank response.
       */
      if (!refreshed) {
        if (showToast) notify('Your verification status is up to date.');
        return null;
      }
      setCustomer(refreshed);
      if (showToast) notify(kycOutcomeMessage(refreshed.kycStatus, refreshed.customerAction), ['kyc_rejected', 'failed', 'cancelled'].includes(refreshed.kycStatus || '') ? 'error' : 'success');
      return refreshed;
    } catch (error) {
      // "Customer not found" IS THE NORMAL CASE ON THE NIGERIAN PATH.
      //
      // /api/customers/:id/kyc-status 404s for anyone with no Bridge
      // customer, and a Nigerian verifying by bank check never has one. The
      // raw provider wording was being toasted at them - caught in the
      // browser: a red "Customer not found" appeared over the verification
      // page after a provider hiccup.
      //
      // It is not an error, it is an absence, so it is silent. Anything else
      // still reports, because a real failure must not be swallowed.
      const message = (error as Error).message ?? '';
      const noBridgeCustomer = /customer not found/i.test(message);
      if (showToast && !noBridgeCustomer) notify(message, 'error');
      if (showToast && noBridgeCustomer) {
        notify('Your verification status is up to date.');
      }
      return null;
    }
  }, [api, authToken, notify, user?.id]);

  const loadControlsPromiseRef = useRef<Promise<OfframpControls> | null>(null);
  const loadControls = useCallback(async (): Promise<OfframpControls> => {
    if (loadControlsPromiseRef.current) return loadControlsPromiseRef.current;
    loadControlsPromiseRef.current = (async () => {
      try {
        const [controls, status] = await Promise.all([
          api<unknown>('/api/offramp/controls').then(normalizeOfframpControls).catch(() => ({ customerTypes: fallbackCustomerTypes, payoutCurrencies: [], virtualAccounts: fallbackVirtualAccounts, sourceAssets: fallbackSourceAssets, sourceNetworks: fallbackSourceNetworks, supplierPayoutsEnabled: true })),
          api<SystemStatus>('/api/system/status').catch(() => systemStatus)
        ]);
        setPaymentControls(controls);
        setSystemStatus(status);
        return controls;
      } finally {
        loadControlsPromiseRef.current = null;
      }
    })();
    return loadControlsPromiseRef.current;
  }, [api]);

  const loadFee = useCallback(async () => {
    const fee = await api<FeePolicy>('/api/fees/offramp').catch(() => null);
    if (fee) setFeePolicy(fee);
  }, [api]);

  /**
   * NGN network capabilities, per direction.
   *
   * Fetched rather than hardcoded because the answer depends on BOTH what
   * Breet supports and what an admin has enabled - so turning Ethereum off in
   * Admin Controls removes it here without a deploy. Failure leaves the state
   * null, and the withdraw path then refuses to guess a minimum rather than
   * inventing one.
   */
  const lastLoadedNgnAssetRef = useRef<string>('');
  const loadNgnNetworks = useCallback(async (asset: 'usdc' | 'usdt' = 'usdc') => {
    try {
      const lists = await api<NgnNetworkLists>(`/api/ngn/networks?asset=${asset}`);
      if (lists) setNgnNetworks(lists);
    } catch {
      // Keep existing list on transient network error
    }
  }, [api]);

  /**
   * Fetch the caller's wallets. Failures are swallowed because a missing
   * wallet list must not break the page: the Receive screen renders a
   * "generate address" state instead.
   */
  const loadUserWallets = useCallback(async () => {
    if (!user?.id) return;
    try {
      // balances=true costs one upstream call per wallet, because Bridge's
      // list endpoint does not include balances. Worth it here: the Receive
      // screen is where the user expects to see what has arrived.
      const wallets = await api<UserWalletRecord[]>(`/api/users/${user.id}/wallets?balances=true`);
      setUserWallets(Array.isArray(wallets) ? wallets : []);
    } catch {
      setUserWallets([]);
    }
  }, [api, user?.id]);

  useEffect(() => {
    void loadFee();
    void loadControls();
    if (hasUser) {
      void loadUserData();
    }
  }, [hasUser, authToken, user?.id]);

  useEffect(() => {
    const handleAgreementsRefresh = () => {
      void loadUserData();
    };
    window.addEventListener('sivan:agreements:refresh', handleAgreementsRefresh);
    window.addEventListener('sivan:balances:refresh', handleAgreementsRefresh);
    return () => {
      window.removeEventListener('sivan:agreements:refresh', handleAgreementsRefresh);
      window.removeEventListener('sivan:balances:refresh', handleAgreementsRefresh);
    };
  }, [loadUserData]);

  const activeAgreementDeal = useMemo(() => {
    return (serviceAgreements?.deals || []).find((d: any) =>
      ['funded', 'in_delivery', 'delivered'].includes(String(d.status || '').toLowerCase())
    ) || null;
  }, [serviceAgreements?.deals]);

  const activeAgreementsCount = useMemo(() => {
    return (serviceAgreements?.deals || []).filter((d: any) =>
      ['funded', 'in_delivery', 'delivered', 'pending_funding', 'draft', 'pending'].includes(String(d.status || '').toLowerCase())
    ).length;
  }, [serviceAgreements?.deals]);

  /**
   * NETWORKS NEED A TOKEN, AND ARE ONLY FETCHED ON BUY/WITHDRAW VIEWS.
   */
  useEffect(() => {
    if (!authToken) return;
    if (view !== 'withdraw' && view !== 'buy') return;
    const cacheKey = `${authToken}:${ngnAsset}`;
    if (lastLoadedNgnAssetRef.current === cacheKey) return;
    lastLoadedNgnAssetRef.current = cacheKey;
    void loadNgnNetworks(ngnAsset);
  }, [authToken, loadNgnNetworks, ngnAsset, view]);

  /**
   * DEFAULT THE SELL ASSET TO WHAT THE USER CAN ACTUALLY WITHDRAW.
   *
   * The dashboard can honestly say "18 USD" across USDC + USDT, but a
   * withdrawal cannot spend an aggregate. It must choose a token. The first
   * choice is therefore the enabled asset with the highest known spendable
   * balance. Once the user changes it we do not keep switching under their
   * hands; we only repair the selection if Admin disables the current asset.
   */
  useEffect(() => {
    if (!withdrawAssetOptions.length) return;

    const current = withdrawAssetOptions.find((option) => option.asset === ngnAsset);
    const best = withdrawAssetOptions
      .slice()
      .sort((a, b) => Number(b.spendable ?? -1) - Number(a.spendable ?? -1))[0];

    if (!current || !ngnAssetUserChosen.current) {
      setNgnAsset(best.asset);
    }
  }, [ngnAsset, withdrawAssetOptions]);

  /**
   * THE SELECTED CHAIN IS ALWAYS ONE THE ADMIN CURRENTLY ALLOWS.
   *
   * /api/ngn/networks is the source of truth - admin's enabled sourceNetworks
   * intersected with what Breet can actually do per asset - so the selection
   * is seeded FROM it rather than defaulted alongside it.
   *
   * Re-validating on every change is the part that matters. If an admin
   * disables the network a user is sitting on, holding the old value would
   * quietly price a quote against a chain Sivan no longer supports, and the
   * off-ramp would fail at settlement rather than at selection. Falling out of
   * a disabled network costs the user a re-pick; staying in one costs them a
   * failed withdrawal.
   *
   * Deliberately NOT `|| 'solana'`. When the list is empty or unreadable the
   * selection stays empty and the form says so - reintroducing a literal here
   * would recreate the exact bug this replaces.
   */
  useEffect(() => {
    const options = ngnNetworks?.offramp ?? [];
    if (!options.length) {
      if (ngnNetwork) setNgnNetwork('');
      return;
    }
    if (options.some((option) => option.network === ngnNetwork)) return;
    setNgnNetwork(options[0].network);
  }, [ngnNetworks, ngnNetwork]);


  // Wallets are fetched separately from loadUserData because they depend on an
  // authenticated user and must refresh when that user changes.
  useEffect(() => {
    if (hasUser && user?.id) {
      void loadUserWallets();
    }
  }, [hasUser, user?.id, authToken]);

  // Applied once the server has actually told us who this user is. Keyed on
  // the summary rather than on user.country so it cannot fire against a stale
  // localStorage record that predates the country being set.
  useEffect(() => {
    if (ngnDefaultApplied.current) return;
    if (!verificationSummaryLoaded || !verificationSummary) return;
    ngnDefaultApplied.current = true;
    if (verificationSummary.path === 'ngn_bank' && verificationSummary.hasPayoutAccount) setNgnMode(true);
  }, [verificationSummaryLoaded, verificationSummary]);

  useEffect(() => {
    const onPopState = () => {
      const nextView = viewFromPath(window.location.pathname);
      setView(nextView);
      if (nextView === 'signup') {
        const path = window.location.pathname.toLowerCase();
        if (path === '/login' || path === '/signin') setAuthTab('signin');
        if (path === '/signup') setAuthTab('signup');
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (view !== 'signup') return;
    const path = window.location.pathname.toLowerCase();
    if (path === '/login' || path === '/signin') setAuthTab('signin');
    if (path === '/signup') setAuthTab('signup');
  }, [view]);



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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || (window.location.pathname.startsWith('/claim') ? params.get('token') : '');
    if (token) {
      setClaimToken(token);
      void (async () => {
        try {
          const res = await api<any>(`/api/claims/${encodeURIComponent(token)}`);
          const data = res?.data ?? res;
          if (data?.amount) {
            setClaimInfo(data);
          }
        } catch {
          // Silent fallback
        }
      })();
    }
  }, [api]);

  const handleRedeemClaim = useCallback(async () => {
    if (!claimToken || !user?.id) return;
    setClaiming(true);
    try {
      await api<any>(`/api/claims/${encodeURIComponent(claimToken)}/redeem`, {
        method: 'POST',
        body: JSON.stringify({ userId: user.id }),
      });
      notify(`🎉 Successfully claimed ${claimInfo?.amount ?? 10} ${(claimInfo?.asset ?? 'usdc').toUpperCase()} from ${claimInfo?.senderName ?? 'Sivan'}!`, 'success');
      setClaimToken('');
      setClaimInfo(null);
      await loadUserData();
      goToView('overview');
    } catch (err: any) {
      notify(err.message || 'Could not claim transfer.', 'error');
    } finally {
      setClaiming(false);
    }
  }, [claimToken, user?.id, claimInfo, api, notify, loadUserData, goToView]);


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
      // MUST MATCH THE SERVER, WHICH IS THE ONLY REAL RULE.
      //
      // This was 30s while the backend enforces a 60s per-address cooldown
      // (AUTH_OTP_RESEND_COOLDOWN_SECONDS). So the button re-enabled itself at
      // 30s, the user clicked a control that said it was ready, and the API
      // refused with "ask for another in 26 seconds". Caught in a browser on
      // the deployed app - screenshot in e2e/shots/resend-mismatch.png.
      //
      // A countdown that lies is worse than no countdown: the user learns the
      // button is unreliable rather than that they need to wait.
      setResendAvailableAt(Date.now() + OTP_RESEND_COOLDOWN_MS);
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
      // MUST MATCH THE SERVER, WHICH IS THE ONLY REAL RULE.
      //
      // This was 30s while the backend enforces a 60s per-address cooldown
      // (AUTH_OTP_RESEND_COOLDOWN_SECONDS). So the button re-enabled itself at
      // 30s, the user clicked a control that said it was ready, and the API
      // refused with "ask for another in 26 seconds". Caught in a browser on
      // the deployed app - screenshot in e2e/shots/resend-mismatch.png.
      //
      // A countdown that lies is worse than no countdown: the user learns the
      // button is unreliable rather than that they need to wait.
      setResendAvailableAt(Date.now() + OTP_RESEND_COOLDOWN_MS);
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
    // Same holding page as the modal path. Was hand-rolled DOM poking here and
    // absent entirely on the modal path, so the two screens behaved
    // differently during the same twelve-second call.
    paintHandoffTab(verificationWindow);
    setManualKycUrl(undefined);
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
      const outcome = deliverHandoff(verificationWindow, created.hostedKycLink || created.kycLink);
      if (outcome.status === 'opened') {
        notify(created.tosStatus === 'approved' ? 'Verification opened in a new tab. Keep this page open and return here when you finish.' : 'Verification opened in a new tab. If Terms remains pending, accept it from the verification status card when you return.');
      } else {
        if (outcome.status === 'manual') setManualKycUrl(outcome.url);
        else closeHandoffTab(verificationWindow);
        const { message, tone } = handoffMessage(outcome);
        notify(message, tone);
      }
      setView('kyc');
    } catch (error) {
      closeHandoffTab(verificationWindow);
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function refreshKyc() {
    /**
     * BOTH, NOT JUST THE BRIDGE CUSTOMER.
     *
     * refreshKycStatus() refetches /api/customers/:id/kyc-status - the BRIDGE
     * record - and nothing else. The verification summary, which is what
     * renders the level badge, the step list and the naira allowance, is
     * loaded only by loadUserData().
     *
     * So after a successful BVN check the server was already reporting Level 2
     * with a NGN 5,000,000 ceiling while the page still showed "Level 1: Bank
     * verified" and "₦100,000 left". Caught by LOOKING at the screenshot: the
     * success message and the refresh toast both appeared, every assertion
     * passed, and the two panels beside them still disagreed with the API.
     *
     * A Nigerian user has no Bridge customer at all, so for them the old
     * refresh fetched the one thing that could not have changed and skipped
     * the one that had.
     */
    await Promise.all([refreshKycStatus(true), loadUserData()]);
  }

  /**
   * Start Bridge KYC without a form event.
   *
   * handleKyc reads the customer type out of a submitted <form>. The modal has
   * no form - the country step already decided the path - so this is the same
   * call with 'individual' assumed. Business verification stays on the full
   * verification page, where the type can actually be chosen.
   *
   * Reported as "start verification is not opening the bridge verification
   * page". It does open it - after twelve seconds of a blank tab and a button
   * that only said "Opening…". Three things changed:
   *
   *   - the tab we open on the click is PAINTED immediately, so it explains
   *     itself instead of sitting blank
   *   - the modal stays open and shows its own progress, so the user is not
   *     left staring at a dead button on a screen that never changes
   *   - a blocked popup is reported as blocked, with a clickable link, rather
   *     than claiming a tab opened. See frontend/src/kycHandoff.ts.
   */
  const startBridgeVerification = useCallback(async () => {
    if (!user?.id) return notify('Create your account first.', 'error');
    if (!canStartKyc) return notify(systemStatus.message || 'Verification is temporarily paused.', 'error');
    if (kycApproved) return notify('Your identity is already verified.');
    if (kycUnderReview) return notify('Verification is under review. We will update this page once it is complete.');
    // Double-submit on a 12-second call means two Bridge sessions and two
    // tabs. The button is disabled too; this is the guard that actually holds.
    if (startingBridge) return;

    // Opened BEFORE the await. A window.open that happens after an async gap
    // is not attributable to the click any more and Safari blocks it.
    const verificationWindow = window.open('', '_blank');
    // Painted in the same tick, for the same reason: the user is looking at
    // this tab for the whole round trip.
    paintHandoffTab(verificationWindow);
    setManualKycUrl(undefined);
    setStartingBridge(true);
    setLoading(true);
    try {
      const created = await api<CustomerRecord>('/api/customers/kyc-link', {
        method: 'POST',
        body: JSON.stringify({
          userId: user.id,
          type: 'individual',
          redirectUri: verificationRedirectUri || `${window.location.origin}/verification-complete`
        })
      });
      setCustomer(created);
      const outcome = deliverHandoff(verificationWindow, created.hostedKycLink || created.kycLink);
      const { message, tone } = handoffMessage(outcome);
      if (outcome.status === 'manual') {
        // Keep the modal open. The link is the only way through from here and
        // it lives in the modal, so closing it would strand the user.
        setManualKycUrl(outcome.url);
        notify(message, tone);
      } else {
        if (outcome.status === 'no-link') closeHandoffTab(verificationWindow);
        notify(message, tone);
        setVerificationOpen(false);
        setView('kyc');
      }
    } catch (error) {
      closeHandoffTab(verificationWindow);
      notify((error as Error).message, 'error');
    } finally {
      setStartingBridge(false);
      setLoading(false);
    }
  }, [api, canStartKyc, kycApproved, kycUnderReview, notify, startingBridge, systemStatus.message, user?.id, verificationRedirectUri]);

  /**
   * Persist the country picked in the modal.
   *
   * Deliberately re-fetches the plan afterwards rather than trusting the local
   * mirror: the server owns the routing rule, and if the two ever drift the
   * one that decides what the user is actually allowed to do must win.
   */
  const handleCountryChange = useCallback(async (country: string) => {
    if (!user?.id) throw new Error('Create your account first.');
    const updated = await api<UserRecord>(`/api/users/${user.id}/country`, {
      method: 'PUT',
      body: JSON.stringify({ country })
    });
    setUser(updated);
    const plan = await api<VerificationPathPlan>(`/api/users/${user.id}/verification-plan`);
    setVerificationPlan(plan);
  }, [api, user?.id]);

  /**
   * Persist the date of birth collected in the verification modal.
   *
   * Stored on the Sivan user AND, once a Bridge customer exists, pushed to
   * Bridge as `birth_date`. Both, because POST /kyc_links silently drops the
   * field - measured - so the value has to survive the create call and be
   * applied by a follow-up PUT.
   */
  const handleDateOfBirthChange = useCallback(async (dateOfBirth: string) => {
    if (!user?.id) throw new Error('Create your account first.');
    const updated = await api<UserRecord>(`/api/users/${user.id}/date-of-birth`, {
      method: 'PUT',
      body: JSON.stringify({ dateOfBirth })
    });
    setUser(updated);
    /**
     * If a customer already exists, patch it now rather than waiting for a
     * verification restart. Non-fatal: the date is saved either way, and the
     * push retries at the next kyc-link call.
     */
    if (customer?.providerCustomerId) {
      await api(`/api/customers/${user.id}/sync-date-of-birth`, { method: 'POST' }).catch(() => undefined);
    }
  }, [api, user?.id, customer?.providerCustomerId]);

  /**
   * A resolved Nigerian bank account, confirmed by the user as theirs.
   *
   * By this point the modal has already POSTed to /api/ngn/payout-accounts,
   * which re-resolved the account server side and matched the bank's name
   * against the name on file. So this receives a SAVED account carrying a
   * verdict, and the only job left is to report the outcome honestly.
   */
  const handleNgnVerified = useCallback(async (account: SavedNgnPayoutAccount) => {
    setVerificationOpen(false);
    // 'pending_review' is NOT success. A partial name match leaves the user
    // blocked until a human clears it, and telling them they are verified
    // would be a promise the withdrawal screen then breaks.
    const outcome = payoutAccountOutcomeMessage(account);
    notify(outcome.message, outcome.tone === 'error' ? 'error' : 'success');
    await loadUserData();
  }, [loadUserData, notify]);

  /**
   * Open the modal, fetching the server's plan for this user.
   *
   * `path` is an EXPLICIT request that overrides the country default. Country
   * decides which check a user is offered first - for a Nigerian, the
   * sixty-second bank check - but it is not the only one they may take. A
   * Nigerian who needs USD/GBP/EUR accounts has to reach Bridge.
   *
   * Before this, routing was country-only and total: "Verify with ID instead"
   * opened the modal, the modal asked the same question of the same country,
   * and served the Nigerian bank form again. The button did the opposite of
   * what it said.
   */
  const openVerification = useCallback((path?: VerificationPath) => {
    setRequestedVerificationPath(path);
    setVerificationOpen(true);
    if (!user?.id) return;
    void api<VerificationPathPlan>(`/api/users/${user.id}/verification-plan`)
      .then(setVerificationPlan)
      // Silent: the modal already renders the local mirror of the same rule,
      // so a failed fetch degrades to a correct screen rather than an error.
      .catch(() => undefined);
  }, [api, user?.id]);

  /** Explicitly ask for the document check, whatever the country says. */
  const openBridgeVerification = useCallback(() => openVerification('bridge_kyc'), [openVerification]);


  async function handleBalanceTransfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.id) return notify('Create your account first.', 'error');
    setLoading(true);
    try {
      const data = getForm(event.currentTarget);
      const transfer = await api<BalanceTransferRecord>(`/api/users/${user.id}/balance/transfers`, {
        method: 'POST',
        body: JSON.stringify({ asset: data.asset || 'usdc', network: data.network, amount: data.amount, destinationAddress: data.destinationAddress, note: data.note || undefined })
      });
      setBalanceTransfers((items) => [transfer, ...items.filter((item) => item.transferId !== transfer.transferId)]);
      await loadUserData();
      notify(transfer.status === 'pending_review'
        ? 'Transfer submitted for review. We will send it once it is approved.'
        : 'Transfer submitted. Track it under Crypto sends - it usually confirms within a minute.');
    } catch (error) {
      /**
       * A TIMED-OUT SEND IS NOT A FAILED SEND.
       *
       * Reported: "an error toast would come to the frontend but the transfer
       * still went through". Confirmed - the Cloudflare worker aborts an
       * upstream POST at 12s and returns 503 UPSTREAM_UNAVAILABLE, while the
       * request keeps running on Render and the coins leave the wallet.
       *
       * The server side now answers inside that window, so this should be
       * rare. It is handled anyway, because the honest answer when we do not
       * know is "we do not know" - telling someone their transfer failed when
       * it succeeded is what makes them send it a second time, and there is no
       * recall on chain for the duplicate.
       *
       * loadUserData() runs regardless: if the send did land, the list shows
       * it, and the user can see the truth rather than take our word for it.
       */
      const message = (error as Error).message || '';
      const ambiguous = /UPSTREAM_UNAVAILABLE|did not respond|NOT retried|timed out|Failed to fetch|NetworkError/i.test(message);
      await loadUserData().catch(() => undefined);
      notify(ambiguous
        ? 'We lost the connection before confirming this transfer. It may still have gone through - check Crypto sends below before trying again.'
        : message, 'error');
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


  async function handleVirtualAccountRequest(currency: PayoutCurrency) {
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


  /**
   * Create the user's wallet for a chain. Idempotent server-side, so a double
   * click cannot produce two addresses.
   */
  async function handleCreateWallet(chain: string) {
    if (!user?.id) return;
    setLoading(true);
    try {
      const wallet = await api<UserWalletRecord>(`/api/users/${user.id}/wallets`, {
        method: 'POST',
        body: JSON.stringify({ chain })
      });
      setUserWallets((current) => [...current.filter((w) => w.id !== wallet.id), wallet]);
      notify('Deposit address ready.');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleOnramp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.id) return notify('Create your account first.', 'error');
    // Bridge's check, not the country path. The screen already refuses to
    // render the form in this state; this is the guard that actually holds if
    // it is ever reached another way.
    if (!canUseBridge) return notify(buyBlockedReason ?? 'Complete identity verification before buying stablecoins.', 'error');
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
        notify('Network changed while creating the order. I refreshed your latest buy orders: check payment instructions below.', 'error');
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
      // NGN goes to Breet, which FLAGS a deposit below its asset minimum:
      // confirmed on-chain, funds held, never credited, and a fee charged to
      // recover. The amount that must clear the minimum is what ARRIVES, after
      // gas - so this is checked before the user commits, not after they send.
      const isNgnPayout = isNgnCurrency(selectedAccount.currency);
      let minimumUsd: number | undefined;
      let estimatedGasUsd: number | undefined;

      if (isNgnPayout) {
        const networkOption = ngnNetworks?.offramp.find((option) => option.network === data.sourceChain);

        /**
         * The SERVER's fee estimate wins.
         *
         * It is the figure the quote's floor is actually built from, so taking
         * it from the same response removes any chance of the UI promising one
         * number while the backend enforces another. The local table is only a
         * fallback for a server that predates this field.
         */
        estimatedGasUsd = networkOption?.gasEstimateUsd ?? typicalGasUsd(data.sourceChain);
        const breetMinimumUsd = networkOption?.minimumDepositUsd;

        /**
         * No fee estimate means no withdrawal - it used to mean a $0.50 guess.
         *
         * Gas is SUBTRACTED from what arrives, so an understated estimate makes
         * the floor too low, and a deposit that lands under Breet's minimum is
         * held uncredited with a flag fee. Refusing costs the user a retry;
         * guessing can cost them the transfer.
         */
        if (estimatedGasUsd === undefined) {
          throw new Error('Network fees for that chain are unavailable right now. Try again shortly.');
        }


        if (breetMinimumUsd === undefined) {
          // Refuse rather than guess. A floor set too low is precisely what
          // gets the user's deposit flagged.
          throw new Error('Minimum withdrawal for that network is unavailable right now. Try again shortly.');
        }

        const verdict = offrampClears({ amountUsd: Number(data.amount ?? 0), breetMinimumUsd, estimatedGasUsd });
        minimumUsd = verdict.minimumUsd;
        if (Number(data.amount ?? 0) > 0 && !verdict.clears) throw new Error(verdict.reason);
      }

      /**
       * THE FOREIGN RAIL CAN NOW BE FUNDED FROM THE SIVAN BALANCE.
       *
       * Both fields are new on this path. Without them the request has no
       * amount, and an amountless withdrawal is - correctly - treated by the
       * server as manual-send, which is the behaviour being fixed.
       */
      const fundingSource = data.fundingSource === 'external' ? 'external' : 'balance';
      const amountEntered = String(data.sourceAmount ?? '').trim();
      const selectedBalance = unifiedBalance?.balances.find((item) => item.asset.toLowerCase() === data.sourceCurrency);

      // Validated HERE rather than at confirm, so the user finds out while
      // they are still looking at the field they need to change.
      if (fundingSource === 'balance') {
        if (!amountEntered) throw new Error('Enter the amount you want to withdraw.');
        if (!Number.isFinite(Number(amountEntered)) || Number(amountEntered) <= 0) {
          throw new Error('Enter a valid amount.');
        }
        // The SAME expression the wizard renders from, so the number the user
        // was shown and the number they are checked against are one value.
        // `chainUnavailable` means the balance could not be read, which is not
        // zero and must not be used to refuse a withdrawal.
        const spendableSelectedAsset = !unifiedBalance || selectedBalance?.chainUnavailable
          ? undefined
          : Number(selectedBalance?.spendable ?? 0);
        if (typeof spendableSelectedAsset === 'number' && Number(amountEntered) > spendableSelectedAsset) {
          throw new Error(`You have ${spendableSelectedAsset.toFixed(2)} ${data.sourceCurrency.toUpperCase()} available to withdraw.`);
        }
      }

      setWithdrawalReview({
        userId: user.id,
        externalAccountId: selectedAccount.id,
        sourceCurrency: data.sourceCurrency,
        sourceChain: data.sourceChain,
        destinationCurrency: selectedAccount.currency,
        returnAddress: data.returnAddress,
        bankLabel: `${selectedAccount.bankName || 'Bank account'} ****${selectedAccount.accountLast4 || '----'}`,
        assetLabel,
        networkLabel,
        minimumUsd,
        estimatedGasUsd,
        fundingSource,
        amount: fundingSource === 'balance' ? amountEntered : undefined
      });
      setDepositResult(null);
      notify('Review your withdrawal details before creating a deposit address.');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }


  /**
   * Create the withdrawal, on whichever rail the payout currency belongs to.
   *
   * This used to POST /api/withdrawals unconditionally. That endpoint is
   * Bridge, and Bridge has no naira rail at all - it rejects 'ngn' outright -
   * so a Nigerian payout could never have worked from here regardless of what
   * the UI offered.
   *
   * The rail is derived from the currency by payoutRailFor(), so the two
   * cannot drift: adding a payout currency without routing it fails to
   * compile. The request SHAPES differ too, which is why this branches rather
   * than templating a URL - Bridge takes an external account and returns a
   * deposit address, Breet takes a quote and returns its own.
   */
  /**
   * Quote priced and account verified - move to the review step.
   *
   * The bank is already bound to the quote server-side, so only the quote id
   * travels on to confirmation. The account details are carried purely so the
   * review screen can show the user where their money is going.
   */
  function handleNgnReady({ quote, account, fundingSource }: { quote: any; account: any; fundingSource: 'balance' | 'external' }) {
    if (!user?.id) return;
    setWithdrawalReview({
      userId: user.id,
      externalAccountId: '',
      sourceCurrency: quote.sourceCurrency ?? 'usdc',
      sourceChain: ngnNetwork,
      destinationCurrency: 'ngn',
      bankLabel: `${account.bankName ?? 'Bank'} · ${account.accountName}`,
      assetLabel: String(quote.sourceCurrency ?? 'usdc').toUpperCase(),
      networkLabel: ngnNetwork,
      quoteId: quote.id,
      /**
       * THE SAME NUMBERS THE QUOTE CARD SHOWED, carried rather than recomputed.
       *
       * The confirm screen displayed a bare percentage one step after a card
       * itemising "Sivan fee ₦765 · 0.51 USDC". Recomputing here would risk
       * the two screens disagreeing by a rounding step; copying the accepted
       * quote's own figures cannot.
       *
       * Math.round to whole naira for the same reason the quote card does it:
       * a bank transfer settles in whole naira, so a half-kobo is a quantity
       * that cannot be paid out.
       */
      feeSummary: (() => {
        const rate = Number(quote.rate) || 0;
        const totalFeeAsset = Number(quote.fees?.totalFeeAsset ?? quote.fees?.totalFee ?? quote.feeAmount ?? 0);
        const totalFeeNgn = Number(quote.fees?.totalFeeNgn ?? (rate > 0 ? totalFeeAsset * rate : 0));
        if (!totalFeeAsset && !totalFeeNgn) return undefined;
        const assetFee = Number.isFinite(totalFeeAsset)
          ? totalFeeAsset.toFixed(3).replace(/\.?0+$/, '')
          : String(totalFeeAsset);
        return {
          ngn: totalFeeNgn > 0 ? `₦${Math.round(totalFeeNgn).toLocaleString()}` : undefined,
          asset: `${assetFee} ${String(quote.sourceCurrency ?? 'usdc').toUpperCase()}`,
          percent: quote.fees?.effectivePercent ? Number(quote.fees.effectivePercent).toFixed(2) : undefined,
        };
      })(),
      payoutSummary: {
        send: `${quote.sourceAmount} ${String(quote.sourceCurrency ?? 'usdc').toUpperCase()}`,
        receive: quote.destinationAmount ? `₦${Math.round(Number(quote.destinationAmount)).toLocaleString()}` : undefined,
      },
      bankId: account.bankId,
      accountNumber: account.accountNumber,
      minimumUsd: ngnNetworks?.offramp.find((option) => option.network === ngnNetwork)?.minimumDepositUsd,
      /**
       * Prefer the server's number; fall back to the local table when it has
       * not arrived yet. Both can still yield undefined - which is honest when
       * we genuinely do not know - but most paths have already refused by this
       * point if the network has no fee, so in practice this is populated.
       */
      estimatedGasUsd: ngnNetworks?.offramp.find((option) => option.network === ngnNetwork)?.gasEstimateUsd ?? typicalGasUsd(ngnNetwork),
      // Carried so the review screen can say which of the two things is about
      // to happen. The user chose it; the confirmation should reflect it back.
      fundingSource
    });

    setDepositResult(null);
  }

  /**
   * MAKE BOTH RAILS ANSWER IN ONE SHAPE.
   *
   * The two endpoints do NOT return the same thing, and for a long time the
   * code pretended they did:
   *
   *   /api/withdrawals      -> { withdrawal, deposit: { address, chain, currency } }
   *   /api/ngn/offramp/orders -> a FLAT NgnTransferRecord, no `deposit`, no `withdrawal`
   *
   * Both were cast with `api<DepositResponse>()`. A cast is a compile-time
   * assertion and nothing more - at runtime the naira response sailed through
   * with `deposit` undefined, and DepositCard read `result.deposit.currency`
   * and took the whole page down with it. The withdrawal itself had already
   * succeeded, so the user watched a black screen having been charged.
   *
   * Normalising here, at the boundary, means the render layer sees one
   * contract and the two providers stay the backend's business.
   */
  /**
   * Build a TransactionTimeline the render layer can trust.
   *
   * Three inputs are possible and all three reach here:
   *   - Bridge:  a full object, already the right shape.
   *   - Breet:   `timeline` as a bare ARRAY of steps.
   *   - neither: no timeline at all.
   *
   * Returns undefined rather than a half-built object when there are no
   * steps, so the card falls back to its own tracking view instead of
   * rendering an empty timeline that looks like data is missing.
   */
  function normalizeTimeline(value: Record<string, unknown>, review: WithdrawalReviewState) {
    const raw = (value.timeline ?? value.transactionTimeline) as
      TransactionTimelineStep[] | TransactionTimeline | undefined;
    if (!raw) return undefined;

    // Already an object with steps: Bridge's shape, pass it through.
    if (!Array.isArray(raw)) return raw.steps ? raw : undefined;
    if (!raw.length) return undefined;

    const str = (key: string) => (value[key] === undefined || value[key] === null ? undefined : String(value[key]));

    const current = raw.find((step) => step?.status === 'current')
      ?? raw.find((step) => step?.status === 'failed')
      ?? raw[raw.length - 1];

    return {
      transactionType: 'withdrawal' as const,
      requestId: String(value.id ?? ''),
      internalTransactionId: String(value.id ?? ''),
      providerReference: str('providerTransferId') ?? str('providerQuoteId'),
      amount: str('destinationAmount'),
      // The naira leg is what the user is receiving, and it is what the
      // amount above is denominated in. Labelling it with the source asset
      // would show "29,699.80 USDC".
      currency: String(value.destinationCurrency ?? 'ngn').toUpperCase(),
      asset: String(value.sourceCurrency ?? review.sourceCurrency ?? 'usdc').toUpperCase(),
      direction: 'sell' as const,
      provider: str('provider'),
      status: str('status') ?? current?.status ?? 'pending',
      explanation: current?.description ?? '',
      createdAt: str('createdAt') ?? new Date().toISOString(),
      updatedAt: str('updatedAt') ?? str('createdAt') ?? new Date().toISOString(),
      steps: raw,
    };
  }

  function normalizeWithdrawalResponse(raw: unknown, review: WithdrawalReviewState): DepositResponse | null {
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as Record<string, any>;

    // Bridge already answers in the shape the card wants.
    if (value.deposit && value.withdrawal) return value as DepositResponse;

    // Breet answers flat. Rebuild the contract from the fields it does send,
    // falling back to what the user just confirmed on the review screen -
    // those were server-validated to produce this order, so they are not
    // guesses.
    const depositAddress = value.depositAddress ?? value.deposit?.address;
    if (!depositAddress) return null;

    return {
      withdrawal: {
        id: value.id,
        status: value.status ?? 'pending_deposit',
        createdAt: value.createdAt ?? new Date().toISOString(),
        sourceCurrency: value.sourceCurrency ?? review.sourceCurrency,
        destinationCurrency: value.destinationCurrency ?? review.destinationCurrency,
        sourceAmount: value.sourceAmount,
        destinationAmount: value.destinationAmount,
        feeAmount: value.feeAmount,
        /**
         * THE NAIRA RAIL SENDS AN ARRAY, THE CARD EXPECTS AN OBJECT.
         *
         * Verified against the running API rather than assumed:
         *
         *   POST /api/ngn/offramp/orders -> timeline: [ {key,label,status,at}, ... ]
         *   TransactionTimeline          -> { status, steps: [...], requestId, ... }
         *
         * Passing the array straight through set `transactionTimeline` to
         * something truthy with no `.steps`, so AppSections rendered
         * InlineTransactionTimeline, which did `timeline.steps.map(...)` and
         * threw. That is the reported crash - the error boundary replaced the
         * confirmation screen with "Something went wrong" AFTER the withdrawal
         * had already been created, so the user was left unable to tell
         * whether their money had moved, and the deposit address they needed
         * was inside the response that crashed.
         *
         * Normalised here, at the same boundary that already reconciles the
         * two rails, so the render layer keeps seeing one contract.
         */
        transactionTimeline: normalizeTimeline(value, review),
      } as WithdrawalRecord,
      deposit: {
        address: depositAddress,
        // The ASSET being sent, not the naira being received. Getting this
        // backwards would tell someone to send NGN to a crypto address.
        currency: value.sourceCurrency ?? review.sourceCurrency,
        chain: value.network ?? review.sourceChain,
      },
    };
  }

  async function confirmWithdrawal() {
    if (!withdrawalReview) return;
    setLoading(true);
    try {
      const currency = withdrawalReview.destinationCurrency as PayoutCurrency;
      const rail = payoutRailFor(currency);


      if (rail === 'breet' && !withdrawalReview.quoteId) {
        // The NGN endpoint settles an ACCEPTED QUOTE. Without one there is
        // nothing to accept, and posting anyway produces a validation error
        // the user cannot act on.
        throw new Error('Get a quote before confirming this withdrawal.');
      }

      const result = rail === 'breet'
        ? await api<DepositResponse>(withdrawalEndpointFor(currency), {
            method: 'POST',
            // acceptNgnQuoteSchema takes userId and quoteId, nothing else.
            // The bank is already bound to the quote server-side; sending it
            // again was wrong and would be rejected as an unknown field.
            body: JSON.stringify({
              userId: withdrawalReview.userId,
              quoteId: withdrawalReview.quoteId,
            })
          })
        : await api<DepositResponse>(withdrawalEndpointFor(currency), {
            /**
             * The review state is posted almost as-is, but `amount` is a UI
             * field name and the API's is `sourceAmount`. Spreading the review
             * object alone therefore sent the amount under a key the schema
             * ignores - the request validated, and the withdrawal silently
             * became a manual-send one with no amount. Mapped explicitly.
             */
            method: 'POST',
            body: JSON.stringify({
              ...withdrawalReview,
              sourceAmount: withdrawalReview.fundingSource === 'balance' && withdrawalReview.amount
                ? Number(withdrawalReview.amount)
                : undefined,
            })
          });

      const normalized = normalizeWithdrawalResponse(result, withdrawalReview);
      if (!normalized) {
        throw new Error('The withdrawal was created but the server response was incomplete. Please refresh and check your transaction history.');
      }

      setWithdrawalReview(null);
      setDepositResult(normalized);

      /**
       * ISOLATE THE SUCCESS STATE FROM THE REFRESH.
       *
       * The deposit address is ready immediately after the POST succeeds, so
       * show it first. loadUserData() runs afterward to sync the activity feed,
       * but if that refresh times out or fails — which is exactly what the
       * reported console logs show — the user still has their deposit address
       * and can use it.
       *
       * Before this, await loadUserData() ran inline, so a network dropout
       * during the three parallel refreshes (session, controls, status) would
       * throw into the same catch block that handles a failed withdrawal POST,
       * replacing "Deposit address created" with "ERR_CONNECTION_CLOSED" and
       * leaving the user staring at an error toast while their withdrawal had
       * actually succeeded.
       */
      notify(rail === 'breet'
        ? 'Deposit address created. Send only the selected asset and network - naira lands in your bank once it confirms.'
        : 'Deposit address created. Send only the selected asset and network.');

      // Fire and forget: if this fails, the user keeps the success state above.
      void loadUserData().catch(() => undefined);
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

  function handleUnlinkWhatsapp() {
    setUnlinkModal({
      open: true,
      channel: 'whatsapp',
      title: 'Unlink WhatsApp Identity',
      description: 'Are you sure you want to unlink your WhatsApp / Service Agreement identity from your Sivan web account?'
    });
  }

  /**
   * The Telegram equivalents of the three handlers above.
   *
   * Separate functions rather than a channel parameter, because the copy
   * differs at every step: a WhatsApp user is told to send the code to a
   * number, a Telegram user is told to type /link in the bot. Sharing the body
   * would mean a channel switch inside each message anyway.
   */
  async function handleStartTelegramLink() {
    if (!user?.id) return notify('Create your account first.', 'error');
    setLoading(true);
    try {
      const result = await api<any>('/api/users/me/identity/link-telegram/start', { method: 'POST', body: '{}' });
      if (result?.token) {
        setTelegramPairingCode(result.token);
        setTelegramPairingExpiresAt(result.expiresAt || '');
      }
      await loadUserData();
      if (result?.token) notify('Pairing code generated. Send /link with this code to the Sivan bot on Telegram.');
      else notify(result?.message || 'Pairing request is ready.');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleCancelTelegramLink() {
    setLoading(true);
    try {
      await api('/api/users/me/identity/link-telegram/cancel', { method: 'POST', body: '{}' });
      setTelegramPairingCode('');
      setTelegramPairingExpiresAt('');
      await loadUserData();
      notify('Pairing code canceled.');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  function handleUnlinkTelegram() {
    setUnlinkModal({
      open: true,
      channel: 'telegram',
      title: 'Unlink Telegram Identity',
      description: 'Are you sure you want to unlink this Telegram account from your Sivan web account?'
    });
  }

  async function executeUnlink() {
    const channel = unlinkModal.channel;
    setUnlinkModal((m) => ({ ...m, open: false }));
    setLoading(true);
    try {
      if (channel === 'whatsapp') {
        await api('/api/users/me/identity/unlink-whatsapp', { method: 'POST', body: '{}' });
        setPairingCode('');
        setPairingExpiresAt('');
        notify('WhatsApp account unlinked.');
      } else {
        await api('/api/users/me/identity/unlink-telegram', { method: 'POST', body: '{}' });
        setTelegramPairingCode('');
        setTelegramPairingExpiresAt('');
        notify('Telegram account unlinked.');
      }
      await loadUserData();
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

  if (window.location.pathname === '/pin-pad' || window.location.pathname.startsWith('/pin-pad')) {
    return <PinPadModal />;
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
              {item.key === 'agreements' && activeAgreementsCount > 0 && (
                <span className="nav-badge" style={{ marginLeft: 'auto', background: 'rgba(234, 179, 8, 0.15)', color: '#eab308', border: '1px solid rgba(234, 179, 8, 0.3)', borderRadius: '999px', fontSize: '11px', fontWeight: 600, padding: '1px 7px' }}>
                  {activeAgreementsCount}
                </span>
              )}
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
            <ThemeToggle resolved={resolvedTheme} onToggle={toggleTheme} />
            {hasUser && <><div className="search-wrap"><span>⌕</span><input placeholder="Search transactions, accounts..." aria-label="Search transactions and accounts" /></div><NotificationCenter open={notificationOpen} notifications={notifications} unreadCount={unreadNotifications.length} dotClass={notificationDotClass} readIds={readNotificationIds} timeNow={timeNow} onToggle={() => { setNotificationOpen((open) => !open); setUserMenuOpen(false); }} onClose={() => setNotificationOpen(false)} onMarkAllRead={markAllNotificationsRead} onOpen={(item) => { markNotificationRead(item.id); if (item.view === 'settings') goToSettingsSecurity(); else if (item.view) goToView(item.view); }} /></>}
            {hasUser ? <div className="user-menu-wrap"><button className="user-pill" onClick={() => setUserMenuOpen((open) => !open)}><UserAvatar user={user} className="avatar-button small-avatar" /><span><strong>{user?.fullName || 'Sivan user'}</strong><small>{user?.email}</small></span></button>{userMenuOpen && <div className="user-menu"><button onClick={() => goToView('settings')}>Settings</button><button onClick={() => logout('Signed out successfully.')}>Sign out</button></div>}</div> : <button className="primary-btn small topbar-signin" onClick={() => goToPublicView('signin')}>Sign in</button>}
          </div>
        </header>

        {toast && (
          <section
            className={`toast ${toast.type === 'error' ? 'error' : ''}`}
            /*
             * role/aria-live differ by severity on purpose: an error
             * interrupts ('alert'), a success is announced politely when the
             * user is idle. Both were previously silent to screen readers.
             */
            role={toast.type === 'error' ? 'alert' : 'status'}
            aria-live={toast.type === 'error' ? 'assertive' : 'polite'}
          >
            <span className="toast-icon" aria-hidden="true">{toast.type === 'error' ? '!' : '\u2713'}</span>
            <span className="toast-body">{toast.message}</span>
          </section>
        )}

        {(systemStatus.activeIncidents?.length || systemStatus.mode !== 'active') && <IncidentBanner systemStatus={systemStatus} />}

        {claimInfo && (
          <div className="incident-banner warning" style={{ background: 'linear-gradient(135deg, #10b981, #059669)', color: '#fff', padding: '16px 20px', borderRadius: '12px', marginBottom: '20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '24px' }}>🎁</span>
              <div>
                <strong style={{ fontSize: '16px', display: 'block', color: '#fff' }}>{claimInfo.senderName} sent you {claimInfo.amount.toFixed(2)} {claimInfo.asset.toUpperCase()}!</strong>
                <span style={{ fontSize: '13px', opacity: 0.9 }}>{user?.id ? 'Funds are ready to deposit into your Sivan balance.' : 'Sign in or create an account to claim your funds.'}</span>
              </div>
            </div>
            {user?.id ? (
              <button
                type="button"
                className="primary-btn"
                style={{ background: '#fff', color: '#059669', fontWeight: 600, border: 'none', padding: '10px 18px', borderRadius: '8px', cursor: 'pointer' }}
                disabled={claiming}
                onClick={handleRedeemClaim}
              >
                {claiming ? 'Claiming…' : `Claim ${claimInfo.amount.toFixed(2)} ${claimInfo.asset.toUpperCase()}`}
              </button>
            ) : (
              <button
                type="button"
                className="primary-btn"
                style={{ background: '#fff', color: '#059669', fontWeight: 600, border: 'none', padding: '10px 18px', borderRadius: '8px', cursor: 'pointer' }}
                onClick={() => { setAuthTab('signup'); setView('signup'); }}
              >
                Create Free Account to Claim
              </button>
            )}
          </div>
        )}

        {view === 'emailRecovery' && <EmailRecoveryConfirmView api={api} loading={loading} onConfirmed={handleEmailRecoveryConfirmed} onSignIn={handleEmailRecoverySignIn} onSupport={handleEmailRecoverySupport} />}

        {view === 'overview' && (
          <section className="view active dashboard-view app-dashboard">
            {/* WHICH NOTICE THE DASHBOARD SHOWS.
 
                 Reported with a screenshot: a Nigerian at Level 1, bank
                 verified, account setup 100%, and the banner at the top of
                 their dashboard read "Verification needs one more step -
                 please complete your date of birth and age confirmation".
                 The KPI beside it said "Bank verified · Level 1 · Ready".
                 One screen, two opposite claims.
 
                 The condition was `customer ? Bridge : summary`, so the mere
                 EXISTENCE of a Bridge customer row won - regardless of what
                 the user had actually completed. A row gets created the
                 moment anyone taps "Verify with ID instead", or by any
                 earlier experiment, and from then on the dashboard describes
                 Bridge's opinion instead of the user's real state.
 
                 The rule now: the summary is authoritative, because it is the
                 server's answer for whichever path the user is on. Bridge's
                 card is shown only when Bridge has something the user must
                 ACT on - a check they started and left incomplete, one under
                 review, or one that failed - and only when their own path is
                 not already complete.
 
                 A completed path always wins. Someone who has finished what
                 Sivan asks of them must never be told they are unverified. */}
            {bridgeNeedsAttention
              ? <KycOutcomeNotice customer={customer!} hasBank={hasBank} onContinue={() => goToView(isVerified && hasBank ? 'transfer' : nextStepView)} onSupport={() => goToView('help')} onRefresh={refreshKyc} />
              : <DashboardAccountNotice summary={verificationSummary} summaryLoaded={verificationSummaryLoaded} onVerify={() => openVerification()} onAddBank={() => goToView('banks')} onSell={() => goToView('withdraw')} displayCurrency={displayCurrency} displayFx={displayFx} />}

            {activeAgreementDeal && (
              <div
                style={{
                  background: 'linear-gradient(135deg, rgba(30, 41, 59, 0.95), rgba(15, 23, 42, 0.95))',
                  border: '1px solid rgba(56, 189, 248, 0.4)',
                  borderRadius: '12px',
                  padding: '16px 20px',
                  marginBottom: '16px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  boxShadow: '0 4px 20px rgba(0, 0, 0, 0.25)',
                  gap: '16px',
                  flexWrap: 'wrap'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                  <div style={{ fontSize: '24px', background: 'rgba(56, 189, 248, 0.15)', padding: '8px 12px', borderRadius: '10px' }}>
                    🔒
                  </div>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <strong style={{ fontSize: '15px', color: '#F8FAFC' }}>
                        {activeAgreementDeal.role === 'seller' ? 'Active Service Agreement (Funded in Vault)' : 'Service Agreement Active in Vault'}
                      </strong>
                      <span style={{ fontSize: '11px', background: '#0284C7', color: '#FFF', padding: '2px 8px', borderRadius: '4px', fontWeight: 600 }}>
                        {activeAgreementDeal.amount} {activeAgreementDeal.currency || 'USDC'}
                      </span>
                    </div>
                    <small style={{ color: '#94A3B8', fontSize: '13px' }}>
                      {activeAgreementDeal.role === 'seller'
                        ? `Client locked ${activeAgreementDeal.amount} USDC into vault for "${activeAgreementDeal.title}". Deliverable active.`
                        : `${activeAgreementDeal.title} is locked on Solana Devnet vault. Milestone delivery in progress.`}
                    </small>
                  </div>
                </div>
                <button
                  className="primary-btn"
                  style={{ padding: '8px 18px', fontSize: '13px', whiteSpace: 'nowrap' }}
                  onClick={() => goToView('history')}
                >
                  View in Transactions Ledger →
                </button>
              </div>
            )}

            <div className="dashboard-actions-row">
              <button className="dashboard-action-card sell" onClick={() => goToView('withdraw')}><span>↗</span><div><strong>Withdraw</strong><small>Cash out to your bank account</small></div><em>→</em></button>
              <button className="dashboard-action-card buy" onClick={() => goToView('buy')}><span>↙</span><div><strong>Buy crypto</strong><small>Buy stablecoins with fiat via transfer or card</small></div><em>→</em></button><button className="dashboard-action-card transfer" onClick={() => goToView('transfer')}><span>⇆</span><div><strong>Transfer & pay</strong><small>Send settled USDC or pay suppliers</small></div><em>→</em></button>
            </div>

            <div className="dashboard-kpis">
              {/* THE DASHBOARD NEVER SHOWED A BALANCE AT ALL.
 
                   Reported: "in the dashboard balance is reading zero". It was
                   not reading zero - there was no balance on this screen. The
                   first KPI is "Total volume", which is lifetime COMPLETED
                   PAYOUT value and is legitimately $0.00 for a user who has
                   never sold. Sitting first, in the position every banking app
                   puts the balance, it reads as one.
 
                   So the user held 108 USDC, the Send screen said so, and the
                   home screen led with $0.00. Two screens, two numbers, and the
                   wrong one was the more prominent.
 
                   Fixed by showing the balance FIRST, from the same
                   unifiedBalance the transfer screen uses - not a second
                   calculation that can drift from it. Total volume keeps its
                   place, one column right, with a label that says what it
                   actually measures. */}
              <KpiCard
                label="Your balance"
                value={stableBalanceCard.value}
                sub={stableBalanceCard.sub}
                trend={stableBalanceCard.trend}
                tone={stableBalanceCard.tone}
              />
              {/* PAYOUT VOLUME AND TRANSACTIONS ARE GONE.

                   Both were single-source reads on a six-source product, the
                   same defect the activity feed had. Payout volume summed only
                   `withdrawals`, so it showed $0.00 on an account with two
                   COMPLETED crypto sends - and it summed destinationAmount
                   across usd|gbp|eur behind a "$" prefix, so a GBP and a EUR
                   payout would have rendered as one dollar figure. That bug
                   never fired only because nothing had completed yet.

                   Transactions was a count of rows sitting directly above the
                   list of rows.

                   Both actively contradicted the unified feed once it shipped:
                   the card read "0 Lifetime" while six transactions sat
                   underneath. Replaced by the two questions people actually
                   open the dashboard to answer - is anything stuck, and how
                   much headroom is left. */}
              <KpiCard label="In progress" value={inProgress.value} sub={inProgress.sub} trend={inProgress.trend} tone={inProgress.tone} />
              {/* NAIRA LIMITS ONLY FOR PEOPLE WHO TRANSACT IN NAIRA.

                   limitNgn is the internal denominator for EVERY limit,
                   including the foreign rail - a UK user selling USDC for GBP
                   has a real enforced cap, just expressed in a currency they
                   never touch. So this is not "hide it from non-Nigerians", it
                   is "never show ₦ to someone who does not use ₦". They get
                   the verification card instead: a different question for a
                   different user, not a degraded fallback.

                   Known gap, stated rather than papered over: that leaves a UK
                   user with no visible limit at all. Closing it needs limits
                   expressed in their own currency, which is backend work and
                   not something to fake with a hardcoded rate here. */}
              <KpiCard label={limitCard.label} value={limitCard.value} sub={limitCard.sub} trend={limitCard.trend} tone={limitCard.tone} />
            </div>

            <div className="dashboard-main-grid">
              <DashboardTransactions rows={activityFeed} onStart={() => goToView('withdraw')} onBuy={() => goToView('buy')} onViewAll={() => goToView('history')} onOpenRow={(id) => { setSelectedActivityId(id); goToView('history'); }} />
              <div className="dashboard-side-stack">
                {showTwoFactorRecommendation && <TwoFactorRecommendationCard completedCount={completedActivityCount} onEnable={goToSettingsSecurity} onDismiss={() => setTwoFactorPromptDismissedUntil(Date.now() + 7 * 24 * 60 * 60 * 1000)} />}
                {/* A FINISHED CHECKLIST IS NOT INFORMATION.
 
                    "Account setup 100%" with four green ticks tells the user
                    nothing they can act on - it just occupies the best space
                    on the dashboard forever, and its primary button ("Manage
                    payment methods") duplicates a sidebar link.
 
                    A setup card is scaffolding: it exists to get someone to
                    the finish line and should come down once they are past
                    it. Everything it reported is still visible - the
                    verification KPI shows the level, the account-status
                    banner shows the headroom, and Payment methods is one
                    click away in the sidebar.
 
                    setupPercent counts the three REQUIRED steps only (account,
                    verification, payout bank); WhatsApp is optional and
                    deliberately outside the maths, which is why the card can
                    read 100% with WhatsApp unlinked. Gating on the same number
                    the card displays means the card disappears exactly when it
                    claims to be done - it cannot hide while still showing
                    outstanding work. */}
                {/* AND NOT BEFORE THE SUMMARY LANDS, for the same reason:
                    isVerified and hasBank both fall back to "no" while the
                    call is in flight, so a finished user got a 33% setup
                    checklist that then deleted itself. */}
                {verificationSummaryLoaded && setupPercent < 100 && (

                  <DashboardSetupPanel setupPercent={setupPercent} hasUser={hasUser} isVerified={isVerified} hasBank={hasBank} user={user} summary={verificationSummary} onContinue={() => goToView(!isVerified ? 'kyc' : !hasBank ? 'banks' : 'banks')} />
                )}
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
                <button type="button" className={authTab === 'signup' ? 'active' : ''} onClick={() => { setAuthTab('signup'); resetPendingEmail(); if (window.location.pathname !== '/signup') window.history.pushState({}, '', '/signup'); }}>Create account</button>
                <button type="button" className={authTab === 'signin' ? 'active' : ''} onClick={() => { setAuthTab('signin'); resetPendingEmail(); if (window.location.pathname !== '/signin') window.history.pushState({}, '', '/signin'); }}>Sign in</button>
              </div>
              {!pendingEmail ? (
                <form className="form auth-form-premium" onSubmit={handleEmailAuthStart}>
                  <label>Email address<input name="email" type="email" placeholder="you@example.com" autoComplete="email" required /></label>
                  {authTab === 'signup' && <label>Full name<input name="fullName" placeholder="Hart James Lucas" autoComplete="name" required /></label>}
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
              <p>Buy stablecoins, withdraw to bank, receive virtual-account deposits, and use Transfer & Pay, all after secure verification.</p>
              <div className="auth-flow-preview">
                <div><span>1</span><strong>Email access</strong><small>One-time secure code</small></div>
                <div><span>2</span><strong>Verify once</strong><small>Unlock payments</small></div>
                <div><span>3</span><strong>Transfer & pay</strong><small>Use settled USDC</small></div>
              </div>
              <ul className="auth-benefit-list"><li>✓ Passwordless login</li><li>✓ Customer-safe provider routing</li><li>✓ Support-ready transaction timelines</li></ul>
            </article>
          </section>
        )}

        {view === 'kyc' && <VerificationPage hasUser={hasUser} userId={user?.id} api={api} customer={customer} customerTypes={paymentControls.customerTypes ?? fallbackCustomerTypes} kycFailed={kycFailed} canSubmitKyc={canSubmitKyc} kycActionLabel={kycActionLabel} verificationRedirectUri={verificationRedirectUri} summary={verificationSummary} summaryLoaded={verificationSummaryLoaded} onSubmit={handleKyc} onStartVerification={() => openVerification()} onStartBridgeVerification={openBridgeVerification} onRefresh={refreshKyc} onSupport={() => goToView('help')} onAddBank={() => goToView('banks')} onSell={() => goToView('withdraw')} hasBank={hasBank} displayCurrency={displayCurrency} displayFx={displayFx} />}

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
            ngnFeePercent={paymentControls.ngnOfframpFeePercent}
            loading={loading}
            canCreatePaymentActions={canCreatePaymentActions}
            onSubmit={handleWithdraw}
            onCancelReview={() => setWithdrawalReview(null)}
            onConfirm={confirmWithdrawal}
            ngnMode={ngnMode}
            ngnUserId={user?.id}
            ngnApi={api}
            ngnNetwork={ngnNetwork}
            /**
             * The admin-approved off-ramp networks, passed whole rather than
             * as a single pre-picked value, so the form can let the user
             * choose. The list already is the intersection of what an admin
             * enabled and what Breet can settle, so there is nothing to
             * filter here - filtering again is how a second opinion appears.
             */
            ngnNetworkOptions={ngnNetworks?.offramp ?? []}
            onNgnNetworkChange={setNgnNetwork}
            ngnAsset={ngnAsset}
            onNgnAssetChange={(asset) => {
              ngnAssetUserChosen.current = true;
              setNgnAsset(asset);
            }}
            withdrawAssetOptions={withdrawAssetOptions}

            ngnMinimumUsd={ngnNetworks?.offramp.find((option) => option.network === ngnNetwork)?.minimumDepositUsd}
            ngnRemainingNgn={ngnOfframpAllowance?.remainingNgn}
            /**
             * undefined while the balance is loading, null when the chain
             * could not be reached. The form distinguishes all three states,
             * because "we could not check" is not "you have nothing".
             */
            ngnSpendable={selectedNgnSpendable}
            ngnWindowDays={verificationSummary?.windowDays}
            /* From GET /api/ngn/networks, which this screen already awaits.
               Undefined until it answers, which reads as OFF - the withdraw
               form tests `=== true`. */
            ngnExternalFundingEnabled={ngnNetworks?.externalFundingEnabled}
            ngnThirdPartyPayoutsEnabled={ngnNetworks?.thirdPartyPayoutsEnabled}
            onNgnReady={handleNgnReady}
            onExitNgn={() => { setNgnMode(false); setWithdrawalReview(null); }}
            onEnterNgn={() => setNgnMode(true)}
            ngnAvailable={(ngnNetworks?.offramp.length ?? 0) > 0}
          />
        )}

        {view === 'receive' && <ReceiveView wallets={userWallets} enabledAssets={enabledAssets} enabledNetworks={enabledNetworks} isVerified={isVerified} hasPayoutAccount={hasBank} onAddBank={() => goToView('banks')} loading={loading} walletsEnabled onCreateWallet={handleCreateWallet} onRefresh={loadUserWallets} />}
        {view === 'buy' && <BuyCryptoView hasUser={hasUser} isVerified={isVerified} bridgeBlockedReason={buyBlockedReason} onVerifyWithId={openBridgeVerification} feePercent={feePolicy?.percent || '1.25'} enabledControls={enabledControls} enabledAssets={enabledAssets} enabledNetworks={enabledNetworks} orders={onrampOrders} loading={loading} onSubmit={handleOnramp} onSell={() => goToView('withdraw')} onContinue={() => goToView(hasUser ? isVerified ? 'banks' : 'kyc' : 'signup')} onSupport={() => goToView('help')} onRefreshOrders={loadUserData} />}
        {view === 'transfer' && <TransferCryptoView hasUser={hasUser} isVerified={isVerified} supplierPayoutsEnabled={paymentControls.supplierPayoutsEnabled !== false} transfersEnabled={paymentControls.transfersEnabled !== false} api={api} enabledAssets={enabledAssets} balance={balance} unifiedBalance={unifiedBalance} transfers={balanceTransfers} suppliers={suppliers} supplierPayments={supplierPayments} enabledNetworks={enabledNetworks} networkMode={userPreferences?.networkMode} loading={loading} onSubmit={handleBalanceTransfer} onCreateSupplier={handleCreateSupplier} onSupplierPayment={handleSupplierPayment} onContinue={() => goToView(hasUser ? isVerified ? 'buy' : 'kyc' : 'signup')} onRefresh={loadUserData} />}

        {view === 'history' && <TransactionsView user={user} api={api} withdrawals={withdrawals} onrampOrders={onrampOrders} ngnTransfers={ngnTransfers} balanceTransfers={balanceTransfers} supplierPayments={supplierPayments} virtualAccountTransactions={virtualAccountTransactions} walletDeposits={walletDeposits} serviceAgreements={serviceAgreements} networkMode={userPreferences?.networkMode} initialSelectedId={selectedActivityId} onStart={() => goToView('withdraw')} onBuy={() => goToView('buy')} onRefresh={loadUserData} />}

        {view === 'agreements' && (
          <ServiceAgreementsView
            user={user}
            serviceAgreements={serviceAgreements}
            api={api}
            onRefresh={loadUserData}
            onGoToTransactions={() => goToView('history')}
          />
        )}

        {view === 'settings' && <SettingsView api={api} user={user} isVerified={isVerified} onUserUpdated={(updated) => { setUser(updated); localStorage.setItem('sivan.user', JSON.stringify(updated)); }} preferences={userPreferences} initialTab={settingsInitialTab} twoFactorStatus={twoFactorStatus} onTwoFactorStatusChanged={setTwoFactorStatus} identityStatus={identityStatus} pairingCode={pairingCode} pairingExpiresAt={pairingExpiresAt} timeNow={timeNow} onStartWhatsappLink={handleStartWhatsappLink} onCancelWhatsappLink={handleCancelWhatsappLink} onUnlinkWhatsapp={handleUnlinkWhatsapp} telegramPairingCode={telegramPairingCode} telegramPairingExpiresAt={telegramPairingExpiresAt} onStartTelegramLink={handleStartTelegramLink} onCancelTelegramLink={handleCancelTelegramLink} onUnlinkTelegram={handleUnlinkTelegram} onRefreshIdentity={loadUserData} onSavePreferences={handleSaveUserPreferences} onUpdatePreferences={handleUpdateUserPreferences} loading={loading} onLogout={() => logout('Signed out successfully.')} />}
        {view === 'help' && <SupportView hasUser={hasUser} user={user} tickets={supportTickets} withdrawals={withdrawals} onrampOrders={onrampOrders} accounts={accounts} customer={customer} api={api} onCreateTicket={handleCreateSupportTicket} onTicketsChanged={setSupportTickets} loading={loading} />}

      </main>

      {/* Rendered at the root, outside <main>, so the overlay covers the whole
          viewport rather than being clipped by the scroll container. */}
      <VerificationModal
        open={verificationOpen}
        plan={verificationPlan ?? localVerificationPlan(user?.country)}
        userId={user?.id ?? ''}
        fullName={user?.fullName ?? ''}
        country={user?.country}
        api={api}
        loading={loading}
        onClose={() => { setVerificationOpen(false); setRequestedVerificationPath(undefined); setManualKycUrl(undefined); }}
        onCountryChange={handleCountryChange}
        onVerified={handleNgnVerified}
        onStartBridge={startBridgeVerification}
        startingBridge={startingBridge}
        manualKycUrl={manualKycUrl}
        requestedPath={requestedVerificationPath}
        dateOfBirth={user?.dateOfBirth}
        onDateOfBirthChange={handleDateOfBirthChange}
      />

      <ConfirmModal
        open={unlinkModal.open}
        title={unlinkModal.title}
        description={unlinkModal.description}
        confirmLabel="Unlink Identity"
        isDestructive
        loading={loading}
        onConfirm={executeUnlink}
        onCancel={() => setUnlinkModal((m) => ({ ...m, open: false }))}
      />
    </div>
  );
}
