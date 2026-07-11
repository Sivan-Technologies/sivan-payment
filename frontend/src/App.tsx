import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CustomerRecord,
  DepositResponse,
  ExternalAccountRecord,
  FeePolicy,
  UserRecord,
  ViewKey,
  WithdrawalRecord
} from './types';

const views: Array<{ key: ViewKey; icon: string; label: string }> = [
  { key: 'overview', icon: '◇', label: 'Overview' },
  { key: 'signup', icon: '✦', label: 'Signup' },
  { key: 'kyc', icon: '◈', label: 'Verification' },
  { key: 'banks', icon: '▣', label: 'Bank Accounts' },
  { key: 'withdraw', icon: '↗', label: 'Withdraw' },
  { key: 'history', icon: '☷', label: 'History' }
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
  if (status === 'completed' || status === 'kyc_approved' || status === 'verified' || status === 'active') return 'success';
  if (status === 'failed' || status === 'cancelled' || status === 'kyc_rejected') return 'danger';
  return 'pending';
}

function Badge({ children, status }: { children: string; status?: string }) {
  return <span className={`badge ${statusClass(status)}`}>{children}</span>;
}

function Empty({ children }: { children: string }) {
  return <div className="empty-state">{children}</div>;
}

function Kv({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div className="kv">
      <span>{label}</span>
      <strong>{value ?? '—'}</strong>
    </div>
  );
}

function getForm(form: HTMLFormElement) {
  return Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
}

