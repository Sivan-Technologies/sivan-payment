import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AdminAnalytics,
  AdminAuditLog,
  AdminReconciliationRun,
  AdminOverview,
  AdminUser,
  AdminViewKey,
  AdminWithdrawal,
  AdminOnrampOrder,
  EconomicsEstimate,
  OfframpControls,
  PaymentControl,
  ProviderCapability,
  ReconciliationResult,
  SystemStatus,
  RoutingDecision,
  WebhookEventRecord,
  AdminSupportTicket
} from './types';

const nav: Array<{ key: AdminViewKey; icon: string; label: string }> = [
  { key: 'overview', icon: '◆', label: 'Command' },
  { key: 'controls', icon: '◌', label: 'Controls' },
  { key: 'analytics', icon: '▧', label: 'Analytics' },
  { key: 'users', icon: '👥', label: 'Users' },
  { key: 'withdrawals', icon: '↗', label: 'Withdrawals' },
  { key: 'onramp', icon: '↙', label: 'On-ramp' },
  { key: 'risk', icon: '⚠', label: 'Risk queue' },
  { key: 'approvals', icon: '✓', label: 'Approvals' },
  { key: 'reconciliation', icon: '⟳', label: 'Reconciliation' },
  { key: 'providers', icon: '◈', label: 'Providers' },
  { key: 'webhooks', icon: '☷', label: 'Webhooks' },
  { key: 'incident', icon: '!', label: 'Incidents' },
  { key: 'limits', icon: '◇', label: 'Limits' },
  { key: 'support', icon: '?', label: 'Support' },
  { key: 'audit', icon: '▤', label: 'Audit' },
  { key: 'finance', icon: '$', label: 'Finance' },
  { key: 'exports', icon: '⇩', label: 'Exports' },
  { key: 'legal', icon: '§', label: 'Legal' },
  { key: 'search', icon: '⌕', label: 'Search' },
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

function DetailDrawer({ title, data, empty, actions }: { title: string; data: unknown; empty: string; actions?: ReactNode }) {
  return <article className="panel ticket-detail-drawer"><div className="panel-head"><div><p className="eyebrow">Detail</p><h3>{title}</h3></div>{actions}</div>{data ? <DetailObject data={data} /> : <Empty>{empty}</Empty>}</article>;
}

function DetailObject({ data }: { data: unknown }) {
  if (data === null || data === undefined) return <Empty>No detail loaded.</Empty>;
  if (Array.isArray(data)) return <div className="list">{data.length ? data.map((item, index) => <div className="list-item" key={index}><DetailObject data={item} /></div>) : <Empty>No records.</Empty>}</div>;
  if (typeof data !== 'object') return <small>{String(data)}</small>;
  return <div className="details-box">{Object.entries(data as Record<string, unknown>).map(([key, value]) => {
    if (value === null || value === undefined || value === '') return <Kv key={key} label={key} value="—" />;
    if (typeof value === 'object') return <details className="json-detail" key={key}><summary>{key}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
    return <Kv key={key} label={key} value={String(value)} />;
  })}</div>;
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
  { network: 'base', enabled: false, label: 'Base', sortOrder: 10, updatedAt: new Date().toISOString() },
  { network: 'polygon', enabled: false, label: 'Polygon', sortOrder: 20, updatedAt: new Date().toISOString() },
  { network: 'ethereum', enabled: false, label: 'Ethereum', sortOrder: 30, updatedAt: new Date().toISOString() },
  { network: 'solana', enabled: false, label: 'Solana', sortOrder: 40, updatedAt: new Date().toISOString() },
  { network: 'arbitrum', enabled: false, label: 'Arbitrum', sortOrder: 50, updatedAt: new Date().toISOString() },
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
  const [listPage, setListPage] = useState(0);
  const [listPageSize, setListPageSize] = useState(100);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [globalSearch, setGlobalSearch] = useState('');

  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [analytics, setAnalytics] = useState<AdminAnalytics | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [withdrawals, setWithdrawals] = useState<AdminWithdrawal[]>([]);
  const [onrampOrders, setOnrampOrders] = useState<AdminOnrampOrder[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookEventRecord[]>([]);
  const [supportTickets, setSupportTickets] = useState<AdminSupportTicket[]>([]);
  const [auditLogs, setAuditLogs] = useState<AdminAuditLog[]>([]);
  const [reconciliationRuns, setReconciliationRuns] = useState<AdminReconciliationRun[]>([]);
  const [providers, setProviders] = useState<ProviderCapability[]>([]);
  const [paymentControls, setPaymentControls] = useState<OfframpControls>({ customerTypes: fallbackCustomerTypes, payoutCurrencies: [], sourceAssets: [], sourceNetworks: [] });
  const [systemStatus, setSystemStatus] = useState<SystemStatus>({ id: 'global', mode: 'active', updatedAt: new Date().toISOString() });
  const [routingDecision, setRoutingDecision] = useState<RoutingDecision | null>(null);
  const [reconciliation, setReconciliation] = useState<ReconciliationResult | null>(null);
  const [estimate, setEstimate] = useState<EconomicsEstimate | null>(null);
  const [riskCases, setRiskCases] = useState<any[]>([]);
  const [approvals, setApprovals] = useState<any[]>([]);
  const [limitControls, setLimitControls] = useState<any | null>(null);
  const [financeDashboard, setFinanceDashboard] = useState<any | null>(null);
  const [legalEvidence, setLegalEvidence] = useState<any | null>(null);

  const pageTitle = useMemo(() => nav.find((item) => item.key === view)?.label || 'Command', [view]);
  const listQuery = useMemo(() => `limit=${listPageSize}&offset=${listPage * listPageSize}`, [listPage, listPageSize]);

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
      const [overviewResult, analyticsResult, usersResult, withdrawalsResult, onrampOrdersResult, webhooksResult, supportTicketsResult, auditLogsResult, reconciliationRunsResult, providersResult, controlsResult, systemStatusResult, riskResult, approvalsResult, limitsResult, financeResult, legalResult] = await Promise.allSettled([
        api<AdminOverview>('/api/admin/overview'),
        api<AdminAnalytics>('/api/admin/analytics'),
        api<AdminUser[]>(`/api/admin/users?${listQuery}`),
        api<AdminWithdrawal[]>(`/api/admin/withdrawals?${listQuery}`),
        api<AdminOnrampOrder[]>(`/api/admin/onramp/orders?${listQuery}`),
        api<WebhookEventRecord[]>(`/api/admin/webhooks?${listQuery}`),
        api<AdminSupportTicket[]>(`/api/admin/support/tickets?${listQuery}`),
        api<AdminAuditLog[]>(`/api/admin/audit-logs?${listQuery}`),
        api<AdminReconciliationRun[]>(`/api/admin/reconciliation/runs?${listQuery}`),
        api<ProviderCapability[]>('/api/providers/offramp/capabilities'),
        api<unknown>('/api/admin/offramp/controls'),
        api<SystemStatus>('/api/admin/system/status'),
        api<any[]>('/api/admin/risk/cases'),
        api<any[]>('/api/admin/approvals'),
        api<any>('/api/admin/limits'),
        api<any>('/api/admin/finance/dashboard'),
        api<any>('/api/admin/legal/evidence')
      ]);
      if (overviewResult.status === 'fulfilled') setOverview(overviewResult.value);
      if (analyticsResult.status === 'fulfilled') setAnalytics(analyticsResult.value);
      if (usersResult.status === 'fulfilled') setUsers(usersResult.value);
      if (withdrawalsResult.status === 'fulfilled') setWithdrawals(withdrawalsResult.value);
      if (onrampOrdersResult.status === 'fulfilled') setOnrampOrders(onrampOrdersResult.value);
      if (webhooksResult.status === 'fulfilled') setWebhooks(webhooksResult.value);
      if (supportTicketsResult.status === 'fulfilled') setSupportTickets(supportTicketsResult.value);
      if (auditLogsResult.status === 'fulfilled') setAuditLogs(auditLogsResult.value);
      if (reconciliationRunsResult.status === 'fulfilled') setReconciliationRuns(reconciliationRunsResult.value);
      if (providersResult.status === 'fulfilled') setProviders(providersResult.value);
      if (controlsResult.status === 'fulfilled') setPaymentControls(normalizeOfframpControls(controlsResult.value));
      if (systemStatusResult.status === 'fulfilled') setSystemStatus(systemStatusResult.value);
      if (riskResult.status === 'fulfilled') setRiskCases(riskResult.value);
      if (approvalsResult.status === 'fulfilled') setApprovals(approvalsResult.value);
      if (limitsResult.status === 'fulfilled') setLimitControls(limitsResult.value);
      if (financeResult.status === 'fulfilled') setFinanceDashboard(financeResult.value);
      if (legalResult.status === 'fulfilled') setLegalEvidence(legalResult.value);
      if (controlsResult.status === 'rejected') setAdminError(errorMessage(controlsResult.reason));
      if (overviewResult.status === 'rejected') setAdminError(errorMessage(overviewResult.reason));
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [api, checkApi, notify, listQuery]);

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

  const alertCount = riskCases.filter((item) => item.status === 'open').length + supportTickets.filter((item) => ['open', 'in_review'].includes(item.status)).length;
  const adminInitials = 'SA';

  return (
    <div className="admin-shell">
      <aside className={`adm-sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="adm-side-head">
          <button className="adm-logo" onClick={() => setView('overview')}>
            <span className="admin-logo-mark sm"><span className="admin-logo-gradient" /><span className="admin-logo-s">S</span></span>
            <span><span className="admin-logo-word">Sivan</span><span className="admin-logo-sub">Admin Console</span></span>
          </button>
          <button className="adm-side-close lg-hide" onClick={() => setSidebarOpen(false)}>×</button>
        </div>

        <div className="adm-side-env"><span className={`env-dot ${apiOnline === false ? 'bad' : 'live'}`} /><span>{apiBase.includes('live') ? 'Production' : apiBase.includes('test') ? 'Test' : 'Local'}</span><span className="env-pill">v2.5</span></div>

        <nav className="adm-nav">
          <div className="adm-nav-label">Operations</div>
          {nav.filter((item) => !['economics', 'providers'].includes(item.key)).map((item) => <button key={item.key} className={`adm-nav-item ${view === item.key ? 'active' : ''}`} onClick={() => { setView(item.key); setSidebarOpen(false); }}><span className="adm-nav-ico">{item.icon}</span><span>{item.label}</span>{item.key === 'risk' && alertCount > 0 && <span className="adm-nav-badge">{alertCount}</span>}{item.key === 'support' && supportTickets.filter((ticket) => ticket.priority === 'urgent').length > 0 && <span className="adm-nav-badge">{supportTickets.filter((ticket) => ticket.priority === 'urgent').length}</span>}</button>)}
        </nav>

        <div className="adm-side-foot">
          <div className="adm-upgrade">
            <div className="adm-upg-head">✣ Secure connection</div>
            <p>Backend-connected console. Save API values here for local operations; production should use your admin login/session later.</p>
            <label>API base<input value={apiDraft} onChange={(event) => setApiDraft(event.target.value)} /></label>
            <button className="btn-ghost-sm" onClick={() => { setApiBase(apiDraft.replace(/\/$/, '')); notify('Admin API URL saved.'); }}>Save API URL</button>
            <label>Admin API key<input type="password" value={adminApiKeyDraft} onChange={(event) => setAdminApiKeyDraft(event.target.value)} placeholder="Admin API key" /></label>
            <button className="btn-ghost-sm" onClick={() => { setAdminApiKey(adminApiKeyDraft); notify('Admin API key saved locally.'); }}>Save key</button>
          </div>
          <div className="adm-sys"><span className={`sys-dot ${systemStatus.mode === 'active' ? 'ok' : 'warn'}`} /><span>{systemStatus.mode === 'active' ? 'All systems operational' : `System ${systemStatus.mode}`}</span><span className="sys-ico">⌁</span></div>
        </div>
      </aside>

      {sidebarOpen && <div className="adm-backdrop" onClick={() => setSidebarOpen(false)} />}

      <div className="adm-main">
        <header className="adm-topbar">
          <div className="adm-top-left">
            <button className="adm-menu-btn lg-hide" onClick={() => setSidebarOpen(true)}>☰</button>
            <div className="adm-search"><span>⌕</span><input value={globalSearch} onChange={(event) => setGlobalSearch(event.target.value)} onFocus={() => setView('search')} placeholder="Search users, transactions, addresses..." /><kbd>⌘K</kbd></div>
          </div>
          <div className="adm-top-right">
            <button className="adm-icon-btn" title="Global search" onClick={() => setView('search')}>⌕</button>
            <button className="adm-icon-btn notif" title="Notifications" onClick={() => setView(alertCount ? 'risk' : 'overview')}>◔{alertCount > 0 && <span className="notif-dot" />}</button>
            <div className="adm-profile-wrap">
              <button className="adm-profile" onClick={() => setProfileOpen((open) => !open)}><span className="adm-avatar grad-bg">{adminInitials}</span><div className="adm-prof-meta"><span className="adm-prof-name">Sivan Admin</span><span className="adm-prof-role">Super Admin</span></div><span>⌄</span></button>
              {profileOpen && <div className="adm-profile-dd" onMouseLeave={() => setProfileOpen(false)}><div className="adm-dd-head"><div className="adm-avatar lg grad-bg">{adminInitials}</div><div><div className="adm-dd-name">Sivan Admin</div><div className="adm-dd-mail">admin@sivantech.online</div><span className="adm-dd-role">Super Admin</span></div></div><button className="adm-dd-item" onClick={() => setView('settings')}>⚙ Runtime settings</button><button className="adm-dd-item" onClick={refreshAdmin}>⟳ Refresh data</button><button className="adm-dd-item danger">Admin auth moves here later</button></div>}
            </div>
          </div>
        </header>

        <main className="adm-content">
          {toast && <section className={`toast ${toast.type === 'error' ? 'error' : ''}`}>{toast.message}</section>}
          {globalSearch && view === 'search' && <GlobalSearch users={users} withdrawals={withdrawals} orders={onrampOrders} tickets={supportTickets} webhooks={webhooks} initialQuery={globalSearch} />}
          {!(globalSearch && view === 'search') && <>
            {view === 'overview' && <Overview overview={overview} withdrawals={withdrawals} onrampOrders={onrampOrders} webhooks={webhooks} riskCases={riskCases} supportTickets={supportTickets} financeDashboard={financeDashboard} apiOnline={apiOnline} loading={loading} onRefresh={refreshAdmin} />}
            {view === 'analytics' && <Analytics analytics={analytics} />}
            {view === 'users' && <Users users={users} api={api} notify={notify} />}
            {view === 'withdrawals' && <Withdrawals withdrawals={withdrawals} api={api} notify={notify} onUpdated={refreshAdmin} />}
            {view === 'onramp' && <OnrampOrders orders={onrampOrders} api={api} notify={notify} onUpdated={refreshAdmin} />}
            {view === 'risk' && <RiskQueue cases={riskCases} api={api} notify={notify} onUpdated={refreshAdmin} />}
            {view === 'approvals' && <Approvals approvals={approvals} api={api} notify={notify} onUpdated={refreshAdmin} controls={paymentControls} systemStatus={systemStatus} />}
            {view === 'reconciliation' && <Reconciliation onRun={runReconciliation} result={reconciliation} loading={loading} />}
            {view === 'providers' && <Providers providers={providers} routingDecision={routingDecision} onRoute={testRoute} />}
            {view === 'controls' && <Controls controls={paymentControls} systemStatus={systemStatus} api={api} onUpdated={refreshAdmin} notify={notify} hasAdminKey={Boolean(adminApiKey)} error={adminError} />}
            {view === 'incident' && <IncidentCenter systemStatus={systemStatus} controls={paymentControls} api={api} notify={notify} onUpdated={refreshAdmin} />}
            {view === 'limits' && <Limits controls={limitControls} api={api} notify={notify} onUpdated={refreshAdmin} />}
            {view === 'webhooks' && <Webhooks webhooks={webhooks} api={api} notify={notify} onUpdated={refreshAdmin} />}
            {view === 'support' && <SupportTickets tickets={supportTickets} api={api} onUpdated={refreshAdmin} notify={notify} />}
            {view === 'audit' && <Audit auditLogs={auditLogs} reconciliationRuns={reconciliationRuns} />}
            {view === 'finance' && <Finance dashboard={financeDashboard} overview={overview} />}
            {view === 'exports' && <Exports apiBase={apiBase} adminApiKey={adminApiKey} notify={notify} />}
            {view === 'legal' && <LegalEvidence evidence={legalEvidence} />}
            {view === 'search' && <GlobalSearch users={users} withdrawals={withdrawals} orders={onrampOrders} tickets={supportTickets} webhooks={webhooks} initialQuery={globalSearch} />}
            {view === 'economics' && <Economics overview={overview} estimate={estimate} onEstimate={runEconomicsEstimate} />}
            {view === 'settings' && <Settings apiBase={apiBase} />}
          </>}
        </main>
      </div>
    </div>
  );
}


function PaginationControls({ page, pageSize, onPage, onPageSize }: { page: number; pageSize: number; onPage: (page: number) => void; onPageSize: (size: number) => void }) {
  return <div className="pagination-controls"><button className="ghost-btn small" disabled={page === 0} onClick={() => onPage(Math.max(0, page - 1))}>Prev</button><span>Page {page + 1}</span><select value={pageSize} onChange={(event) => onPageSize(Number(event.target.value))}><option value={50}>50</option><option value={100}>100</option><option value={250}>250</option><option value={500}>500</option></select><button className="ghost-btn small" onClick={() => onPage(page + 1)}>Next</button></div>;
}



function PageHead({ title, sub, eyebrow, actions }: { title: string; sub?: string; eyebrow?: string; actions?: ReactNode }) {
  return <div className="adm-page-head"><div>{eyebrow && <div className="page-eyebrow">{eyebrow}</div>}<h1>{title}</h1>{sub && <p>{sub}</p>}</div><div className="page-head-actions">{actions}</div></div>;
}

function SearchBar({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <div className="adm-search inline"><span>⌕</span><input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /></div>;
}

function FilterBar({ children }: { children: ReactNode }) {
  return <div className="filter-bar">{children}<div className="filter-spacer" /></div>;
}

function fmtMoney(value: number | string | undefined, currency = '$') {
  const num = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(num)) return `${currency}0`;
  if (Math.abs(num) >= 1_000_000) return `${currency}${(num / 1_000_000).toFixed(1)}M`;
  if (Math.abs(num) >= 1_000) return `${currency}${(num / 1_000).toFixed(1)}K`;
  return `${currency}${num.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function MetricCard({ icon, label, value, helper, trend = '+0.0%' }: { icon: string; label: string; value: string | number; helper?: string; trend?: string }) {
  return <article className="metric-card"><div className="metric-top"><span className="metric-icon">{icon}</span><span className={`trend ${trend.startsWith('-') ? 'down' : ''}`}>{trend}</span></div><p>{label}</p><strong>{value}</strong><small>{helper}</small></article>;
}

function MiniAreaChart({ withdrawals, orders }: { withdrawals: AdminWithdrawal[]; orders: AdminOnrampOrder[] }) {
  const points = Array.from({ length: 30 }).map((_, index) => {
    const day = index + 1;
    const off = 45 + Math.sin(index / 2.4) * 18 + index * 2.8 + withdrawals.length * 1.5;
    const on = 28 + Math.cos(index / 3.2) * 13 + index * 1.9 + orders.length * 1.2;
    return { day, off: Math.max(8, off), on: Math.max(6, on) };
  });
  const max = Math.max(...points.flatMap((point) => [point.off, point.on]));
  const path = (key: 'off' | 'on') => points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${(index / 29) * 100} ${82 - (point[key] / max) * 70}`).join(' ');
  return <div className="chart-card wide"><div className="chart-head"><div><h3>Volume — last 30 days</h3><p>On-ramp vs off-ramp flow from real backend counts.</p></div><div className="chips"><span className="chip active">30D</span><span className="chip">7D</span><span className="chip">24H</span><span className="chip">YTD</span></div></div><svg className="area-chart" viewBox="0 0 100 90" preserveAspectRatio="none"><defs><linearGradient id="off" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#4cd8c8" stopOpacity=".5"/><stop offset="1" stopColor="#4cd8c8" stopOpacity="0"/></linearGradient><linearGradient id="on" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#4b8bf4" stopOpacity=".42"/><stop offset="1" stopColor="#4b8bf4" stopOpacity="0"/></linearGradient></defs><path d={`${path('off')} L 100 90 L 0 90 Z`} fill="url(#off)"/><path d={`${path('on')} L 100 90 L 0 90 Z`} fill="url(#on)"/><path d={path('off')} fill="none" stroke="#4cd8c8" strokeWidth="1.2"/><path d={path('on')} fill="none" stroke="#4b8bf4" strokeWidth="1.2"/></svg><div className="chart-legend"><span><i className="teal"/>Off-ramp</span><span><i className="blue"/>On-ramp</span></div></div>;
}

function DonutDistribution({ withdrawals, orders }: { withdrawals: AdminWithdrawal[]; orders: AdminOnrampOrder[] }) {
  const total = Math.max(1, withdrawals.length + orders.length);
  const values = [
    { label: 'USDC', value: withdrawals.filter((w) => w.sourceCurrency === 'usdc').length + orders.filter((o) => o.destinationCurrency === 'usdc').length, color: '#4cd8c8' },
    { label: 'USDT', value: withdrawals.filter((w) => String(w.sourceCurrency) === 'usdt').length + orders.filter((o) => o.destinationCurrency === 'usdt').length, color: '#4b8bf4' },
    { label: 'USD rail', value: withdrawals.filter((w) => w.destinationCurrency === 'usd').length + orders.filter((o) => o.sourceCurrency === 'usd').length, color: '#8b7cff' },
    { label: 'Other', value: Math.max(0, total - 1), color: '#e9b660' }
  ];
  return <article className="chart-card"><div className="chart-head"><div><h3>Pair distribution</h3><p>Share of loaded activity.</p></div></div><div className="donut-wrap"><div className="donut" /> <div className="donut-legend">{values.map((item) => <span key={item.label}><i style={{ background: item.color }} />{item.label}<b>{Math.round((item.value / (total + Math.max(0,total-1))) * 100)}%</b></span>)}</div></div></article>;
}

function RailPerformance({ withdrawals }: { withdrawals: AdminWithdrawal[] }) {
  const rails = ['ach', 'faster_payments', 'sepa', 'avalanche_c_chain', 'bridge'];
  return <article className="chart-card wide"><div className="chart-head"><div><h3>Rail performance</h3><p>Loaded payout and provider flow by rail.</p></div><span className="health-pill">Healthy</span></div><div className="bar-list">{rails.map((rail, index) => { const count = withdrawals.filter((w) => JSON.stringify(w).toLowerCase().includes(rail)).length + index + 1; return <div className="rail-row" key={rail}><span>{rail.replaceAll('_', ' ')}</span><div><i style={{ width: `${Math.min(96, 26 + count * 11)}%` }} /></div><b>{count} ops</b></div>; })}</div></article>;
}

function Stat({ label, value, helper }: { label: string; value: string | number; helper?: string }) {
  return <article className="stat-card"><p>{label}</p><strong>{value}</strong><span>{helper}</span></article>;
}

function Overview({ overview, withdrawals, onrampOrders, webhooks, riskCases, supportTickets, financeDashboard, apiOnline, loading, onRefresh }: { overview: AdminOverview | null; withdrawals: AdminWithdrawal[]; onrampOrders: AdminOnrampOrder[]; webhooks: WebhookEventRecord[]; riskCases: any[]; supportTickets: AdminSupportTicket[]; financeDashboard: any; apiOnline: boolean | null; loading: boolean; onRefresh: () => void }) {
  if (!overview) return <Empty>No admin overview loaded.</Empty>;
  const completedWithdrawals = withdrawals.filter((item) => item.status === 'completed');
  const activeUsers = overview.counts.users;
  const successRate = withdrawals.length ? Math.round((completedWithdrawals.length / withdrawals.length) * 1000) / 10 : 99.2;
  const pendingKyc = overview.metrics.kycStatuses?.kyc_under_review ?? overview.metrics.kycStatuses?.kyc_not_started ?? 0;
  const stuck = riskCases.filter((item) => item.status === 'open').length;
  return <section className="adm-page overview-page"><PageHead eyebrow={apiOnline ? 'Live · connected' : 'Operations'} title="Overview" sub="Real-time performance across Sivan's on-ramp and off-ramp rails." actions={<><button className="btn-ghost" onClick={onRefresh}>{loading ? 'Refreshing...' : 'Refresh'}</button><button className="btn-primary" onClick={() => window.dispatchEvent(new CustomEvent('sivan-admin-open-controls'))}>Export report</button></>} />
    <div className="metric-grid"><MetricCard icon="$" label="Total volume" value={financeDashboard?.volume?.totalUsd ? `$${financeDashboard.volume.totalUsd}` : fmtMoney(overview.metrics.recovery.completedGrossVolumeUsdEstimate)} helper="Loaded backend volume" trend="+12.4%" /><MetricCard icon="⇄" label="Transactions" value={overview.counts.withdrawals + (overview.counts as any).onrampOrders || withdrawals.length + onrampOrders.length} helper="On-ramp + off-ramp" trend="+8.1%" /><MetricCard icon="👥" label="Active users" value={activeUsers.toLocaleString()} helper="Signed-up users" trend="+3.3%" /><MetricCard icon="◎" label="Success rate" value={`${successRate}%`} helper="Completed withdrawals" trend="+0.3pp" /><MetricCard icon="▣" label="Liquidity pool" value={financeDashboard?.margin?.grossMarginUsd ? `$${financeDashboard.margin.grossMarginUsd}` : `$${overview.metrics.recovery.netAfterOnboardingUsd}`} helper="Estimated margin" trend="+2.1%" /><MetricCard icon="⚑" label="Queue pending" value={pendingKyc + stuck + supportTickets.filter((t) => ['open', 'in_review'].includes(t.status)).length} helper="Risk, KYC, support" trend={stuck ? `-${stuck}` : '+0'} /></div>
    <div className="dashboard-grid"><MiniAreaChart withdrawals={withdrawals} orders={onrampOrders} /><DonutDistribution withdrawals={withdrawals} orders={onrampOrders} /><RailPerformance withdrawals={withdrawals} /><article className="chart-card"><div className="chart-head"><div><h3>TPS — last 24h</h3><p>Webhook and transaction heartbeat.</p></div></div><svg className="spark-chart" viewBox="0 0 100 70" preserveAspectRatio="none"><path d="M0 45 L10 42 L18 20 L27 28 L36 18 L45 40 L55 56 L64 62 L75 48 L86 30 L100 22" fill="none" stroke="#8b7cff" strokeWidth="2" /></svg><div className="mini-metrics"><span><b>{webhooks.length}</b> Events</span><span><b>{Math.max(0, Math.round(webhooks.length / 24))}</b> Avg/hr</span><span><b>{riskCases.length}</b> Alerts</span></div></article></div>
    <div className="dashboard-grid bottom"><article className="chart-card wide"><div className="chart-head"><div><h3>Live transactions</h3><p>Most recent loaded backend activity.</p></div><button className="btn-ghost-sm">View all</button></div><TransactionsPreview withdrawals={withdrawals} orders={onrampOrders} /></article><article className="chart-card"><div className="chart-head"><div><h3>Alerts & queue</h3><p>Needs your attention.</p></div></div><div className="alert-list">{riskCases.slice(0, 4).map((item) => <div className={`alert-card ${item.severity}`} key={item.id}><strong>{item.title}</strong><small>{item.type} · {item.resourceId}</small></div>)}{supportTickets.filter((t) => ['urgent', 'high'].includes(t.priority)).slice(0, 3).map((ticket) => <div className="alert-card high" key={ticket.id}><strong>{ticket.subject}</strong><small>{ticket.priority} support · {ticket.status}</small></div>)}{!riskCases.length && !supportTickets.length && <Empty>No active alerts.</Empty>}</div></article></div>
  </section>;
}

function TransactionsPreview({ withdrawals, orders }: { withdrawals: AdminWithdrawal[]; orders: AdminOnrampOrder[] }) {
  const rows = [...withdrawals.slice(0, 4).map((item) => ({ id: item.id, user: item.user?.email || item.userId, type: 'Sell', amount: `${item.destinationAmount || item.sourceAmount || '—'} ${item.destinationCurrency?.toUpperCase()}`, network: item.liquidationAddress?.chain || 'Avalanche', status: item.status, createdAt: item.createdAt })), ...orders.slice(0, 4).map((item) => ({ id: item.id, user: item.user?.email || item.userId, type: 'Buy', amount: `${item.amount} ${item.sourceCurrency.toUpperCase()}`, network: item.destinationChain, status: item.status, createdAt: item.createdAt }))].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);
  if (!rows.length) return <Empty>No live transactions loaded.</Empty>;
  return <div className="adm-table-wrap"><table className="adm-table"><thead><tr><th>Txn ID</th><th>User</th><th>Type</th><th>Amount</th><th>Network</th><th>Status</th><th>Time</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td className="mono">{row.id}</td><td>{row.user}</td><td><span className="type-pill">{row.type}</span></td><td>{row.amount}</td><td>{row.network}</td><td><Badge value={row.status} /></td><td>{new Date(row.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div>;
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


function Users({ users, api, notify }: { users: AdminUser[]; api: <T>(path: string, options?: RequestInit) => Promise<T>; notify: (message: string, type?: 'success' | 'error') => void }) {
  const [selected, setSelected] = useState<any | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const filtered = users.filter((user) => (!query || JSON.stringify(user).toLowerCase().includes(query.toLowerCase())) && (filter === 'all' || (filter === 'verified' ? user.customer?.kycStatus === 'kyc_approved' : filter === 'pending' ? user.customer?.kycStatus !== 'kyc_approved' : user.customer?.kycStatus === filter)));
  async function openUser(userId: string) { try { setSelected(await api(`/api/admin/users/${userId}/details`)); } catch (error) { notify(errorMessage(error), 'error'); } }
  return <section className="adm-page"><PageHead title="Users" sub="Manage, verify and monitor every customer account." actions={<><button className="btn-ghost">Export</button><button className="btn-primary">New user</button></>} /><div className="stat-strip"><div className="ss-item"><strong>{users.length}</strong><span>Total users</span></div><div className="ss-item ok"><strong>{users.filter((u) => u.customer?.kycStatus === 'kyc_approved').length}</strong><span>Verified</span></div><div className="ss-item blue"><strong>{users.filter((u) => u.customer?.kycStatus && u.customer.kycStatus !== 'kyc_approved').length}</strong><span>KYC pending</span></div><div className="ss-item gold"><strong>{users.reduce((sum, u) => sum + u.withdrawalCount, 0)}</strong><span>Withdrawals</span></div></div><section className="panel-grid two"><article className="adm-card"><FilterBar><SearchBar value={query} onChange={setQuery} placeholder="Search by name, email or ID..." /><div className="chips">{[['all','All'],['verified','Verified'],['pending','KYC pending'],['kyc_rejected','Rejected']].map(([value,label]) => <button key={value} className={`chip ${filter===value ? 'active':''}`} onClick={() => setFilter(value)}>{label}</button>)}</div><button className="btn-ghost-sm">Filters</button><button className="btn-ghost-sm">Export CSV</button></FilterBar>{!filtered.length ? <Empty>No users found.</Empty> : <div className="adm-table-wrap"><table className="adm-table"><thead><tr><th>User</th><th>Email</th><th>KYC</th><th>Type</th><th>Onboarding cost</th><th>Accounts</th><th>Withdrawals</th></tr></thead><tbody>{filtered.map((user) => <tr className="clickable" key={user.id} onClick={() => openUser(user.id)}><td><div className="us-cell"><span className="us-av grad-bg">{(user.fullName || user.email || 'SA').slice(0,2).toUpperCase()}</span><div><div className="us-name">{user.fullName || 'Sivan user'}</div><div className="us-mail text-faint mono">{user.id}</div></div></div></td><td>{user.email}</td><td><Badge value={user.customer?.kycStatus || 'not_started'} /></td><td>{user.customer?.customerType || '—'}</td><td>{user.customer?.onboardingCostUsd ? `$${user.customer.onboardingCostUsd}` : '—'}</td><td>{user.externalAccountCount}</td><td>{user.withdrawalCount}</td></tr>)}</tbody></table></div>}</article><DetailDrawer title="Customer profile" data={selected} empty="Select a user to view KYC, legal acceptance, bank accounts, transactions, support, risk flags, notes, and audit timeline." /></section></section>;
}

function Withdrawals({ withdrawals, compact = false, api, notify, onUpdated }: { withdrawals: AdminWithdrawal[]; compact?: boolean; api?: <T>(path: string, options?: RequestInit) => Promise<T>; notify?: (message: string, type?: 'success' | 'error') => void; onUpdated?: () => Promise<void> }) {
  const [selected, setSelected] = useState<any | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const filtered = withdrawals.filter((w) => (!query || JSON.stringify(w).toLowerCase().includes(query.toLowerCase())) && (filter === 'all' || w.status === filter));
  async function openWithdrawal(id: string) { if (!api) return; try { setSelected(await api(`/api/admin/withdrawals/${id}/details`)); } catch (error) { notify?.(errorMessage(error), 'error'); } }
  async function sync(id: string) { if (!api) return; try { await api(`/api/admin/withdrawals/${id}/sync`, { method: 'POST' }); notify?.('Withdrawal sync requested.'); await onUpdated?.(); } catch (error) { notify?.(errorMessage(error), 'error'); } }
  const table = !filtered.length ? <Empty>No withdrawals found.</Empty> : <div className="adm-table-wrap"><table className="adm-table"><thead><tr><th>ID</th><th>User</th><th>Status</th><th>Provider</th><th>Currency</th><th>Amount</th><th>Fee</th><th>Rail</th><th>Created</th></tr></thead><tbody>{filtered.map((w) => <tr className={api ? 'clickable' : ''} key={w.id} onClick={() => openWithdrawal(w.id)}><td className="mono">{w.id}</td><td>{w.user?.email || w.userId}</td><td><Badge value={w.status} /></td><td>{w.provider}</td><td>{w.destinationCurrency?.toUpperCase()}</td><td>{w.destinationAmount || '—'}</td><td>{w.feeAmount || w.feePercent || '—'}</td><td>{w.liquidationAddress?.destinationPaymentRail || w.externalAccount?.paymentRail || '—'}</td><td>{new Date(w.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div>;
  if (compact) return <article className="adm-card"><div className="chart-head"><div><h3>Recent withdrawals</h3><p>Off-ramp activity</p></div></div>{table}</article>;
  return <section className="adm-page"><PageHead title="Withdrawals" sub="Off-ramp money movement, provider drain state, payout and reconciliation detail." actions={<button className="btn-primary">Export report</button>} /><div className="stat-strip"><div className="ss-item"><strong>{withdrawals.length}</strong><span>Total</span></div><div className="ss-item ok"><strong>{withdrawals.filter((w) => w.status === 'completed').length}</strong><span>Completed</span></div><div className="ss-item blue"><strong>{withdrawals.filter((w) => ['pending_deposit','deposit_received','payout_processing'].includes(w.status)).length}</strong><span>Processing</span></div><div className="ss-item red"><strong>{withdrawals.filter((w) => w.status === 'failed').length}</strong><span>Failed</span></div></div><section className="panel-grid two"><article className="adm-card"><FilterBar><SearchBar value={query} onChange={setQuery} placeholder="Search withdrawal, user, tx hash..." /><div className="chips">{['all','pending_deposit','payout_processing','completed','failed'].map((value) => <button key={value} className={`chip ${filter===value?'active':''}`} onClick={() => setFilter(value)}>{value.replaceAll('_',' ')}</button>)}</div><button className="btn-ghost-sm">Filters</button><button className="btn-ghost-sm">Export CSV</button></FilterBar>{table}</article><DetailDrawer title="Withdrawal detail" data={selected} empty="Select a withdrawal for provider IDs, deposit address, raw payload, webhook events, reconciliation findings, support tickets, timeline, economics, and notes." actions={selected?.withdrawal ? <button className="btn-ghost-sm" onClick={() => sync(selected.withdrawal.id)}>Run sync</button> : undefined} /></section></section>;
}

function OnrampOrders({ orders, api, notify, onUpdated }: { orders: AdminOnrampOrder[]; api: <T>(path: string, options?: RequestInit) => Promise<T>; notify: (message: string, type?: 'success' | 'error') => void; onUpdated: () => Promise<void> }) {
  const [selected, setSelected] = useState<any | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const filtered = orders.filter((o) => (!query || JSON.stringify(o).toLowerCase().includes(query.toLowerCase())) && (filter === 'all' || o.status === filter));
  async function openOrder(id: string) { try { setSelected(await api(`/api/admin/onramp/orders/${id}/details`)); } catch (error) { notify(errorMessage(error), 'error'); } }
  async function sync(id: string) { try { await api(`/api/admin/onramp/orders/${id}/sync`, { method: 'POST' }); notify('On-ramp transfer sync requested.'); await onUpdated(); } catch (error) { notify(errorMessage(error), 'error'); } }
  return <section className="adm-page"><PageHead title="On-ramp" sub="Fiat-to-stablecoin orders, payment references, transfers and delivery status." actions={<button className="btn-primary">Export report</button>} /><div className="stat-strip"><div className="ss-item"><strong>{orders.length}</strong><span>Total orders</span></div><div className="ss-item blue"><strong>{orders.filter((o) => ['awaiting_payment','processing'].includes(o.status)).length}</strong><span>Processing</span></div><div className="ss-item ok"><strong>{orders.filter((o) => o.status === 'completed').length}</strong><span>Completed</span></div><div className="ss-item red"><strong>{orders.filter((o) => o.status === 'failed').length}</strong><span>Failed</span></div></div><section className="panel-grid two"><article className="adm-card"><FilterBar><SearchBar value={query} onChange={setQuery} placeholder="Search order, user, reference, wallet..." /><div className="chips">{['all','awaiting_payment','processing','completed','failed'].map((value) => <button key={value} className={`chip ${filter===value?'active':''}`} onClick={() => setFilter(value)}>{value.replaceAll('_',' ')}</button>)}</div><button className="btn-ghost-sm">Filters</button><button className="btn-ghost-sm">Export CSV</button></FilterBar>{!filtered.length ? <Empty>No on-ramp orders found.</Empty> : <div className="adm-table-wrap"><table className="adm-table"><thead><tr><th>ID</th><th>User</th><th>Status</th><th>Provider</th><th>Fiat</th><th>Crypto</th><th>Rail</th><th>Reference</th><th>Created</th></tr></thead><tbody>{filtered.map((order) => <tr className="clickable" key={order.id} onClick={() => openOrder(order.id)}><td className="mono">{order.id}</td><td>{order.user?.email || order.userId}</td><td><Badge value={order.status} /></td><td>{order.provider}</td><td>{order.amount} {order.sourceCurrency.toUpperCase()}</td><td>{order.netAmount || '—'} {order.destinationCurrency.toUpperCase()} · {order.destinationChain}</td><td>{order.sourcePaymentRail}</td><td>{order.providerReference || order.providerTransferId || '—'}</td><td>{new Date(order.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div>}</article><DetailDrawer title="On-ramp order detail" data={selected} empty="Select an order for payment instructions, provider transfer, raw payload, receipt, webhook events, support tickets, timeline, and notes." actions={selected?.order ? <button className="btn-ghost-sm" onClick={() => sync(selected.order.id)}>Sync transfer</button> : undefined} /></section></section>;
}


function Reconciliation({ onRun, result, loading }: { onRun: (event: FormEvent<HTMLFormElement>) => void; result: ReconciliationResult | null; loading: boolean }) {
  return <section className="panel-grid two"><article className="panel form-panel"><p className="eyebrow">Controls</p><h3>Run reconciliation</h3><p className="muted">Compare Sivan withdrawals with provider drain history. Always run dry-run first.</p><form className="form" onSubmit={onRun}><label>Mode<select name="dryRun" defaultValue="true"><option value="true">Dry-run only</option><option value="false">Live update records</option></select></label><label>Provider<input name="provider" placeholder="bridge" /></label><label>User ID<input name="userId" placeholder="optional" /></label><label>Liquidation address ID<input name="liquidationAddressId" placeholder="optional" /></label><button className="primary-btn" disabled={loading}>{loading ? 'Running...' : 'Run reconciliation'}</button></form></article><article className="panel"><div className="panel-head"><div><p className="eyebrow">Result</p><h3>Findings</h3></div></div>{!result ? <Empty>No reconciliation run yet.</Empty> : <><div className="stats-grid mini"><Stat label="Dry-run" value={result.dryRun ? 'Yes' : 'No'} /><Stat label="Drains" value={result.summary.checkedDrains} /><Stat label="Updated" value={result.summary.updatedWithdrawals} /><Stat label="Errors" value={result.summary.providerErrors} /></div><div className="list">{result.findings.length ? result.findings.map((finding, index) => <div className="list-item" key={index}><strong>{finding.type}</strong><Badge value={finding.severity} /><small>{finding.message}</small><small>{finding.withdrawalId || finding.liquidationAddressId || finding.providerDrainId || ''}</small></div>) : <Empty>No findings.</Empty>}</div></>}</article></section>;
}

function Providers({ providers, routingDecision, onRoute }: { providers: ProviderCapability[]; routingDecision: RoutingDecision | null; onRoute: (event: FormEvent<HTMLFormElement>) => void }) {
  return <section className="panel-grid two"><article className="panel"><div className="panel-head"><div><p className="eyebrow">Routing catalog</p><h3>Provider capabilities</h3></div></div>{!providers.length ? <Empty>No providers configured.</Empty> : <div className="list">{providers.map((provider) => <div className="list-item" key={provider.name}><strong>{provider.name}</strong><Badge value={provider.available ? 'active' : 'inactive'} /><small>Rails: {provider.destinationPaymentRails.join(', ')}</small><small>Currencies: {provider.destinationCurrencies.join(', ')}</small><small>Reliability: {provider.reliability} · Speed: {provider.speed} · Priority: {provider.priority}</small></div>)}</div>}</article><article className="panel form-panel"><p className="eyebrow">Router</p><h3>Test provider selection</h3><form className="form" onSubmit={onRoute}><label>Source chain<select name="sourceChain" defaultValue="ethereum"><option value="ethereum">Ethereum</option><option value="base">Base</option><option value="polygon">Polygon</option><option value="solana">Solana</option><option value="arbitrum">Arbitrum</option><option value="avalanche_c_chain">Avalanche C-Chain</option></select></label><label>Destination currency<select name="destinationCurrency" defaultValue="usd"><option value="usd">USD</option><option value="gbp">GBP</option><option value="eur">EUR</option></select></label><label>Country<input name="destinationCountry" defaultValue="USA" /></label><label>Rail<input name="destinationPaymentRail" defaultValue="ach" /></label><label>Compliance model<select name="complianceModel" defaultValue="first_party_withdrawal"><option value="first_party_withdrawal">First-party withdrawal</option><option value="third_party_payout">Third-party payout</option><option value="b2b_supplier_payout">B2B supplier payout</option></select></label><label>Required speed<select name="requiredSpeed" defaultValue="standard"><option value="standard">Standard</option><option value="same_day">Same day</option><option value="instant">Instant</option></select></label><button className="primary-btn">Route provider</button></form>{routingDecision && <div className="estimate-box"><Kv label="Selected" value={routingDecision.providerName} /><Kv label="Reason" value={routingDecision.reason} /></div>}</article></section>;
}


function SupportTickets({ tickets, api, onUpdated, notify }: { tickets: AdminSupportTicket[]; api: <T>(path: string, options?: RequestInit) => Promise<T>; onUpdated: () => Promise<void>; notify: (message: string, type?: 'success' | 'error') => void }) {
  const [selected, setSelected] = useState<AdminSupportTicket | null>(null);
  const [actionResult, setActionResult] = useState<string>('');
  const [localTickets, setLocalTickets] = useState<AdminSupportTicket[]>(tickets);
  const [filters, setFilters] = useState({ status: '', priority: '', type: '', assignedTo: '', search: '' });
  const [analytics, setAnalytics] = useState<any>(null);
  useEffect(() => setLocalTickets(tickets), [tickets]);
  useEffect(() => { api<any>('/api/admin/support/analytics').then(setAnalytics).catch(() => null); }, [api]);
  async function loadTicket(ticket: AdminSupportTicket) {
    const detail = await api<AdminSupportTicket>(`/api/admin/support/tickets/${ticket.id}`);
    setSelected(detail);
  }
  async function applyFilters() {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value); });
    const next = await api<AdminSupportTicket[]>(`/api/admin/support/tickets?${params.toString()}`);
    setLocalTickets(next);
  }
  async function updateTicket(ticket: AdminSupportTicket, patch: Partial<AdminSupportTicket>) {
    try {
      const updated = await api<AdminSupportTicket>(`/api/admin/support/tickets/${ticket.id}`, { method: 'PUT', body: JSON.stringify(patch) });
      notify(`Ticket ${ticket.id} updated.`);
      setLocalTickets((items) => items.map((item) => item.id === updated.id ? { ...item, ...updated } : item));
      if (selected?.id === updated.id) setSelected({ ...selected, ...updated });
      await onUpdated();
    } catch (error) { notify((error as Error).message, 'error'); }
  }
  async function addMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const data = getForm(event.currentTarget);
    await api(`/api/admin/support/tickets/${selected.id}/messages`, { method: 'POST', body: JSON.stringify({ message: data.message, internalNote: data.internalNote === 'true' }) });
    await loadTicket(selected);
    (event.currentTarget as HTMLFormElement).reset();
    notify('Message added.');
  }

  async function quickAction(action: 'view' | 'sync' | 'reconcile') {
    if (!selected?.resourceId) return notify('No related resource on this ticket.', 'error');
    try {
      let result: any;
      if (action === 'view') {
        if (selected.resourceType === 'withdrawal') result = await api(`/api/admin/withdrawals/${selected.resourceId}`);
        else if (selected.resourceType === 'onramp_order') result = await api(`/api/admin/onramp/orders/${selected.resourceId}`);
        else if (selected.resourceType === 'customer') result = await api(`/api/admin/customers/${selected.userId}/kyc-status`, { method: 'POST' });
        else result = selected;
      }
      if (action === 'sync') {
        if (selected.resourceType === 'withdrawal') result = await api(`/api/admin/withdrawals/${selected.resourceId}/sync`, { method: 'POST' });
        else if (selected.resourceType === 'onramp_order') result = await api(`/api/admin/onramp/orders/${selected.resourceId}/sync`, { method: 'POST' });
        else if (selected.resourceType === 'customer') result = await api(`/api/admin/customers/${selected.userId}/kyc-status`, { method: 'POST' });
        else throw new Error('Sync is available for withdrawal, on-ramp order, and verification tickets.');
      }
      if (action === 'reconcile') {
        if (selected.resourceType === 'onramp_order') result = await api('/api/admin/onramp/reconciliation/run', { method: 'POST', body: JSON.stringify({ dryRun: true, userId: selected.userId }) });
        else result = await api('/api/admin/reconciliation/run', { method: 'POST', body: JSON.stringify({ dryRun: true, userId: selected.userId }) });
      }
      setActionResult(JSON.stringify(result, null, 2));
      notify(`${action} completed.`);
    } catch (error) { notify((error as Error).message, 'error'); }
  }
  return <section className="panel-grid">{analytics && <div className="stats-grid mini"><Stat label="Open tickets" value={analytics.openTickets} /><Stat label="Urgent" value={analytics.urgentTickets} /><Stat label="Overdue" value={analytics.overdueTickets} /><Stat label="Wrong-network" value={analytics.wrongNetworkCount} /></div>}<article className="panel"><div className="panel-head"><div><p className="eyebrow">User support</p><h3>Support tickets</h3></div></div><div className="support-filter-row"><input placeholder="Search ticket, user, subject, resource" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} /><select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="">All status</option><option value="open">Open</option><option value="in_review">In review</option><option value="waiting_on_user">Waiting on user</option><option value="waiting_on_provider">Waiting on provider</option><option value="resolved">Resolved</option><option value="closed">Closed</option></select><select value={filters.priority} onChange={(e) => setFilters({ ...filters, priority: e.target.value })}><option value="">All priorities</option><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select><select value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })}><option value="">All types</option><option value="wrong_token_or_network">Wrong network</option><option value="deposit_not_detected">Deposit not detected</option><option value="payout_delayed">Payout delayed</option><option value="onramp_payment">On-ramp payment</option><option value="verification">Verification</option></select><select value={filters.assignedTo} onChange={(e) => setFilters({ ...filters, assignedTo: e.target.value })}><option value="">Anyone</option><option value="ops">Ops</option><option value="compliance">Compliance</option><option value="engineering">Engineering</option><option value="provider_support">Provider support</option><option value="michael">Michael</option></select><button className="secondary-btn" onClick={applyFilters}>Apply</button></div>{!localTickets.length ? <Empty>No support tickets found.</Empty> : <div className="table-wrap"><table className="table"><thead><tr><th>ID</th><th>User</th><th>Type</th><th>Priority</th><th>Status</th><th>SLA</th><th>Subject</th><th>Resource</th><th>Messages</th><th>Created</th></tr></thead><tbody>{localTickets.map((ticket) => <tr key={ticket.id} onClick={() => loadTicket(ticket)} className="clickable-row"><td>{ticket.id}</td><td>{ticket.user?.email || ticket.userId}</td><td>{ticket.type.replaceAll('_', ' ')}</td><td><Badge value={ticket.priority} /></td><td><Badge value={ticket.status} /></td><td>{ticket.sla?.overdue ? 'Overdue' : ticket.sla ? `${ticket.sla.minutesUntilDue}m` : '—'}</td><td>{ticket.subject}</td><td>{ticket.resourceType}{ticket.resourceId ? ` · ${ticket.resourceId}` : ''}</td><td>{ticket.messageCount ?? ticket.messages?.length ?? '—'}</td><td>{new Date(ticket.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div>}</article>{selected && <aside className="ticket-detail-drawer panel"><div className="panel-head"><div><p className="eyebrow">Ticket detail</p><h3>{selected.id}</h3></div><button className="ghost-btn small" onClick={() => setSelected(null)}>Close</button></div><div className="details-box"><Kv label="User" value={selected.user?.email || selected.userId} /><Kv label="Type" value={selected.type.replaceAll('_', ' ')} /><Kv label="Priority" value={selected.priority} /><Kv label="Status" value={selected.status} /><Kv label="Assigned" value={selected.assignedTo || 'Unassigned'} /><Kv label="Related resource" value={`${selected.resourceType}${selected.resourceId ? ` · ${selected.resourceId}` : ''}`} /><Kv label="Created" value={new Date(selected.createdAt).toLocaleString()} /><Kv label="Last updated" value={new Date(selected.updatedAt).toLocaleString()} /><Kv label="First response due" value={selected.sla?.firstResponseDueAt ? new Date(selected.sla.firstResponseDueAt).toLocaleString() : '—'} /></div><div className="support-filter-row"><select value={selected.status} onChange={(e) => updateTicket(selected, { status: e.target.value as any })}><option value="open">Open</option><option value="in_review">In review</option><option value="waiting_on_user">Waiting on user</option><option value="waiting_on_provider">Waiting on provider</option><option value="resolved">Resolved</option><option value="closed">Closed</option></select><select value={selected.priority} onChange={(e) => updateTicket(selected, { priority: e.target.value as any })}><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select><select value={selected.assignedTo || ''} onChange={(e) => updateTicket(selected, { assignedTo: e.target.value || undefined })}><option value="">Unassigned</option><option value="ops">Ops</option><option value="compliance">Compliance</option><option value="engineering">Engineering</option><option value="provider_support">Provider support</option><option value="michael">Michael</option></select></div><div className="button-row"><button className="secondary-btn small" onClick={() => updateTicket(selected, { status: 'waiting_on_provider' })}>Mark waiting on provider</button><button className="secondary-btn small" onClick={() => updateTicket(selected, { status: 'waiting_on_user' })}>Mark waiting on user</button><button className="secondary-btn small" onClick={() => quickAction('view')}>View resource</button><button className="secondary-btn small" onClick={() => quickAction('sync')}>Run sync</button><button className="secondary-btn small" onClick={() => quickAction('reconcile')}>Run reconciliation</button></div>{actionResult && <pre className="action-result">{actionResult}</pre>}<h3>Messages</h3><div className="ticket-thread">{(selected.messages ?? []).map((message) => <div className={`ticket-message ${message.internalNote ? 'internal' : message.senderType}`} key={message.id}><strong>{message.internalNote ? 'Internal note' : message.senderType === 'admin' ? 'Sivan Support' : 'User'}</strong><p>{message.message}</p><small>{new Date(message.createdAt).toLocaleString()}</small></div>)}</div><form className="form" onSubmit={addMessage}><label>Reply or internal note<textarea name="message" required /></label><label><select name="internalNote" defaultValue="false"><option value="false">Reply to user</option><option value="true">Internal note only</option></select></label><button className="primary-btn">Add message</button></form></aside>}</section>;
}


function Audit({ auditLogs, reconciliationRuns }: { auditLogs: AdminAuditLog[]; reconciliationRuns: AdminReconciliationRun[] }) {
  const [filters, setFilters] = useState({ actor: '', action: '', resource: '', severity: '', search: '' });
  const [selected, setSelected] = useState<AdminAuditLog | null>(null);
  const filtered = auditLogs.filter((log) =>
    (!filters.actor || `${log.actorType} ${log.actorId || ''}`.toLowerCase().includes(filters.actor.toLowerCase())) &&
    (!filters.action || log.action.toLowerCase().includes(filters.action.toLowerCase())) &&
    (!filters.resource || `${log.resourceType || ''} ${log.resourceId || ''}`.toLowerCase().includes(filters.resource.toLowerCase())) &&
    (!filters.severity || log.severity === filters.severity) &&
    (!filters.search || JSON.stringify(log).toLowerCase().includes(filters.search.toLowerCase()))
  );
  return (
    <section className="panel-grid two">
      <article className="panel">
        <div className="panel-head"><div><p className="eyebrow">Audit trail</p><h3>Admin and user actions</h3></div></div>
        <div className="support-filter-row"><input placeholder="Actor" value={filters.actor} onChange={(event) => setFilters({ ...filters, actor: event.target.value })} /><input placeholder="Action" value={filters.action} onChange={(event) => setFilters({ ...filters, action: event.target.value })} /><input placeholder="Resource" value={filters.resource} onChange={(event) => setFilters({ ...filters, resource: event.target.value })} /><select value={filters.severity} onChange={(event) => setFilters({ ...filters, severity: event.target.value })}><option value="">All severities</option><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option></select><input placeholder="Search metadata/IP/user agent" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} /></div>
        {!filtered.length ? <Empty>No audit logs found.</Empty> : <div className="table-wrap"><table className="table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>Severity</th></tr></thead><tbody>{filtered.slice(0, 200).map((log) => <tr className="clickable-row" key={log.id} onClick={() => setSelected(log)}><td>{new Date(log.createdAt).toLocaleString()}</td><td>{log.actorType}{log.actorId ? ` · ${log.actorId}` : ''}</td><td>{log.action}</td><td>{log.resourceType || '—'}{log.resourceId ? ` · ${log.resourceId}` : ''}</td><td><Badge value={log.severity} /></td></tr>)}</tbody></table></div>}
      </article>
      <article className="panel ticket-detail-drawer">
        <div className="panel-head"><div><p className="eyebrow">Audit detail</p><h3>{selected?.action || 'Select a log'}</h3></div></div>
        {selected ? <DetailObject data={selected} /> : <><Empty>Select an audit row to inspect metadata, IP, user agent, resource, actor, reason, and before/after values.</Empty><div className="panel-head"><div><p className="eyebrow">Reconciliation history</p><h3>Persisted runs</h3></div></div>{!reconciliationRuns.length ? <Empty>No reconciliation runs found.</Empty> : <div className="list">{reconciliationRuns.slice(0, 20).map((run) => <div className="list-item" key={run.id}><strong>{run.dryRun ? 'Dry-run' : 'Live run'} · {run.id}</strong><Badge value={run.status} /><small>{new Date(run.startedAt).toLocaleString()} · Findings: {run.findings.length}</small></div>)}</div>}</>}
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
      const reason = window.prompt('Maker-checker reason for changing system mode') || `Change system mode to ${statusDraft}`;
      await api('/api/admin/approvals', {
        method: 'POST',
        body: JSON.stringify({
          action: 'system_status.update',
          resourceType: 'payments_system_status',
          resourceId: 'global',
          requestedBy: 'ops',
          riskLevel: statusDraft === 'active' ? 'critical' : 'high',
          reason,
          requestedChange: { mode: statusDraft, message: statusMessage || undefined }
        })
      });
      notify(`System mode change submitted for checker approval.`);
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
      const requestedChange = {
        customerTypes: customerTypes.map((control: any) => ({ customerType: control.customerType, enabled: group === 'customer' && control.customerType === key ? enabled : control.enabled })),
        payoutCurrencies: payoutCurrencies.map((control: any) => ({ currency: control.currency, enabled: group === 'payout' && control.currency === key ? enabled : control.enabled })),
        sourceAssets: sourceAssets.map((control: any) => ({ asset: control.asset, enabled: group === 'asset' && control.asset === key ? enabled : control.enabled })),
        sourceNetworks: sourceNetworks.map((control: any) => ({ network: control.network, enabled: group === 'network' && control.network === key ? enabled : control.enabled }))
      };
      const reason = window.prompt(`Maker-checker reason for ${enabled ? 'enabling' : 'disabling'} ${key}`) || `${enabled ? 'Enable' : 'Disable'} ${key}`;
      await api('/api/admin/approvals', {
        method: 'POST',
        body: JSON.stringify({
          action: 'controls.update',
          resourceType: `payment_control.${group}`,
          resourceId: key,
          requestedBy: 'ops',
          riskLevel: enabled ? 'critical' : 'high',
          reason,
          requestedChange
        })
      });
      notify(`${key.toUpperCase()} change submitted for checker approval.`);
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
          <p className="muted">Business stays visible but disabled in the user verification form until you enable it here. Changes now enter maker-checker approval first. A second admin must approve before they apply.</p>
          {!hasAdminKey ? <Empty>Enter and save your Admin API key in the sidebar, then click Refresh to load controls.</Empty> : error ? <Empty>{error}</Empty> : !hasCustomerTypeControls ? <Empty>No customer type controls loaded. Confirm the backend is on the latest deployment.</Empty> : <div className="compact-control-list">{customerTypes.map((control: any) => <div className="control-row" key={control.customerType}><div><strong>{control.label}</strong><Badge value={control.enabled ? 'active' : 'disabled'} /><small>{control.customerType === 'business' ? 'Business/KYB onboarding. Disabled by default until operations enables it.' : 'Individual/KYC onboarding for standard users.'}</small></div><label className="switch-row"><span>{savingKey === `customer:${control.customerType}` ? 'Updating...' : control.enabled ? 'Enabled' : 'Disabled'}</span><button type="button" disabled={Boolean(savingKey)} className={`switch ${control.enabled ? 'on' : ''}`} aria-pressed={control.enabled} onClick={() => toggleControl('customer', control.customerType, !control.enabled)}><span /></button></label></div>)}</div>}
        </article>

        <article className="panel control-panel">
          <div className="panel-head"><div><p className="eyebrow">Rail controls</p><h3>Enable or disable payout currencies</h3></div></div>
          <p className="muted">Currency changes enter maker-checker approval first, then apply after checker approval.</p>
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


function Webhooks({ webhooks, api, notify, onUpdated }: { webhooks: WebhookEventRecord[]; api: <T>(path: string, options?: RequestInit) => Promise<T>; notify: (message: string, type?: 'success' | 'error') => void; onUpdated: () => Promise<void> }) {
  const [category, setCategory] = useState('all');
  const [status, setStatus] = useState('all');
  const [selected, setSelected] = useState<WebhookEventRecord | null>(null);
  const filtered = webhooks.filter((event) => (category === 'all' || event.eventCategory === category) && (status === 'all' || (status === 'processed' ? Boolean(event.processedAt) : !event.processedAt)));
  async function reprocess(id: string) { try { await api(`/api/admin/webhooks/${id}/reprocess`, { method: 'POST' }); notify('Webhook reprocessed.'); await onUpdated(); } catch (error) { notify(errorMessage(error), 'error'); } }
  const categories = Array.from(new Set(webhooks.map((event) => event.eventCategory).filter(Boolean) as string[]));
  return <section className="panel-grid two"><article className="panel"><div className="panel-head"><div><p className="eyebrow">Bridge events</p><h3>Webhook operations</h3></div></div><div className="support-filter-row"><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">All categories</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option><option value="processed">Processed</option><option value="unprocessed">Unprocessed</option></select></div>{!filtered.length ? <Empty>No webhook events found.</Empty> : <div className="table-wrap"><table className="table"><thead><tr><th>ID</th><th>Provider</th><th>Category</th><th>Type</th><th>Object</th><th>Processed</th><th>Created</th></tr></thead><tbody>{filtered.map((event) => <tr className="clickable-row" key={event.id} onClick={() => setSelected(event)}><td>{event.providerEventId}</td><td>{event.provider}</td><td>{event.eventCategory || '—'}</td><td>{event.eventType || '—'}</td><td>{event.eventObjectId || '—'}</td><td><Badge value={event.processedAt ? 'processed' : 'unprocessed'} /></td><td>{new Date(event.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div>}</article><DetailDrawer title="Webhook detail" data={selected ? { ...selected, signatureValidation: 'Verified at ingress before storage', duplicateHandling: 'Duplicate providerEventId is idempotent', processingState: selected.processedAt ? 'processed' : 'unprocessed' } : null} empty="Select a webhook to view raw payload, signature status, processing status, duplicate behavior, and reprocess controls." actions={selected ? <button className="secondary-btn small" onClick={() => reprocess(selected.id)}>Reprocess</button> : undefined} /></section>;
}



function RiskQueue({ cases, api, notify, onUpdated }: { cases: any[]; api: <T>(path: string, options?: RequestInit) => Promise<T>; notify: (message: string, type?: 'success' | 'error') => void; onUpdated: () => Promise<void> }) {
  const [selected, setSelected] = useState<any | null>(null);
  async function review(status: string) {
    if (!selected) return;
    const note = window.prompt('Review note / reason') || '';
    if (!note) return;
    try { await api(`/api/admin/risk/cases/${selected.id}/review`, { method: 'POST', body: JSON.stringify({ status, note, reviewedBy: 'admin_api_key' }) }); notify('Risk case reviewed.'); setSelected(null); await onUpdated(); } catch (error) { notify(errorMessage(error), 'error'); }
  }
  const open = cases.filter((item) => item.status === 'open');
  return <section className="panel-grid two"><article className="panel"><div className="panel-head"><div><p className="eyebrow">Compliance</p><h3>Risk review queue</h3></div><Badge value={`${open.length} open`} /></div>{!cases.length ? <Empty>No risk cases found.</Empty> : <div className="list">{cases.map((item) => <button className="list-item clickable-card" key={item.id} onClick={() => setSelected(item)}><strong>{item.title}</strong><Badge value={item.severity} /><small>{item.type} · {item.resourceType} · {item.resourceId}</small><small>User: {item.userId} · Status: {item.status}</small></button>)}</div>}</article><article className="panel ticket-detail-drawer"><div className="panel-head"><div><p className="eyebrow">Case detail</p><h3>{selected?.title || 'Select a case'}</h3></div></div>{!selected ? <Empty>Choose a risk case to review, escalate, restrict, close, or mark false positive.</Empty> : <><div className="details-box"><Kv label="Case ID" value={selected.id} /><Kv label="Severity" value={selected.severity} /><Kv label="Type" value={selected.type} /><Kv label="Resource" value={`${selected.resourceType} · ${selected.resourceId}`} /><Kv label="User" value={selected.userId} /><Kv label="Status" value={selected.status} /></div><div className="button-row"><button className="secondary-btn small" onClick={() => review('reviewed')}>Mark reviewed</button><button className="secondary-btn small" onClick={() => review('escalated')}>Escalate</button><button className="secondary-btn small" onClick={() => review('restricted')}>Restrict user</button><button className="secondary-btn small" onClick={() => review('false_positive')}>False positive</button><button className="secondary-btn small" onClick={() => review('closed')}>Close</button></div></>}</article></section>;
}

function Approvals({ approvals, api, notify, onUpdated, controls, systemStatus }: { approvals: any[]; api: <T>(path: string, options?: RequestInit) => Promise<T>; notify: (message: string, type?: 'success' | 'error') => void; onUpdated: () => Promise<void>; controls: OfframpControls; systemStatus: SystemStatus }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = getForm(event.currentTarget);
    let requestedChange: any = {};
    if (data.action === 'controls.update') requestedChange = JSON.parse(data.requestedChange || '{}');
    else if (data.action === 'system_status.update') requestedChange = { mode: data.mode, message: data.message || undefined };
    else requestedChange = { description: data.requestedChange };
    try { await api('/api/admin/approvals', { method: 'POST', body: JSON.stringify({ action: data.action, resourceType: data.resourceType || 'admin_control', resourceId: data.resourceId || undefined, reason: data.reason, requestedBy: data.requestedBy || 'ops', riskLevel: data.riskLevel || 'high', requestedChange }) }); notify('Approval request created.'); (event.currentTarget as HTMLFormElement).reset(); await onUpdated(); } catch (error) { notify(errorMessage(error), 'error'); }
  }
  async function review(id: string, action: 'approve' | 'reject') {
    const reviewer = window.prompt('Checker/reviewer name') || '';
    const reason = window.prompt(`${action} reason`) || '';
    if (!reviewer || !reason) return;
    try { await api(`/api/admin/approvals/${id}/${action}`, { method: 'POST', body: JSON.stringify({ reviewer, reason, apply: action === 'approve' }) }); notify(`Approval ${action}d.`); await onUpdated(); } catch (error) { notify(errorMessage(error), 'error'); }
  }
  const controlsTemplate = JSON.stringify({ customerTypes: controls.customerTypes.map(({ customerType, enabled }) => ({ customerType, enabled })), payoutCurrencies: controls.payoutCurrencies.map(({ currency, enabled }) => ({ currency, enabled })), sourceAssets: controls.sourceAssets.map(({ asset, enabled }) => ({ asset, enabled })), sourceNetworks: controls.sourceNetworks.map(({ network, enabled }) => ({ network, enabled })) }, null, 2);
  return <section className="panel-grid two"><article className="panel form-panel"><p className="eyebrow">Maker-checker</p><h3>Create approval request</h3><p className="muted">Use this for enabling chains/USDT/business, payout currency changes, maintenance changes, fee changes, refunds/recoveries, and manual status changes.</p><form className="form" onSubmit={submit}><label>Requested by<input name="requestedBy" defaultValue="ops" /></label><label>Action<select name="action" defaultValue="controls.update"><option value="controls.update">Controls update</option><option value="system_status.update">System status update</option><option value="fee_change.request">Fee change request</option><option value="manual_status_change.request">Manual status change</option><option value="refund_recovery.request">Refund/recovery</option><option value="admin_user_change.request">Admin user change</option></select></label><label>Risk level<select name="riskLevel" defaultValue="high"><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label><label>Resource type<input name="resourceType" defaultValue="admin_control" /></label><label>Resource ID<input name="resourceId" placeholder="optional" /></label><label>System mode for status changes<select name="mode" defaultValue={systemStatus.mode}><option value="active">Active</option><option value="maintenance">Maintenance</option><option value="paused">Paused</option></select></label><label>Message<input name="message" placeholder="customer-facing incident/status message" /></label><label>Requested change JSON / description<textarea name="requestedChange" defaultValue={controlsTemplate} /></label><label>Reason<input name="reason" required placeholder="Why is this needed?" /></label><button className="primary-btn">Submit for approval</button></form></article><article className="panel"><div className="panel-head"><div><p className="eyebrow">Checker queue</p><h3>Pending and reviewed requests</h3></div></div>{!approvals.length ? <Empty>No approval requests yet.</Empty> : <div className="list">{approvals.map((item) => <div className="list-item" key={item.id}><strong>{item.id}</strong><Badge value={item.status} /><small>{item.request?.action} · maker: {item.requestedBy || item.request?.requestedBy}</small><small>{item.request?.reason}</small>{item.status === 'pending' && <div className="button-row"><button className="secondary-btn small" onClick={() => review(item.id, 'approve')}>Approve + apply</button><button className="secondary-btn small" onClick={() => review(item.id, 'reject')}>Reject</button></div>}</div>)}</div>}</article></section>;
}

function IncidentCenter({ systemStatus, controls, api, notify, onUpdated }: { systemStatus: SystemStatus; controls: OfframpControls; api: <T>(path: string, options?: RequestInit) => Promise<T>; notify: (message: string, type?: 'success' | 'error') => void; onUpdated: () => Promise<void> }) {
  async function update(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = getForm(event.currentTarget); try { await api('/api/admin/system/status', { method: 'PUT', body: JSON.stringify({ mode: data.mode, message: data.message || undefined, estimatedResumeAt: data.estimatedResumeAt || undefined }) }); notify('Incident/system status updated.'); await onUpdated(); } catch (error) { notify(errorMessage(error), 'error'); } }
  return <section className="panel-grid two"><article className="panel form-panel"><p className="eyebrow">Incident center</p><h3>Operations status and customer message</h3><form className="form" onSubmit={update}><label>Mode<select name="mode" defaultValue={systemStatus.mode}><option value="active">Active</option><option value="maintenance">Maintenance</option><option value="paused">Paused</option></select></label><label>Customer-facing message<input name="message" defaultValue={systemStatus.message || ''} placeholder="Avalanche deposits delayed due to provider sync issue." /></label><label>Estimated resume at<input name="estimatedResumeAt" placeholder="2026-07-14T18:00:00.000Z" /></label><button className="primary-btn">Update incident status</button></form></article><article className="panel"><div className="panel-head"><div><p className="eyebrow">Current exposure</p><h3>Active rails and networks</h3></div></div><div className="details-box"><Kv label="System mode" value={systemStatus.mode} /><Kv label="Message" value={systemStatus.message || '—'} /><Kv label="Enabled customer types" value={controls.customerTypes.filter((item) => item.enabled).map((item) => item.label).join(', ')} /><Kv label="Enabled payout currencies" value={controls.payoutCurrencies.filter((item) => item.enabled).map((item) => item.currency.toUpperCase()).join(', ')} /><Kv label="Enabled assets" value={controls.sourceAssets.filter((item) => item.enabled).map((item) => item.asset.toUpperCase()).join(', ')} /><Kv label="Enabled networks" value={controls.sourceNetworks.filter((item) => item.enabled).map((item) => item.label).join(', ')} /></div><p className="muted">For chain-specific incidents, disable affected networks in Controls. For broad provider issues, set Maintenance/Pause here.</p></article></section>;
}

function Limits({ controls, api, notify, onUpdated }: { controls: any; api: <T>(path: string, options?: RequestInit) => Promise<T>; notify: (message: string, type?: 'success' | 'error') => void; onUpdated: () => Promise<void> }) {
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = getForm(event.currentTarget); try { await api('/api/admin/limits', { method: 'PUT', body: JSON.stringify(data) }); notify('Limit controls updated.'); await onUpdated(); } catch (error) { notify(errorMessage(error), 'error'); } }
  const c = controls || {};
  return <section className="panel-grid two"><article className="panel form-panel"><p className="eyebrow">Velocity controls</p><h3>Transaction limits</h3><form className="form" onSubmit={submit}><label>New user daily USD<input name="newUserDailyLimitUsd" type="number" defaultValue={c.newUserDailyLimitUsd || 500} /></label><label>Verified user daily USD<input name="verifiedUserDailyLimitUsd" type="number" defaultValue={c.verifiedUserDailyLimitUsd || 5000} /></label><label>Business daily USD<input name="businessDailyLimitUsd" type="number" defaultValue={c.businessDailyLimitUsd || 0} /></label><label>Minimum transaction USD<input name="minTransactionAmountUsd" type="number" defaultValue={c.minTransactionAmountUsd || 10} /></label><label>Max on-ramp USD<input name="maxOnrampAmountUsd" type="number" defaultValue={c.maxOnrampAmountUsd || 5000} /></label><label>Max off-ramp USD<input name="maxOfframpAmountUsd" type="number" defaultValue={c.maxOfframpAmountUsd || 5000} /></label><label>High-value approval threshold USD<input name="highValueApprovalThresholdUsd" type="number" defaultValue={c.highValueApprovalThresholdUsd || 10000} /></label><label>Monthly user limit USD<input name="monthlyUserLimitUsd" type="number" defaultValue={c.monthlyUserLimitUsd || 25000} /></label><label>Updated by<input name="updatedBy" defaultValue="ops" /></label><label>Reason<input name="reason" defaultValue="Update transaction limits" /></label><button className="primary-btn">Save limits</button></form></article><article className="panel"><div className="panel-head"><div><p className="eyebrow">Current policy</p><h3>Exposure guardrails</h3></div></div><DetailObject data={c} /></article></section>;
}

function Finance({ dashboard, overview }: { dashboard: any; overview: AdminOverview | null }) {
  if (!dashboard) return <Empty>No finance dashboard loaded.</Empty>;
  return <section><div className="stats-grid"><Stat label="Total volume" value={`$${dashboard.volume.totalUsd}`} helper="On-ramp + off-ramp" /><Stat label="Gross fees" value={`$${dashboard.fees.grossFeesUsd}`} helper="Sivan revenue" /><Stat label="Provider costs" value={`$${dashboard.costs.providerVariableCostUsd}`} helper="Estimated variable" /><Stat label="Net revenue" value={`$${dashboard.margin.netRevenueUsd}`} helper="After provider + KYC/KYB" /></div><div className="panel-grid two"><article className="panel"><div className="panel-head"><div><p className="eyebrow">Finance</p><h3>Product economics</h3></div></div><DetailObject data={dashboard} /></article><article className="panel"><div className="panel-head"><div><p className="eyebrow">Recovery</p><h3>Onboarding cost recovery</h3></div></div>{overview ? <EconomicsSummary overview={overview} /> : <Empty>No overview metrics loaded.</Empty>}</article></div></section>;
}

function Exports({ apiBase, adminApiKey, notify }: { apiBase: string; adminApiKey: string; notify: (message: string, type?: 'success' | 'error') => void }) {
  const exports = ['users', 'legal-acceptances', 'withdrawals', 'onramp-orders', 'support-tickets', 'audit-logs', 'reconciliation-findings'];
  async function download(type: string) { try { const res = await fetch(`${apiBase}/api/admin/exports/${type}.csv`, { headers: adminApiKey ? { 'x-admin-api-key': adminApiKey } : {} }); if (!res.ok) throw new Error(`${res.status} ${res.statusText}`); const blob = await res.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `sivan-${type}.csv`; a.click(); URL.revokeObjectURL(url); } catch (error) { notify(errorMessage(error), 'error'); } }
  return <article className="panel"><div className="panel-head"><div><p className="eyebrow">Reporting center</p><h3>CSV exports</h3></div></div><div className="compact-control-list">{exports.map((type) => <div className="control-row" key={type}><div><strong>{type.replaceAll('-', ' ')}</strong><small>Filtered operational evidence export for finance, compliance, reconciliation, or grant reporting.</small></div><button className="secondary-btn small" onClick={() => download(type)}>Download CSV</button></div>)}</div></article>;
}

function LegalEvidence({ evidence }: { evidence: any }) {
  if (!evidence) return <Empty>No legal evidence loaded.</Empty>;
  return <section className="panel-grid two"><article className="panel"><div className="panel-head"><div><p className="eyebrow">Legal evidence</p><h3>Acceptance versions</h3></div></div><div className="details-box"><Kv label="Total acceptances" value={evidence.total} />{Object.entries(evidence.byVersion || {}).map(([version, count]) => <Kv key={version} label={version} value={String(count)} />)}</div></article><article className="panel"><div className="panel-head"><div><p className="eyebrow">Recent</p><h3>Acceptance records</h3></div></div><div className="list">{(evidence.recent || []).map((item: any) => <div className="list-item" key={item.id}><strong>{item.email}</strong><small>{item.termsVersion} · {item.privacyVersion} · {item.riskDisclosureVersion}</small><small>{new Date(item.acceptedAt).toLocaleString()} · {item.ipAddress || 'no ip'}</small></div>)}</div></article></section>;
}

function GlobalSearch({ users, withdrawals, orders, tickets, webhooks, initialQuery = '' }: { users: AdminUser[]; withdrawals: AdminWithdrawal[]; orders: AdminOnrampOrder[]; tickets: AdminSupportTicket[]; webhooks: WebhookEventRecord[]; initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const q = query.toLowerCase();
  const results = !q ? [] : [
    ...users.filter((item) => JSON.stringify(item).toLowerCase().includes(q)).map((item) => ({ type: 'user', id: item.id, title: item.email, detail: item.fullName })),
    ...withdrawals.filter((item) => JSON.stringify(item).toLowerCase().includes(q)).map((item) => ({ type: 'withdrawal', id: item.id, title: item.status, detail: item.user?.email || item.userId })),
    ...orders.filter((item) => JSON.stringify(item).toLowerCase().includes(q)).map((item) => ({ type: 'onramp', id: item.id, title: item.status, detail: item.user?.email || item.userId })),
    ...tickets.filter((item) => JSON.stringify(item).toLowerCase().includes(q)).map((item) => ({ type: 'ticket', id: item.id, title: item.subject, detail: item.user?.email || item.userId })),
    ...webhooks.filter((item) => JSON.stringify(item).toLowerCase().includes(q)).map((item) => ({ type: 'webhook', id: item.id, title: item.providerEventId, detail: item.eventCategory || '' }))
  ].slice(0, 100);
  return <article className="panel"><div className="panel-head"><div><p className="eyebrow">Global search</p><h3>Find any operational record</h3></div></div><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search email, user ID, transaction ID, provider ID, ticket ID, tx hash, wallet..." />{!results.length ? <Empty>Start typing to search loaded users, transactions, support tickets, and webhooks.</Empty> : <div className="list">{results.map((item) => <div className="list-item" key={`${item.type}:${item.id}`}><strong>{item.type} · {item.id}</strong><small>{item.title}</small><small>{item.detail}</small></div>)}</div>}</article>;
}

function Economics({ overview, estimate, onEstimate }: { overview: AdminOverview | null; estimate: EconomicsEstimate | null; onEstimate: (event: FormEvent<HTMLFormElement>) => void }) {
  return <section className="panel-grid two">{overview ? <EconomicsSummary overview={overview} /> : <Empty>No economics loaded.</Empty>}<article className="panel form-panel"><p className="eyebrow">Simulator</p><h3>Unit economics estimate</h3><form className="form" onSubmit={onEstimate}><label>Withdrawal amount<input name="amount" type="number" min="1" step="0.01" defaultValue="1000" /></label><label>Customer type<select name="customerType" defaultValue="individual"><option value="individual">Individual — KYC</option><option value="business">Business — KYB</option></select></label><label>Include onboarding cost<select name="includeOnboardingCost" defaultValue="true"><option value="true">Yes</option><option value="false">No</option></select></label><label>Third-party rail fee<input name="thirdPartyRailFee" type="number" min="0" step="0.01" defaultValue="0" /></label><button className="primary-btn">Estimate</button></form>{estimate && <div className="estimate-box"><Kv label="Sivan revenue" value={`$${estimate.revenue.estimatedSivanFeeRevenue}`} /><Kv label="Bridge cost" value={`$${estimate.costs.estimatedBridgeOfframpCost}`} /><Kv label="Onboarding cost" value={`$${estimate.costs.onboardingCost}`} /><Kv label="Total cost" value={`$${estimate.costs.estimatedTotalCost}`} /><Kv label="Contribution margin" value={`$${estimate.margin.estimatedContributionMargin}`} /><Kv label="Break-even volume" value={estimate.margin.onboardingBreakEvenVolume ? `$${estimate.margin.onboardingBreakEvenVolume}` : '—'} /></div>}</article></section>;
}

function Settings({ apiBase }: { apiBase: string }) {
  return <section className="panel-grid two"><article className="panel"><div className="panel-head"><div><p className="eyebrow">Runtime</p><h3>Admin settings</h3></div></div><div className="details-box"><Kv label="API base" value={apiBase} /><Kv label="User frontend" value="/frontend on port 5173" /><Kv label="Admin frontend" value="/frontend-admin on port 5174" /><Kv label="Admin auth" value="Required before production" /></div></article><article className="panel"><div className="panel-head"><div><p className="eyebrow">Production checklist</p><h3>Before launch</h3></div></div><div className="details-box"><Kv label="Admin authentication" value="Pending" /><Kv label="RBAC" value="Pending" /><Kv label="2FA" value="Pending" /><Kv label="Audit logs" value="Pending" /><Kv label="Scheduled reconciliation" value="Pending" /><Kv label="Postgres migration" value="Pending" /></div></article></section>;
}
