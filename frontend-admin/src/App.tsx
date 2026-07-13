import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AdminAnalytics,
  AdminAuditLog,
  AdminReconciliationRun,
  AdminOverview,
  AdminUser,
  AdminViewKey,
  AdminWithdrawal,
  EconomicsEstimate,
  OfframpControls,
  PaymentControl,
  ProviderCapability,
  ReconciliationResult,
  SystemStatus,
  RoutingDecision,
  WebhookEventRecord
} from './types';

const nav: Array<{ key: AdminViewKey; icon: string; label: string }> = [
  { key: 'overview', icon: '◆', label: 'Command' },
  { key: 'controls', icon: '◌', label: 'Controls' },
  { key: 'analytics', icon: '▧', label: 'Analytics' },
  { key: 'users', icon: '👥', label: 'Users' },
  { key: 'withdrawals', icon: '↗', label: 'Withdrawals' },
  { key: 'reconciliation', icon: '⟳', label: 'Reconciliation' },
  { key: 'providers', icon: '◈', label: 'Providers' },
  { key: 'webhooks', icon: '☷', label: 'Webhooks' },
  { key: 'audit', icon: '▤', label: 'Audit' },
  { key: 'economics', icon: '◎', label: 'Economics' },
  { key: 'settings', icon: '⚙', label: 'Settings' }
];

function getForm(form: HTMLFormElement) {
  return Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'Request failed');
}

function statusClass(status?: string) {
  if (!status) return 'pending';
  if (['completed', 'active', 'verified', 'approved', 'kyc_approved', 'processed'].includes(status)) return 'success';
  if (['failed', 'error', 'cancelled', 'kyc_rejected', 'provider_error'].includes(status)) return 'danger';
  return 'pending';
}

function Badge({ value }: { value?: string }) {
  return <span className={`badge ${statusClass(value)}`}>{value || 'unknown'}</span>;
}

function Empty({ children }: { children: string }) {
  return <div className="empty-state">{children}</div>;
}

function Kv({ label, value }: { label: string; value?: string | number | null }) {
  return <div className="kv"><span>{label}</span><strong>{value ?? '—'}</strong></div>;
}

const fallbackCustomerTypes = [
  { customerType: 'individual' as const, enabled: true, label: 'Individual', updatedAt: new Date().toISOString() },
  { customerType: 'business' as const, enabled: false, label: 'Business', updatedAt: new Date().toISOString() }
];

const fallbackSourceAssets: any[] = [
  { asset: 'usdc', enabled: true, label: 'USDC', updatedAt: new Date().toISOString() },
  { asset: 'usdt', enabled: false, label: 'USDT', updatedAt: new Date().toISOString() }
];

const fallbackSourceNetworks: any[] = [
  { network: 'base', enabled: true, label: 'Base', sortOrder: 10, updatedAt: new Date().toISOString() },
  { network: 'polygon', enabled: true, label: 'Polygon', sortOrder: 20, updatedAt: new Date().toISOString() },
  { network: 'ethereum', enabled: true, label: 'Ethereum', sortOrder: 30, updatedAt: new Date().toISOString() },
  { network: 'solana', enabled: true, label: 'Solana', sortOrder: 40, updatedAt: new Date().toISOString() },
  { network: 'arbitrum', enabled: true, label: 'Arbitrum', sortOrder: 50, updatedAt: new Date().toISOString() },
  { network: 'avalanche_c_chain', enabled: true, label: 'Avalanche C-Chain', sortOrder: 60, updatedAt: new Date().toISOString() }
];

function normalizeOfframpControls(value: unknown): any {
  const data = value as any;
  if (Array.isArray(data)) {
    return { customerTypes: fallbackCustomerTypes, payoutCurrencies: data, sourceAssets: fallbackSourceAssets, sourceNetworks: fallbackSourceNetworks };
  }
  return {
    customerTypes: data?.customerTypes ?? fallbackCustomerTypes,
    payoutCurrencies: data?.payoutCurrencies ?? [],
    sourceAssets: data?.sourceAssets ?? fallbackSourceAssets,
    sourceNetworks: data?.sourceNetworks ?? fallbackSourceNetworks
  };
}