export default function App() {
  const [view, setView] = useState<ViewKey>('overview');
  const [apiBase, setApiBase] = useState(() => localStorage.getItem('sivan.apiBase') || import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000');
  const [apiDraft, setApiDraft] = useState(apiBase);
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const [user, setUser] = useState<UserRecord | null>(() => readStorage<UserRecord | null>('sivan.user', null));
  const [customer, setCustomer] = useState<CustomerRecord | null>(() => readStorage<CustomerRecord | null>('sivan.customer', null));
  const [accounts, setAccounts] = useState<ExternalAccountRecord[]>(() => readStorage<ExternalAccountRecord[]>('sivan.accounts', []));
  const [withdrawals, setWithdrawals] = useState<WithdrawalRecord[]>([]);
  const [feePolicy, setFeePolicy] = useState<FeePolicy | null>(null);
  const [depositResult, setDepositResult] = useState<DepositResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const pageTitle = useMemo(() => views.find((item) => item.key === view)?.label ?? 'Overview', [view]);

  const notify = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 4800);
  }, []);

  const api = useCallback(
    async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
      const response = await fetch(`${apiBase}${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(json?.error?.message || `${response.status} ${response.statusText}`);
      }
      return (json.data ?? json) as T;
    },
    [apiBase]
  );

  useEffect(() => {
    localStorage.setItem('sivan.apiBase', apiBase);
  }, [apiBase]);

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

  const checkApi = useCallback(async () => {
    try {
      await api('/health');
      setApiOnline(true);
    } catch {
      setApiOnline(false);
    }
  }, [api]);

  const loadFeesAndMetrics = useCallback(async () => {
    const fee = await api<FeePolicy>('/api/fees/offramp').catch(() => null);
    if (fee) setFeePolicy(fee);
  }, [api]);

  const loadUserData = useCallback(async () => {
    if (!user?.id) return;
    const [customerResult, accountsResult, withdrawalsResult] = await Promise.allSettled([
      api<CustomerRecord>(`/api/customers/${user.id}`),
      api<ExternalAccountRecord[]>(`/api/users/${user.id}/external-accounts`),
      api<WithdrawalRecord[]>(`/api/users/${user.id}/withdrawals`)
    ]);
    if (customerResult.status === 'fulfilled') setCustomer(customerResult.value);
    if (accountsResult.status === 'fulfilled') setAccounts(accountsResult.value);
    if (withdrawalsResult.status === 'fulfilled') setWithdrawals(withdrawalsResult.value);
  }, [api, user?.id]);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      await checkApi();
      await loadFeesAndMetrics();
      await loadUserData();
    } finally {
      setLoading(false);
    }
  }, [checkApi, loadFeesAndMetrics, loadUserData]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  async function handleSignup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    try {
      const body = getForm(event.currentTarget);
      const created = await api<UserRecord>('/api/users', { method: 'POST', body: JSON.stringify(body) });
      setUser(created);
      setCustomer(null);
      setAccounts([]);
      setWithdrawals([]);
      setDepositResult(null);
      notify('User created. Continue to verification to enable withdrawals.');
      setView('kyc');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleKyc(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    try {
      const body = getForm(event.currentTarget);
      const created = await api<CustomerRecord>('/api/customers/kyc-link', { method: 'POST', body: JSON.stringify(body) });
      setCustomer(created);
      notify('Verification started. Follow the verification link to complete onboarding.');
      setView('banks');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function refreshKyc() {
    if (!user?.id) return notify('Create a user first.', 'error');
    try {
      const refreshed = await api<CustomerRecord>(`/api/customers/${user.id}/kyc-status`);
      setCustomer(refreshed);
      notify('KYC status refreshed.');
    } catch (error) {
      notify((error as Error).message, 'error');
    }
  }

  async function handleBank(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    try {
      const data = getForm(event.currentTarget);
      const isUsd = data.currency === 'usd';
      const body = {
        userId: data.userId,
        currency: data.currency,
        accountType: isUsd ? 'us' : 'gb',
        paymentRail: isUsd ? 'ach' : 'faster_payments',
        bankName: data.bankName,
        accountName: `${data.accountOwnerName} account`,
        accountOwnerName: data.accountOwnerName,
        accountOwnerType: 'individual',
        firstName: data.firstName,
        lastName: data.lastName,
        address: isUsd
          ? { street_line_1: '923 Folsom Street', country: 'USA', state: 'CA', city: 'San Francisco', postal_code: '94107' }
          : { street_line_1: '1 King Street', country: 'GBR', city: 'London', postal_code: 'SW1A 1AA' },
        account: isUsd
          ? { routing_number: data.routingNumber, account_number: data.accountNumber, checking_or_savings: 'checking' }
          : { sort_code: data.sortCode, account_number: data.gbAccountNumber }
      };
      const account = await api<ExternalAccountRecord>('/api/external-accounts', { method: 'POST', body: JSON.stringify(body) });
      setAccounts((existing) => [account, ...existing.filter((item) => item.id !== account.id)]);
      notify('Bank account added.');
      setView('withdraw');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleWithdraw(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    try {
      const data = getForm(event.currentTarget);
      const result = await api<DepositResponse>('/api/withdrawals', {
        method: 'POST',
        body: JSON.stringify({
          userId: data.userId,
          externalAccountId: data.externalAccountId,
          sourceCurrency: 'usdc',
          sourceChain: data.sourceChain,
          destinationCurrency: data.destinationCurrency,
          returnAddress: data.returnAddress
        })
      });
      setDepositResult(result);
      await loadUserData();
      notify('Deposit address created.');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  const primaryAccount = accounts[0];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-logo" src="/asset/sivan-logo.png" alt="Sivan logo" />
          <div>
            <p className="eyebrow">Sivan</p>
            <h1>Off-Ramp</h1>
          </div>
        </div>

        <nav className="nav">
          {views.map((item) => (
            <button key={item.key} className={`nav-item ${view === item.key ? 'active' : ''}`} onClick={() => setView(item.key)}>
              <span>{item.icon}</span> {item.label}
            </button>
          ))}
        </nav>

        <div className="api-card">
          <label htmlFor="apiBase">API base</label>
          <input id="apiBase" value={apiDraft} onChange={(event) => setApiDraft(event.target.value)} />
          <button
            className="ghost-btn"
            onClick={() => {
              setApiBase(apiDraft.replace(/\/$/, ''));
              notify('API URL saved.');
            }}
          >
            Save API URL
          </button>
          <p className="hint">Backend: <code>npm run dev</code> from repo root.</p>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">React + TypeScript Control Center</p>
            <h2>{pageTitle}</h2>
          </div>
          <div className="top-actions">
            <div className={`status-pill ${apiOnline === true ? 'ok' : apiOnline === false ? 'bad' : ''}`}>
              <span /> {apiOnline === true ? 'API connected' : apiOnline === false ? 'API offline' : 'Checking API'}
            </div>
            <button className="secondary-btn" onClick={refreshAll} disabled={loading}>{loading ? 'Loading...' : 'Refresh'}</button>
          </div>
        </header>

        {toast && <section className={`toast ${toast.type === 'error' ? 'error' : ''}`}>{toast.message}</section>}

        {view === 'overview' && (
          <section className="view active">
            <div className="hero-card glass">
              <div>
                <p className="eyebrow">USDC → USD/GBP</p>
                <h3>Premium bank payout experience for stablecoin users.</h3>
                <p className="muted">Sign up, verify your account, add a bank account, and withdraw USDC to USD or GBP with a simple premium experience.</p>
                <div className="hero-actions">
                  <button className="primary-btn" onClick={() => setView('signup')}>Create user</button>
                  <button className="secondary-btn" onClick={() => setView('withdraw')}>Create withdrawal</button>
                </div>
              </div>
              <div className="flow-card">
                <div className="flow-node">USDC</div>
                <div className="flow-line" />
                <div className="flow-node">Sivan deposit address</div>
                <div className="flow-line" />
                <div className="flow-node">Verified bank account</div>
                <div className="flow-line" />
                <div className="flow-node accent">USD / GBP</div>
              </div>
            </div>

            <div className="stats-grid">
              <Stat label="Current user" value={user ? 'Active' : '—'} helper={user?.email || 'No user selected'} />
              <Stat label="KYC status" value={customer?.kycStatus || '—'} helper="Bridge customer verification" />
              <Stat label="Sivan fee" value={feePolicy ? `${feePolicy.percent}%` : '—'} helper="User-facing off-ramp fee" />
              <Stat label="Withdrawals" value={String(withdrawals.length)} helper="Your withdrawal history" />
            </div>

            <div className="panel-grid two">
              <WithdrawalsList withdrawals={withdrawals.slice(0, 4)} compact />
              <UserGuidePanel />
            </div>
          </section>
        )}

        {view === 'signup' && (
          <section className="form-layout">
            <article className="panel form-panel">
              <p className="eyebrow">Step 1</p>
              <h3>Create a Sivan user</h3>
              <p className="muted">Create your Sivan account to begin the secure withdrawal setup.</p>
              <form className="form" onSubmit={handleSignup}>
                <label>Email<input name="email" type="email" placeholder="ada@sivan.app" required /></label>
                <label>Full name<input name="fullName" placeholder="Ada Lovelace" required /></label>
                <button className="primary-btn" disabled={loading}>Create user</button>
              </form>
            </article>
            <article className="premium-card">
              <span className="orb" />
              <h3>Withdraw USDC with confidence.</h3>
              <p>A focused flow for verified users who want stablecoin-to-bank withdrawals.</p>
              <ul><li>Simple signup</li><li>Secure verification</li><li>Verified bank payouts</li></ul>
            </article>
          </section>
        )}

        {view === 'kyc' && (
          <section className="panel-grid two">
            <article className="panel form-panel">
              <p className="eyebrow">Step 2</p>
              <h3>Start KYC / KYB</h3>
              <p className="muted">Complete verification to enable withdrawals to your verified bank account.</p>
              <form className="form" onSubmit={handleKyc}>
                <label>User ID<input name="userId" defaultValue={user?.id || ''} placeholder="usr_..." required /></label>
                <label>Customer type<select name="type" defaultValue="individual"><option value="individual">Individual</option><option value="business">Business</option></select></label>
                <label>Redirect URL<input name="redirectUri" type="url" defaultValue="https://app.sivan.test/kyc/complete" /></label>
                <button className="primary-btn" disabled={loading}>Start verification</button>
              </form>
            </article>
            <article className="panel">
              <div className="panel-head"><h3>Verification status</h3><button className="ghost-btn small" onClick={refreshKyc}>Refresh KYC</button></div>
              {customer ? <CustomerDetails customer={customer} /> : <Empty>No customer loaded.</Empty>}
            </article>
          </section>
        )}

        {view === 'banks' && (
          <section className="panel-grid two">
            <BankForm userId={user?.id || ''} onSubmit={handleBank} loading={loading} />
            <article className="panel">
              <div className="panel-head"><h3>Bank accounts</h3><button className="ghost-btn small" onClick={loadUserData}>Load</button></div>
              <BankList accounts={accounts} onUse={(account) => setView('withdraw')} />
            </article>
          </section>
        )}

        {view === 'withdraw' && (
          <section className="panel-grid two">
            <article className="panel form-panel">
              <p className="eyebrow">Step 4</p>
              <h3>Create withdrawal</h3>
              <p className="muted">Creates a Bridge liquidation address and returns a user-facing USDC deposit address.</p>
              <form className="form" onSubmit={handleWithdraw}>
                <label>User ID<input name="userId" defaultValue={user?.id || ''} required /></label>
                <label>External account ID<input name="externalAccountId" defaultValue={primaryAccount?.id || ''} placeholder="ea_..." required /></label>
                <label>Destination currency<select name="destinationCurrency" defaultValue={primaryAccount?.currency || 'usd'}><option value="usd">USD</option><option value="gbp">GBP</option></select></label>
                <label>USDC chain<select name="sourceChain" defaultValue="ethereum"><option value="ethereum">Ethereum</option><option value="base">Base</option><option value="polygon">Polygon</option><option value="solana">Solana</option><option value="arbitrum">Arbitrum</option><option value="optimism">Optimism</option></select></label>
                <label>Return address<input name="returnAddress" defaultValue="0x0000000000000000000000000000000000000000" /></label>
                <button className="primary-btn" disabled={loading}>Create deposit address</button>
              </form>
            </article>
            <DepositCard result={depositResult} />
          </section>
        )}

        {view === 'history' && <WithdrawalsList withdrawals={withdrawals} />}
      </main>
    </div>
  );
}

function Stat({ label, value, helper }: { label: string; value: string; helper: string }) {
  return <article className="stat-card"><p>{label}</p><strong>{value}</strong><span>{helper}</span></article>;
}

function CustomerDetails({ customer }: { customer: CustomerRecord }) {
  return <div className="details-box"><Kv label="Customer ID" value={customer.id} /><Kv label="Type" value={customer.customerType || 'individual'} /><Kv label="Verification status" value={customer.kycStatus} /><Kv label="Terms status" value={customer.tosStatus || '—'} /><Kv label="Verification link" value={customer.kycLink || customer.hostedKycLink || '—'} /></div>;
}

function BankForm({ userId, onSubmit, loading }: { userId: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; loading: boolean }) {
  const [currency, setCurrency] = useState('usd');
  return <article className="panel form-panel"><p className="eyebrow">Step 3</p><h3>Add verified bank account</h3><form className="form" onSubmit={onSubmit}><label>User ID<input name="userId" defaultValue={userId} required /></label><label>Currency<select name="currency" value={currency} onChange={(event) => setCurrency(event.target.value)}><option value="usd">USD — US ACH</option><option value="gbp">GBP — Faster Payments</option></select></label><label>Bank name<input name="bankName" defaultValue={currency === 'usd' ? 'Lead Bank' : 'Example UK Bank'} required /></label><label>Account owner name<input name="accountOwnerName" defaultValue="Ada Lovelace" required /></label><div className="split"><label>First name<input name="firstName" defaultValue="Ada" /></label><label>Last name<input name="lastName" defaultValue="Lovelace" /></label></div>{currency === 'usd' ? <><label>Routing number<input name="routingNumber" defaultValue="101019644" /></label><label>Account number<input name="accountNumber" defaultValue="215268129123" /></label></> : <><label>Sort code<input name="sortCode" defaultValue="123456" /></label><label>Account number<input name="gbAccountNumber" defaultValue="12345678" /></label></>}<button className="primary-btn" disabled={loading}>Add bank account</button></form></article>;
}

function BankList({ accounts }: { accounts: ExternalAccountRecord[]; onUse: (account: ExternalAccountRecord) => void }) {
  if (!accounts.length) return <Empty>No bank accounts loaded.</Empty>;
  return <div className="list">{accounts.map((account) => <div className="list-item" key={account.id}><strong>{account.bankName || 'Bank account'} • {account.currency.toUpperCase()}</strong><Badge status={account.status}>{account.status}</Badge><small>{account.id} · {account.accountType} · ****{account.accountLast4 || '----'}</small></div>)}</div>;
}

function DepositCard({ result }: { result: DepositResponse | null }) {
  if (!result) return <article className="deposit-card"><p className="eyebrow">Deposit Address</p><h3>Waiting for withdrawal</h3><p className="muted">Create a withdrawal to generate a USDC deposit address.</p></article>;
  return <article className="deposit-card"><p className="eyebrow">Send USDC</p><h3>Deposit address created</h3><p className="muted">Send USDC on {result.deposit.chain} to this address. Sivan converts it and sends {result.withdrawal.destinationCurrency.toUpperCase()} to the selected bank account.</p><div className="deposit-address">{result.deposit.address}</div><Kv label="Withdrawal" value={result.withdrawal.id} /><Kv label="Fee" value={`${result.withdrawal.feePercent || '0'}%`} /></article>;
}

function WithdrawalsList({ withdrawals, compact = false }: { withdrawals: WithdrawalRecord[]; compact?: boolean }) {
  return <article className="panel"><div className="panel-head"><div><p className="eyebrow">Withdrawals</p><h3>{compact ? 'Recent withdrawals' : 'Withdrawal history'}</h3></div></div>{!withdrawals.length ? <Empty>No withdrawals yet.</Empty> : compact ? <div className="list">{withdrawals.map((w) => <div className="list-item" key={w.id}><strong>{w.destinationCurrency.toUpperCase()} withdrawal</strong><Badge status={w.status}>{w.status}</Badge><small>{w.id}</small></div>)}</div> : <div className="table-wrap"><table className="table"><thead><tr><th>ID</th><th>Status</th><th>Currency</th><th>Amount</th><th>Fee</th><th>Created</th></tr></thead><tbody>{withdrawals.map((w) => <tr key={w.id}><td>{w.id}</td><td><Badge status={w.status}>{w.status}</Badge></td><td>{w.destinationCurrency.toUpperCase()}</td><td>{w.destinationAmount || '—'}</td><td>{w.feeAmount || w.feePercent || '—'}</td><td>{new Date(w.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div>}</article>;
}


function UserGuidePanel() {
  return (
    <article className="panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Getting started</p>
          <h3>Your withdrawal flow</h3>
        </div>
      </div>
      <div className="details-box">
        <Kv label="1" value="Create your Sivan account" />
        <Kv label="2" value="Complete verification" />
        <Kv label="3" value="Add a verified bank account" />
        <Kv label="4" value="Send USDC to your deposit address" />
        <Kv label="5" value="Receive USD/GBP in your bank account" />
      </div>
    </article>
  );
}