export default function App() {
  const [view, setView] = useState<AdminViewKey>('overview');
  const [apiBase, setApiBase] = useState(() => localStorage.getItem('sivan.admin.apiBase') || import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000');
  const [apiDraft, setApiDraft] = useState(apiBase);
  const [adminApiKey, setAdminApiKey] = useState(() => localStorage.getItem('sivan.admin.apiKey') || '');
  const [adminApiKeyDraft, setAdminApiKeyDraft] = useState(adminApiKey);
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);

  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [analytics, setAnalytics] = useState<AdminAnalytics | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [withdrawals, setWithdrawals] = useState<AdminWithdrawal[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookEventRecord[]>([]);
  const [auditLogs, setAuditLogs] = useState<AdminAuditLog[]>([]);
  const [reconciliationRuns, setReconciliationRuns] = useState<AdminReconciliationRun[]>([]);
  const [providers, setProviders] = useState<ProviderCapability[]>([]);
  const [paymentControls, setPaymentControls] = useState<OfframpControls>({ customerTypes: fallbackCustomerTypes, payoutCurrencies: [], sourceAssets: [], sourceNetworks: [] });
  const [systemStatus, setSystemStatus] = useState<SystemStatus>({ id: 'global', mode: 'active', updatedAt: new Date().toISOString() });
  const [routingDecision, setRoutingDecision] = useState<RoutingDecision | null>(null);
  const [reconciliation, setReconciliation] = useState<ReconciliationResult | null>(null);
  const [estimate, setEstimate] = useState<EconomicsEstimate | null>(null);

  const pageTitle = useMemo(() => nav.find((item) => item.key === view)?.label || 'Command', [view]);

  const notify = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 5000);
  }, []);

  const api = useCallback(async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(adminApiKey ? { 'x-admin-api-key': adminApiKey } : {}), ...(options.headers || {}) }
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json?.error?.message || `${response.status} ${response.statusText}`);
    return (json.data ?? json) as T;
  }, [apiBase, adminApiKey]);

  const checkApi = useCallback(async () => {
    try {
      await api('/health');
      setApiOnline(true);
    } catch {
      setApiOnline(false);
    }
  }, [api]);

  const refreshAdmin = useCallback(async () => {
    setLoading(true);
    setAdminError(null);
    try {
      await checkApi();
      const [overviewResult, analyticsResult, usersResult, withdrawalsResult, webhooksResult, auditLogsResult, reconciliationRunsResult, providersResult, controlsResult, systemStatusResult] = await Promise.allSettled([
        api<AdminOverview>('/api/admin/overview'),
        api<AdminAnalytics>('/api/admin/analytics'),
        api<AdminUser[]>('/api/admin/users'),
        api<AdminWithdrawal[]>('/api/admin/withdrawals'),
        api<WebhookEventRecord[]>('/api/admin/webhooks'),
        api<AdminAuditLog[]>('/api/admin/audit-logs'),
        api<AdminReconciliationRun[]>('/api/admin/reconciliation/runs'),
        api<ProviderCapability[]>('/api/providers/offramp/capabilities'),
        api<unknown>('/api/admin/offramp/controls'),
        api<SystemStatus>('/api/admin/system/status')
      ]);
      if (overviewResult.status === 'fulfilled') setOverview(overviewResult.value);
      if (analyticsResult.status === 'fulfilled') setAnalytics(analyticsResult.value);
      if (usersResult.status === 'fulfilled') setUsers(usersResult.value);
      if (withdrawalsResult.status === 'fulfilled') setWithdrawals(withdrawalsResult.value);
      if (webhooksResult.status === 'fulfilled') setWebhooks(webhooksResult.value);
      if (auditLogsResult.status === 'fulfilled') setAuditLogs(auditLogsResult.value);
      if (reconciliationRunsResult.status === 'fulfilled') setReconciliationRuns(reconciliationRunsResult.value);
      if (providersResult.status === 'fulfilled') setProviders(providersResult.value);
      if (controlsResult.status === 'fulfilled') setPaymentControls(normalizeOfframpControls(controlsResult.value));
      if (systemStatusResult.status === 'fulfilled') setSystemStatus(systemStatusResult.value);
      if (controlsResult.status === 'rejected') setAdminError(errorMessage(controlsResult.reason));
      if (overviewResult.status === 'rejected') setAdminError(errorMessage(overviewResult.reason));
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [api, checkApi, notify]);

  useEffect(() => {
    localStorage.setItem('sivan.admin.apiBase', apiBase);
  }, [apiBase]);

  useEffect(() => {
    if (adminApiKey) localStorage.setItem('sivan.admin.apiKey', adminApiKey);
    else localStorage.removeItem('sivan.admin.apiKey');
  }, [adminApiKey]);

  useEffect(() => {
    void refreshAdmin();
  }, [refreshAdmin]);

  useEffect(() => {
    const openControls = () => setView('controls');
    window.addEventListener('sivan-admin-open-controls', openControls);
    return () => window.removeEventListener('sivan-admin-open-controls', openControls);
  }, []);

  useEffect(() => {
    if (view !== 'analytics') return;
    const interval = window.setInterval(() => void refreshAdmin(), 60_000);
    const onFocus = () => void refreshAdmin();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshAdmin, view]);

  async function runReconciliation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    try {
      const data = getForm(event.currentTarget);
      const result = await api<ReconciliationResult>('/api/admin/reconciliation/run', {
        method: 'POST',
        body: JSON.stringify({
          dryRun: data.dryRun === 'true',
          provider: data.provider || undefined,
          userId: data.userId || undefined,
          liquidationAddressId: data.liquidationAddressId || undefined
        })
      });
      setReconciliation(result);
      notify(result.dryRun ? 'Dry-run reconciliation completed.' : 'Live reconciliation completed.');
      await refreshAdmin();
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function testRoute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const data = getForm(event.currentTarget);
      const result = await api<RoutingDecision>('/api/providers/offramp/route', {
        method: 'POST',
        body: JSON.stringify({
          sourceCurrency: 'usdc',
          sourceChain: data.sourceChain,
          destinationCurrency: data.destinationCurrency,
          destinationCountry: data.destinationCountry,
          destinationPaymentRail: data.destinationPaymentRail,
          complianceModel: data.complianceModel,
          requiredSpeed: data.requiredSpeed
        })
      });
      setRoutingDecision(result);
    } catch (error) {
      notify((error as Error).message, 'error');
    }
  }

  async function runEconomicsEstimate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const data = getForm(event.currentTarget);
      const result = await api<EconomicsEstimate>('/api/fees/economics/estimate', {
        method: 'POST',
        body: JSON.stringify({
          amount: data.amount,
          currency: 'usd',
          customerType: data.customerType,
          includeOnboardingCost: data.includeOnboardingCost === 'true',
          thirdPartyRailFee: data.thirdPartyRailFee || '0'
        })
      });
      setEstimate(result);
    } catch (error) {
      notify((error as Error).message, 'error');
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><img className="brand-logo" src="/asset/sivan-logo.png" alt="Sivan logo" /><div><p className="eyebrow">Sivan</p><h1>Admin</h1></div></div>
        <nav className="nav">{nav.map((item) => <button key={item.key} className={`nav-item ${view === item.key ? 'active' : ''}`} onClick={() => setView(item.key)}><span>{item.icon}</span>{item.label}</button>)}</nav>
        <div className="api-card"><label>API base</label><input value={apiDraft} onChange={(event) => setApiDraft(event.target.value)} /><button className="ghost-btn" onClick={() => { setApiBase(apiDraft.replace(/\/$/, '')); notify('Admin API URL saved.'); }}>Save API URL</button><label>Admin API key</label><input type="password" value={adminApiKeyDraft} onChange={(event) => setAdminApiKeyDraft(event.target.value)} placeholder="Required when backend ADMIN_API_KEY is set" /><button className="ghost-btn" onClick={() => { setAdminApiKey(adminApiKeyDraft); notify('Admin API key saved locally.'); }}>Save Admin Key</button><p className="hint">Save the Admin API key, then click Refresh. API connected only checks public health; controls require the admin key.</p></div>
      </aside>

      <main className="main">
        <header className="topbar"><div><p className="eyebrow">Production Admin Control Center</p><h2>{pageTitle}</h2></div><div className="top-actions"><div className={`status-pill ${apiOnline === true ? 'ok' : apiOnline === false ? 'bad' : ''}`}><span />{apiOnline === true ? 'API connected' : apiOnline === false ? 'API offline' : 'Checking API'}</div><button className="secondary-btn" onClick={refreshAdmin}>{loading ? 'Loading...' : 'Refresh'}</button></div></header>
        <div className="admin-warning">Internal controls. Do not expose this dashboard without admin authentication, RBAC, 2FA, and audit logging.</div>
        {toast && <section className={`toast ${toast.type === 'error' ? 'error' : ''}`}>{toast.message}</section>}

        {view === 'overview' && <Overview overview={overview} withdrawals={withdrawals} />}
        {view === 'analytics' && <Analytics analytics={analytics} />}
        {view === 'users' && <Users users={users} />}
        {view === 'withdrawals' && <Withdrawals withdrawals={withdrawals} />}
        {view === 'reconciliation' && <Reconciliation onRun={runReconciliation} result={reconciliation} loading={loading} />}
        {view === 'providers' && <Providers providers={providers} routingDecision={routingDecision} onRoute={testRoute} />}
        {view === 'controls' && <Controls controls={paymentControls} systemStatus={systemStatus} api={api} onUpdated={refreshAdmin} notify={notify} hasAdminKey={Boolean(adminApiKey)} error={adminError} />}
        {view === 'webhooks' && <Webhooks webhooks={webhooks} />}
        {view === 'audit' && <Audit auditLogs={auditLogs} reconciliationRuns={reconciliationRuns} />}
        {view === 'economics' && <Economics overview={overview} estimate={estimate} onEstimate={runEconomicsEstimate} />}
        {view === 'settings' && <Settings apiBase={apiBase} />}
      </main>
    </div>
  );
}

function Stat({ label, value, helper }: { label: string; value: string | number; helper?: string }) {
  return <article className="stat-card"><p>{label}</p><strong>{value}</strong><span>{helper}</span></article>;
}

function Overview({ overview, withdrawals }: { overview: AdminOverview | null; withdrawals: AdminWithdrawal[] }) {
  if (!overview) return <Empty>No admin overview loaded.</Empty>;
  return <section><div className="hero-card glass"><div><p className="eyebrow">Operational overview</p><h3>Monitor money movement, provider health, and onboarding economics.</h3><p className="muted">This dashboard is the internal command center for Sivan off-ramp operations.</p></div><div className="flow-card"><div className="flow-node">Users</div><div className="flow-line" /><div className="flow-node">KYC/KYB</div><div className="flow-line" /><div className="flow-node">USDC deposits</div><div className="flow-line" /><div className="flow-node accent">Bank payouts</div></div></div><div className="stats-grid"><Stat label="Users" value={overview.counts.users} helper="Total signed up" /><Stat label="Withdrawals" value={overview.counts.withdrawals} helper="All statuses" /><Stat label="Webhook events" value={overview.counts.webhookEvents} helper="Stored events" /><Stat label="Unrecovered KYC" value={`$${overview.metrics.recovery.unrecoveredOnboardingCostUsd}`} helper="Estimated" /></div><div className="panel-grid two"><ControlsQuickCard overview={overview} onOpenControls={() => window.dispatchEvent(new CustomEvent('sivan-admin-open-controls'))} /><EconomicsSummary overview={overview} /></div><div className="panel-grid"><Withdrawals withdrawals={withdrawals.slice(0, 5)} compact /></div></section>;
}


function ControlsQuickCard({ overview, onOpenControls }: { overview: AdminOverview; onOpenControls: () => void }) {
  const metrics = overview.metrics;
  return (
    <article className="panel control-highlight">
      <div className="panel-head"><div><p className="eyebrow">Rail controls</p><h3>Manage USD, GBP, and EUR availability</h3></div></div>
      <p className="muted">Turn payout currencies on/off from one place. Disabled rails are hidden from the user app and blocked by the backend.</p>
      <div className="details-box">
        <Kv label="Current configured fee" value={`${metrics.recovery.sivanOfframpFeePercent}%`} />
        <Kv label="Control scope" value="Frontend + Backend enforcement" />
        <Kv label="Available currencies" value="USD / GBP / EUR" />
      </div>
      <button className="primary-btn" onClick={onOpenControls}>Open Controls</button>
    </article>
  );
}

function EconomicsSummary({ overview }: { overview: AdminOverview }) {
  const m = overview.metrics;
  return <article className="panel"><div className="panel-head"><div><p className="eyebrow">Economics</p><h3>KYC recovery</h3></div></div><div className="details-box"><Kv label="Potential KYC exposure" value={`$${m.signupExposure.potentialKycCostIfEverySignupVerifiesUsd}`} /><Kv label="Actual onboarding cost" value={`$${m.onboardingCosts.totalOnboardingCostUsd}`} /><Kv label="Sivan fee revenue" value={`$${m.recovery.sivanDeveloperFeeRevenueUsd}`} /><Kv label="Bridge off-ramp cost" value={`$${m.recovery.estimatedBridgeOfframpCostUsd}`} /><Kv label="Recovered" value={`$${m.recovery.onboardingCostRecoveredUsd}`} /><Kv label="Unrecovered" value={`$${m.recovery.unrecoveredOnboardingCostUsd}`} /><Kv label="Net after onboarding" value={`$${m.recovery.netAfterOnboardingUsd}`} /></div></article>;
}


function Analytics({ analytics }: { analytics: AdminAnalytics | null }) {
  if (!analytics) return <Empty>No analytics loaded.</Empty>;
  const latestWindow = analytics.windows[0];
  return (
    <section>
      <div className="hero-card glass">
        <div>
          <p className="eyebrow">User activity analytics</p>
          <h3>Track active, returning, new, churning, and dormant users.</h3>
          <p className="muted">Windows are calculated from tracked product activity: signup, verification, bank accounts, withdrawals, completions, and webhook processing.</p>
        </div>
        <div className="flow-card">
          <div className="flow-node">Signup</div><div className="flow-line" />
          <div className="flow-node">KYC / KYB</div><div className="flow-line" />
          <div className="flow-node">Bank + Withdraw</div><div className="flow-line" />
          <div className="flow-node accent">Returning usage</div>
        </div>
      </div>

      <div className="stats-grid">
        <Stat label="Total users" value={analytics.totals.users} helper="All signed up users" />
        <Stat label="Tracked activities" value={analytics.totals.activities} helper="Auto-refreshes on this tab every 60 seconds" />
        <Stat label="7D active" value={latestWindow?.activeUsers ?? 0} helper="Users active in 7 days" />
        <Stat label="7D returning" value={latestWindow?.returningUsers ?? 0} helper="Had prior activity" />
      </div>

      <div className="stats-grid">
        <Stat label="Avg lifetime volume/user" value={`$${analytics.profitability.averageLifetimeVolumePerUserUsd}`} helper="Completed volume / all users" />
        <Stat label="Avg withdrawal size" value={`$${analytics.profitability.averageWithdrawalSizeUsd}`} helper="Completed withdrawals" />
        <Stat label="Repeat withdrawal rate" value={`${analytics.profitability.repeatWithdrawalRatePercent}%`} helper={`${analytics.profitability.repeatUsers} repeat users`} />
        <Stat label="Failed withdrawal rate" value={`${analytics.profitability.failedWithdrawalRatePercent}%`} helper={`${analytics.profitability.failedWithdrawalCount} failed/cancelled`} />
      </div>

      <div className="panel-grid two">
        <article className="panel">
          <div className="panel-head"><div><p className="eyebrow">Cohorts</p><h3>Activity windows</h3></div></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Window</th><th>Active</th><th>Returning</th><th>New</th><th>Churning</th><th>Dormant</th></tr></thead>
              <tbody>{analytics.windows.map((window) => <tr key={window.days}><td>{window.days} days</td><td>{window.activeUsers}</td><td>{window.returningUsers}</td><td>{window.newUsers}</td><td>{window.churningUsers}</td><td>{window.dormantUsers}</td></tr>)}</tbody>
            </table>
          </div>
        </article>

        <article className="panel">
          <div className="panel-head"><div><p className="eyebrow">Definitions</p><h3>How to read it</h3></div></div>
          <div className="details-box">
            {Object.entries(analytics.definitions).map(([key, value]) => <Kv key={key} label={key} value={value} />)}
          </div>
        </article>
      </div>

      <div className="panel-grid two">
        <article className="panel">
          <div className="panel-head"><div><p className="eyebrow">Profitability</p><h3>Unit economics tracking</h3></div></div>
          <div className="details-box">
            <Kv label="Average lifetime volume / user" value={`$${analytics.profitability.averageLifetimeVolumePerUserUsd}`} />
            <Kv label="Average lifetime volume / transacting user" value={`$${analytics.profitability.averageLifetimeVolumePerTransactingUserUsd}`} />
            <Kv label="Withdrawal volume / user" value={`$${analytics.profitability.withdrawalVolumePerUserUsd}`} />
            <Kv label="Withdrawal volume / transacting user" value={`$${analytics.profitability.withdrawalVolumePerTransactingUserUsd}`} />
            <Kv label="KYC cost recovery / KYC user" value={`$${analytics.profitability.kycCostRecoveryPerKycUserUsd}`} />
          </div>
        </article>
        <article className="panel">
          <div className="panel-head"><div><p className="eyebrow">Margin</p><h3>Revenue, cost, and net margin</h3></div></div>
          <div className="details-box">
            <Kv label="Sivan fee revenue" value={`$${analytics.profitability.sivanFeeRevenueUsd}`} />
            <Kv label="Provider cost" value={`$${analytics.profitability.providerCostUsd}`} />
            <Kv label="Bridge variable cost" value={`$${analytics.profitability.bridgeVariableCostUsd}`} />
            <Kv label="Onboarding cost" value={`$${analytics.profitability.onboardingCostUsd}`} />
            <Kv label="Customer acquisition cost" value={`$${analytics.profitability.customerAcquisitionCostTotalUsd}`} />
            <Kv label="Net margin before CAC" value={`$${analytics.profitability.netMarginBeforeCacUsd}`} />
            <Kv label="Net margin after CAC" value={`$${analytics.profitability.netMarginAfterCacUsd}`} />
          </div>
        </article>
      </div>

      <div className="panel-grid two">
        <article className="panel">
          <div className="panel-head"><div><p className="eyebrow">Recent</p><h3>User activities</h3></div></div>
          {!analytics.recentActivities.length ? <Empty>No activities found.</Empty> : <div className="list">{analytics.recentActivities.slice(0, 30).map((activity) => <div className="list-item" key={activity.id}><strong>{activity.label}</strong><Badge value={activity.type} /><small>{activity.user?.email || activity.userId}</small><small>{new Date(activity.occurredAt).toLocaleString()}</small></div>)}</div>}
        </article>

        <article className="panel">
          <div className="panel-head"><div><p className="eyebrow">Users</p><h3>Last activity</h3></div></div>
          {!analytics.users.length ? <Empty>No users found.</Empty> : <div className="table-wrap"><table className="table"><thead><tr><th>User</th><th>KYC</th><th>Activities</th><th>Withdrawals</th><th>Completed</th><th>Last activity</th></tr></thead><tbody>{analytics.users.slice().sort((a,b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()).map((user) => <tr key={user.id}><td>{user.email}</td><td><Badge value={user.kycStatus} /></td><td>{user.activityCount}</td><td>{user.withdrawalCount}</td><td>{user.completedWithdrawalCount}</td><td>{new Date(user.lastActivityAt).toLocaleString()}</td></tr>)}</tbody></table></div>}
        </article>
      </div>
    </section>
  );
}

function Users({ users }: { users: AdminUser[] }) {
  return <article className="panel"><div className="panel-head"><div><p className="eyebrow">Identity</p><h3>Users and KYC/KYB</h3></div></div>{!users.length ? <Empty>No users found.</Empty> : <div className="table-wrap"><table className="table"><thead><tr><th>User</th><th>Email</th><th>KYC</th><th>Type</th><th>Onboarding cost</th><th>Accounts</th><th>Withdrawals</th></tr></thead><tbody>{users.map((user) => <tr key={user.id}><td>{user.id}</td><td>{user.email}</td><td><Badge value={user.customer?.kycStatus || 'not_started'} /></td><td>{user.customer?.customerType || '—'}</td><td>{user.customer?.onboardingCostUsd ? `$${user.customer.onboardingCostUsd}` : '—'}</td><td>{user.externalAccountCount}</td><td>{user.withdrawalCount}</td></tr>)}</tbody></table></div>}</article>;
}

function Withdrawals({ withdrawals, compact = false }: { withdrawals: AdminWithdrawal[]; compact?: boolean }) {
  return <article className="panel"><div className="panel-head"><div><p className="eyebrow">Off-ramp</p><h3>{compact ? 'Recent withdrawals' : 'Withdrawal operations'}</h3></div></div>{!withdrawals.length ? <Empty>No withdrawals found.</Empty> : <div className="table-wrap"><table className="table"><thead><tr><th>ID</th><th>User</th><th>Status</th><th>Provider</th><th>Currency</th><th>Amount</th><th>Fee</th><th>Rail</th><th>Created</th></tr></thead><tbody>{withdrawals.map((w) => <tr key={w.id}><td>{w.id}</td><td>{w.user?.email || w.userId}</td><td><Badge value={w.status} /></td><td>{w.provider}</td><td>{w.destinationCurrency?.toUpperCase()}</td><td>{w.destinationAmount || '—'}</td><td>{w.feeAmount || w.feePercent || '—'}</td><td>{w.liquidationAddress?.destinationPaymentRail || w.externalAccount?.paymentRail || '—'}</td><td>{new Date(w.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div>}</article>;
}

function Reconciliation({ onRun, result, loading }: { onRun: (event: FormEvent<HTMLFormElement>) => void; result: ReconciliationResult | null; loading: boolean }) {
  return <section className="panel-grid two"><article className="panel form-panel"><p className="eyebrow">Controls</p><h3>Run reconciliation</h3><p className="muted">Compare Sivan withdrawals with provider drain history. Always run dry-run first.</p><form className="form" onSubmit={onRun}><label>Mode<select name="dryRun" defaultValue="true"><option value="true">Dry-run only</option><option value="false">Live update records</option></select></label><label>Provider<input name="provider" placeholder="bridge" /></label><label>User ID<input name="userId" placeholder="optional" /></label><label>Liquidation address ID<input name="liquidationAddressId" placeholder="optional" /></label><button className="primary-btn" disabled={loading}>{loading ? 'Running...' : 'Run reconciliation'}</button></form></article><article className="panel"><div className="panel-head"><div><p className="eyebrow">Result</p><h3>Findings</h3></div></div>{!result ? <Empty>No reconciliation run yet.</Empty> : <><div className="stats-grid mini"><Stat label="Dry-run" value={result.dryRun ? 'Yes' : 'No'} /><Stat label="Drains" value={result.summary.checkedDrains} /><Stat label="Updated" value={result.summary.updatedWithdrawals} /><Stat label="Errors" value={result.summary.providerErrors} /></div><div className="list">{result.findings.length ? result.findings.map((finding, index) => <div className="list-item" key={index}><strong>{finding.type}</strong><Badge value={finding.severity} /><small>{finding.message}</small><small>{finding.withdrawalId || finding.liquidationAddressId || finding.providerDrainId || ''}</small></div>) : <Empty>No findings.</Empty>}</div></>}</article></section>;
}

function Providers({ providers, routingDecision, onRoute }: { providers: ProviderCapability[]; routingDecision: RoutingDecision | null; onRoute: (event: FormEvent<HTMLFormElement>) => void }) {
  return <section className="panel-grid two"><article className="panel"><div className="panel-head"><div><p className="eyebrow">Routing catalog</p><h3>Provider capabilities</h3></div></div>{!providers.length ? <Empty>No providers configured.</Empty> : <div className="list">{providers.map((provider) => <div className="list-item" key={provider.name}><strong>{provider.name}</strong><Badge value={provider.available ? 'active' : 'inactive'} /><small>Rails: {provider.destinationPaymentRails.join(', ')}</small><small>Currencies: {provider.destinationCurrencies.join(', ')}</small><small>Reliability: {provider.reliability} · Speed: {provider.speed} · Priority: {provider.priority}</small></div>)}</div>}</article><article className="panel form-panel"><p className="eyebrow">Router</p><h3>Test provider selection</h3><form className="form" onSubmit={onRoute}><label>Source chain<select name="sourceChain" defaultValue="ethereum"><option value="ethereum">Ethereum</option><option value="base">Base</option><option value="polygon">Polygon</option><option value="solana">Solana</option><option value="arbitrum">Arbitrum</option><option value="avalanche_c_chain">Avalanche C-Chain</option></select></label><label>Destination currency<select name="destinationCurrency" defaultValue="usd"><option value="usd">USD</option><option value="gbp">GBP</option><option value="eur">EUR</option></select></label><label>Country<input name="destinationCountry" defaultValue="USA" /></label><label>Rail<input name="destinationPaymentRail" defaultValue="ach" /></label><label>Compliance model<select name="complianceModel" defaultValue="first_party_withdrawal"><option value="first_party_withdrawal">First-party withdrawal</option><option value="third_party_payout">Third-party payout</option><option value="b2b_supplier_payout">B2B supplier payout</option></select></label><label>Required speed<select name="requiredSpeed" defaultValue="standard"><option value="standard">Standard</option><option value="same_day">Same day</option><option value="instant">Instant</option></select></label><button className="primary-btn">Route provider</button></form>{routingDecision && <div className="estimate-box"><Kv label="Selected" value={routingDecision.providerName} /><Kv label="Reason" value={routingDecision.reason} /></div>}</article></section>;
}


function Audit({ auditLogs, reconciliationRuns }: { auditLogs: AdminAuditLog[]; reconciliationRuns: AdminReconciliationRun[] }) {
  return (
    <section className="panel-grid two">
      <article className="panel">
        <div className="panel-head"><div><p className="eyebrow">Audit trail</p><h3>Admin and user actions</h3></div></div>
        {!auditLogs.length ? <Empty>No audit logs found.</Empty> : <div className="table-wrap"><table className="table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>Severity</th></tr></thead><tbody>{auditLogs.slice(0, 200).map((log) => <tr key={log.id}><td>{new Date(log.createdAt).toLocaleString()}</td><td>{log.actorType}{log.actorId ? ` · ${log.actorId}` : ''}</td><td>{log.action}</td><td>{log.resourceType || '—'}{log.resourceId ? ` · ${log.resourceId}` : ''}</td><td><Badge value={log.severity} /></td></tr>)}</tbody></table></div>}
      </article>
      <article className="panel">
        <div className="panel-head"><div><p className="eyebrow">Reconciliation history</p><h3>Persisted runs</h3></div></div>
        {!reconciliationRuns.length ? <Empty>No reconciliation runs found.</Empty> : <div className="list">{reconciliationRuns.slice(0, 100).map((run) => <div className="list-item" key={run.id}><strong>{run.dryRun ? 'Dry-run' : 'Live run'} · {run.id}</strong><Badge value={run.status} /><small>{new Date(run.startedAt).toLocaleString()} · Findings: {run.findings.length}</small><small>Summary: {JSON.stringify(run.summary ?? {})}</small></div>)}</div>}
      </article>
    </section>
  );
}


function Controls({ controls, systemStatus, api, onUpdated, notify, hasAdminKey, error }: { controls: OfframpControls; systemStatus: SystemStatus; api: <T>(path: string, options?: RequestInit) => Promise<T>; onUpdated: () => Promise<void>; notify: (message: string, type?: 'success' | 'error') => void; hasAdminKey: boolean; error: string | null }) {
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [statusDraft, setStatusDraft] = useState(systemStatus.mode);
  const [statusMessage, setStatusMessage] = useState(systemStatus.message || '');
  useEffect(() => {
    setStatusDraft(systemStatus.mode);
    setStatusMessage(systemStatus.message || '');
  }, [systemStatus]);

  async function updateSystemMode() {
    setSavingKey('system');
    try {
      await api('/api/admin/system/status', {
        method: 'PUT',
        body: JSON.stringify({ mode: statusDraft, message: statusMessage || undefined })
      });
      notify(`System mode updated to ${statusDraft}.`);
      await onUpdated();
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setSavingKey(null);
    }
  }

  const normalizedControls = normalizeOfframpControls(controls);
  const customerTypes = normalizedControls.customerTypes ?? fallbackCustomerTypes;
  const payoutCurrencies = normalizedControls.payoutCurrencies ?? [];
  const sourceAssets = normalizedControls.sourceAssets ?? [];
  const sourceNetworks = normalizedControls.sourceNetworks ?? [];
  const hasCustomerTypeControls = customerTypes.length > 0;
  const hasAnyControls = hasCustomerTypeControls || payoutCurrencies.length > 0 || sourceAssets.length > 0 || sourceNetworks.length > 0;

  async function toggleControl(group: 'customer' | 'payout' | 'asset' | 'network', key: string, enabled: boolean) {
    setSavingKey(`${group}:${key}`);
    try {
      await api('/api/admin/offramp/controls', {
        method: 'PUT',
        body: JSON.stringify({
          customerTypes: customerTypes.map((control: any) => ({ customerType: control.customerType, enabled: group === 'customer' && control.customerType === key ? enabled : control.enabled })),
          payoutCurrencies: payoutCurrencies.map((control: any) => ({ currency: control.currency, enabled: group === 'payout' && control.currency === key ? enabled : control.enabled })),
          sourceAssets: sourceAssets.map((control: any) => ({ asset: control.asset, enabled: group === 'asset' && control.asset === key ? enabled : control.enabled })),
          sourceNetworks: sourceNetworks.map((control: any) => ({ network: control.network, enabled: group === 'network' && control.network === key ? enabled : control.enabled }))
        })
      });
      notify(`${key.toUpperCase()} ${enabled ? 'enabled' : 'disabled'} across the system.`);
      await onUpdated();
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <section className="controls-layout">
      <article className="panel control-status-card">
        <div className="control-status-copy">
          <p className="eyebrow">System mode</p>
          <h3>Pause or maintain the entire system</h3>
          <p className="muted">Use maintenance or paused mode during provider outages, migrations, or major upgrades. Webhooks, admin, and history remain available.</p>
        </div>
        <div className="system-mode-form">
          <label>Mode<select value={statusDraft} onChange={(event) => setStatusDraft(event.target.value as SystemStatus['mode'])}><option value="active">Active</option><option value="maintenance">Maintenance</option><option value="paused">Paused</option></select></label>
          <label>Message<input value={statusMessage} onChange={(event) => setStatusMessage(event.target.value)} placeholder="Optional maintenance message" /></label>
          <button className="primary-btn" disabled={savingKey === 'system'} onClick={updateSystemMode}>{savingKey === 'system' ? 'Updating...' : 'Update mode'}</button>
        </div>
      </article>

      <div className="panel-grid two controls-grid">
        <article className="panel control-panel control-highlight">
          <div className="panel-head"><div><p className="eyebrow">Customer type controls</p><h3>Enable or disable Individual / Business onboarding</h3></div></div>
          <p className="muted">Business stays visible but disabled in the user verification form until you enable it here. Changes are saved to the backend and the user app refreshes automatically.</p>
          {!hasAdminKey ? <Empty>Enter and save your Admin API key in the sidebar, then click Refresh to load controls.</Empty> : error ? <Empty>{error}</Empty> : !hasCustomerTypeControls ? <Empty>No customer type controls loaded. Confirm the backend is on the latest deployment.</Empty> : <div className="compact-control-list">{customerTypes.map((control: any) => <div className="control-row" key={control.customerType}><div><strong>{control.label}</strong><Badge value={control.enabled ? 'active' : 'disabled'} /><small>{control.customerType === 'business' ? 'Business/KYB onboarding. Disabled by default until operations enables it.' : 'Individual/KYC onboarding for standard users.'}</small></div><label className="switch-row"><span>{savingKey === `customer:${control.customerType}` ? 'Updating...' : control.enabled ? 'Enabled' : 'Disabled'}</span><button type="button" disabled={Boolean(savingKey)} className={`switch ${control.enabled ? 'on' : ''}`} aria-pressed={control.enabled} onClick={() => toggleControl('customer', control.customerType, !control.enabled)}><span /></button></label></div>)}</div>}
        </article>

        <article className="panel control-panel">
          <div className="panel-head"><div><p className="eyebrow">Rail controls</p><h3>Enable or disable payout currencies</h3></div></div>
          <p className="muted">Toggle a currency off to hide it from the user app and block new bank accounts/withdrawals for that rail immediately.</p>
          {!hasAdminKey ? <Empty>Enter and save your Admin API key in the sidebar, then click Refresh to load controls.</Empty> : error ? <Empty>{error}</Empty> : !hasAnyControls ? <Empty>No controls loaded. Click Refresh or confirm the backend is on the latest deployment.</Empty> : <div className="compact-control-list">{payoutCurrencies.map((control: any) => <div className="control-row" key={control.currency}><div><strong>{control.label}</strong><Badge value={control.enabled ? 'active' : 'disabled'} /><small>Account type: {control.accountType} · Default rail: {control.defaultPaymentRail}</small></div><label className="switch-row"><span>{savingKey === `payout:${control.currency}` ? 'Updating...' : control.enabled ? 'Enabled' : 'Disabled'}</span><button type="button" disabled={Boolean(savingKey)} className={`switch ${control.enabled ? 'on' : ''}`} aria-pressed={control.enabled} onClick={() => toggleControl('payout', control.currency, !control.enabled)}><span /></button></label></div>)}</div>}
        </article>

        <article className="panel control-panel">
          <div className="panel-head"><div><p className="eyebrow">Deposit asset controls</p><h3>Enable or disable USDC / USDT</h3></div></div>
          {!hasAnyControls ? <Empty>No asset controls loaded.</Empty> : <div className="compact-control-list">{sourceAssets.map((control: any) => <div className="control-row" key={control.asset}><div><strong>{control.label}</strong><Badge value={control.enabled ? 'active' : 'disabled'} /><small>Controls which stablecoins users can send to deposit addresses.</small></div><label className="switch-row"><span>{savingKey === `asset:${control.asset}` ? 'Updating...' : control.enabled ? 'Enabled' : 'Disabled'}</span><button type="button" disabled={Boolean(savingKey)} className={`switch ${control.enabled ? 'on' : ''}`} aria-pressed={control.enabled} onClick={() => toggleControl('asset', control.asset, !control.enabled)}><span /></button></label></div>)}</div>}
        </article>

        <article className="panel control-panel network-panel">
          <div className="panel-head"><div><p className="eyebrow">Network controls</p><h3>Enable or disable supported networks</h3></div></div>
          {!hasAnyControls ? <Empty>No network controls loaded.</Empty> : <div className="network-control-grid">{sourceNetworks.map((control: any) => <div className="control-row" key={control.network}><div><strong>{control.label}</strong><Badge value={control.enabled ? 'active' : 'disabled'} /><small>Use this for phased rollout or maintenance windows.</small></div><label className="switch-row"><span>{savingKey === `network:${control.network}` ? 'Updating...' : control.enabled ? 'Enabled' : 'Disabled'}</span><button type="button" disabled={Boolean(savingKey)} className={`switch ${control.enabled ? 'on' : ''}`} aria-pressed={control.enabled} onClick={() => toggleControl('network', control.network, !control.enabled)}><span /></button></label></div>)}</div>}
        </article>

        <article className="panel control-panel effect-panel">
          <div className="panel-head"><div><p className="eyebrow">System-wide effect</p><h3>What happens instantly</h3></div></div>
          <div className="details-box">
            <Kv label="Customer types" value={customerTypes.filter((control: any) => control.enabled).map((control: any) => control.label).join(', ') || 'None'} />
          <Kv label="Payout currencies" value={payoutCurrencies.filter((control: any) => control.enabled).map((control: any) => control.currency.toUpperCase()).join(', ') || 'None'} />
            <Kv label="Deposit assets" value={sourceAssets.filter((control: any) => control.enabled).map((control: any) => control.asset.toUpperCase()).join(', ') || 'None'} />
            <Kv label="Deposit networks" value={sourceNetworks.filter((control: any) => control.enabled).map((control: any) => control.label).join(', ') || 'None'} />
            <Kv label="Safety" value="At least one customer type, payout currency, asset, and network must remain enabled" />
            <Kv label="Refresh" value="User app refreshes controls on focus and every 10 seconds while visible" />
          </div>
        </article>
      </div>
    </section>
  );
}

function Webhooks({ webhooks }: { webhooks: WebhookEventRecord[] }) {
  return <article className="panel"><div className="panel-head"><div><p className="eyebrow">Events</p><h3>Webhook event log</h3></div></div>{!webhooks.length ? <Empty>No webhook events found.</Empty> : <div className="table-wrap"><table className="table"><thead><tr><th>ID</th><th>Provider</th><th>Category</th><th>Type</th><th>Object</th><th>Processed</th><th>Created</th></tr></thead><tbody>{webhooks.map((event) => <tr key={event.id}><td>{event.providerEventId}</td><td>{event.provider}</td><td>{event.eventCategory || '—'}</td><td>{event.eventType || '—'}</td><td>{event.eventObjectId || '—'}</td><td>{event.processedAt ? 'Yes' : 'No'}</td><td>{new Date(event.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div>}</article>;
}

function Economics({ overview, estimate, onEstimate }: { overview: AdminOverview | null; estimate: EconomicsEstimate | null; onEstimate: (event: FormEvent<HTMLFormElement>) => void }) {
  return <section className="panel-grid two">{overview ? <EconomicsSummary overview={overview} /> : <Empty>No economics loaded.</Empty>}<article className="panel form-panel"><p className="eyebrow">Simulator</p><h3>Unit economics estimate</h3><form className="form" onSubmit={onEstimate}><label>Withdrawal amount<input name="amount" type="number" min="1" step="0.01" defaultValue="1000" /></label><label>Customer type<select name="customerType" defaultValue="individual"><option value="individual">Individual — KYC</option><option value="business">Business — KYB</option></select></label><label>Include onboarding cost<select name="includeOnboardingCost" defaultValue="true"><option value="true">Yes</option><option value="false">No</option></select></label><label>Third-party rail fee<input name="thirdPartyRailFee" type="number" min="0" step="0.01" defaultValue="0" /></label><button className="primary-btn">Estimate</button></form>{estimate && <div className="estimate-box"><Kv label="Sivan revenue" value={`$${estimate.revenue.estimatedSivanFeeRevenue}`} /><Kv label="Bridge cost" value={`$${estimate.costs.estimatedBridgeOfframpCost}`} /><Kv label="Onboarding cost" value={`$${estimate.costs.onboardingCost}`} /><Kv label="Total cost" value={`$${estimate.costs.estimatedTotalCost}`} /><Kv label="Contribution margin" value={`$${estimate.margin.estimatedContributionMargin}`} /><Kv label="Break-even volume" value={estimate.margin.onboardingBreakEvenVolume ? `$${estimate.margin.onboardingBreakEvenVolume}` : '—'} /></div>}</article></section>;
}

function Settings({ apiBase }: { apiBase: string }) {
  return <section className="panel-grid two"><article className="panel"><div className="panel-head"><div><p className="eyebrow">Runtime</p><h3>Admin settings</h3></div></div><div className="details-box"><Kv label="API base" value={apiBase} /><Kv label="User frontend" value="/frontend on port 5173" /><Kv label="Admin frontend" value="/frontend-admin on port 5174" /><Kv label="Admin auth" value="Required before production" /></div></article><article className="panel"><div className="panel-head"><div><p className="eyebrow">Production checklist</p><h3>Before launch</h3></div></div><div className="details-box"><Kv label="Admin authentication" value="Pending" /><Kv label="RBAC" value="Pending" /><Kv label="2FA" value="Pending" /><Kv label="Audit logs" value="Pending" /><Kv label="Scheduled reconciliation" value="Pending" /><Kv label="Postgres migration" value="Pending" /></div></article></section>;
}
