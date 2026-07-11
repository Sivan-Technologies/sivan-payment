import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import type { CustomerRecord, DepositResponse, ExternalAccountRecord, FeePolicy, UserRecord, ViewKey, WithdrawalRecord } from './types';

const views: Array<{ key: ViewKey; icon: string; label: string }> = [
  { key: 'overview', icon: '◇', label: 'Home' },
  { key: 'signup', icon: '✦', label: 'Get Started' },
  { key: 'kyc', icon: '◈', label: 'Verify' },
  { key: 'banks', icon: '▣', label: 'Bank' },
  { key: 'withdraw', icon: '↗', label: 'Withdraw' },
  { key: 'history', icon: '☷', label: 'Activity' }
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

export default function App() {
  const [view, setView] = useState<ViewKey>('overview');
  const apiBase = useMemo(() => import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000', []);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [user, setUser] = useState<UserRecord | null>(() => readStorage<UserRecord | null>('sivan.user', null));
  const [customer, setCustomer] = useState<CustomerRecord | null>(() => readStorage<CustomerRecord | null>('sivan.customer', null));
  const [accounts, setAccounts] = useState<ExternalAccountRecord[]>(() => readStorage<ExternalAccountRecord[]>('sivan.accounts', []));
  const [withdrawals, setWithdrawals] = useState<WithdrawalRecord[]>([]);
  const [feePolicy, setFeePolicy] = useState<FeePolicy | null>(null);
  const [depositResult, setDepositResult] = useState<DepositResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const pageTitle = useMemo(() => views.find((item) => item.key === view)?.label ?? 'Home', [view]);
  const primaryAccount = accounts[0];
  const hasUser = Boolean(user?.id);
  const isVerified = customer?.kycStatus === 'kyc_approved';
  const hasBank = accounts.length > 0;
  const activeStep = !hasUser ? 'Create account' : !isVerified ? 'Verify identity' : !hasBank ? 'Add bank' : 'Ready to withdraw';

  const notify = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 4800);
  }, []);

  const api = useCallback(async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(json?.error?.message || 'Something went wrong. Please try again.');
    }
    return (json.data ?? json) as T;
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

  const loadFee = useCallback(async () => {
    const fee = await api<FeePolicy>('/api/fees/offramp').catch(() => null);
    if (fee) setFeePolicy(fee);
  }, [api]);

  useEffect(() => {
    void loadFee();
    void loadUserData();
  }, [loadFee, loadUserData]);

  async function handleSignup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    try {
      const body = getForm(event.currentTarget);
      const created = await api<UserRecord>('/api/users', {
        method: 'POST',
        body: JSON.stringify({ email: body.email, fullName: body.fullName })
      });
      setUser(created);
      setCustomer(null);
      setAccounts([]);
      setWithdrawals([]);
      setDepositResult(null);
      notify('Account created. Next, verify your identity to enable withdrawals.');
      setView('kyc');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleKyc(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user?.id) return notify('Create your account first.', 'error');
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
    setLoading(true);
    try {
      const data = getForm(event.currentTarget);
      const isUsd = data.currency === 'usd';
      const body = {
        userId: user.id,
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
          ? { street_line_1: data.street || '923 Folsom Street', country: 'USA', state: data.state || 'CA', city: data.city || 'San Francisco', postal_code: data.postalCode || '94107' }
          : { street_line_1: data.street || '1 King Street', country: 'GBR', city: data.city || 'London', postal_code: data.postalCode || 'SW1A 1AA' },
        account: isUsd
          ? { routing_number: data.routingNumber, account_number: data.accountNumber, checking_or_savings: 'checking' }
          : { sort_code: data.sortCode, account_number: data.gbAccountNumber }
      };
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
    setLoading(true);
    try {
      const data = getForm(event.currentTarget);
      const selectedAccount = accounts.find((account) => account.id === data.externalAccountId) || primaryAccount;
      if (!selectedAccount) throw new Error('Choose a bank account first.');
      const result = await api<DepositResponse>('/api/withdrawals', {
        method: 'POST',
        body: JSON.stringify({
          userId: user.id,
          externalAccountId: selectedAccount.id,
          sourceCurrency: 'usdc',
          sourceChain: data.sourceChain,
          destinationCurrency: selectedAccount.currency,
          returnAddress: data.returnAddress
        })
      });
      setDepositResult(result);
      await loadUserData();
      notify('Deposit address created. Send USDC to continue.');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-logo" src="/asset/sivan-logo.png" alt="Sivan logo" />
          <div>
            <p className="eyebrow">Sivan</p>
            <h1>Payments</h1>
          </div>
        </div>

        <nav className="nav">
          {views.map((item) => (
            <button key={item.key} className={`nav-item ${view === item.key ? 'active' : ''}`} onClick={() => setView(item.key)}>
              <span>{item.icon}</span> {item.label}
            </button>
          ))}
        </nav>

        <div className="api-card user-card">
          <p className="eyebrow">Progress</p>
          <h3>{activeStep}</h3>
          <p className="hint">Withdraw USDC to your verified bank account in a few guided steps.</p>
          <div className="progress-list">
            <ProgressItem done={hasUser} label="Account" />
            <ProgressItem done={isVerified} label="Verified" />
            <ProgressItem done={hasBank} label="Bank added" />
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">USDC to bank withdrawals</p>
            <h2>{pageTitle}</h2>
          </div>
          <div className="top-actions">
            <div className="status-pill ok"><span /> Secure test lane</div>
            <button className="secondary-btn" onClick={loadUserData} disabled={loading}>{loading ? 'Please wait...' : 'Refresh'}</button>
          </div>
        </header>

        {toast && <section className={`toast ${toast.type === 'error' ? 'error' : ''}`}>{toast.message}</section>}

        {view === 'overview' && (
          <section className="view active">
            <div className="hero-card glass">
              <div>
                <p className="eyebrow">Stablecoin off-ramp</p>
                <h3>Move USDC into your bank account without the complexity.</h3>
                <p className="muted">Sivan gives you a guided withdrawal flow: verify once, add your bank account, send USDC, and track the payout until it arrives.</p>
                <div className="hero-actions">
                  <button className="primary-btn" onClick={() => setView(hasUser ? 'kyc' : 'signup')}>{hasUser ? 'Continue setup' : 'Get started'}</button>
                  <button className="secondary-btn" onClick={() => setView('withdraw')}>Withdraw USDC</button>
                </div>
              </div>
              <div className="flow-card">
                <div className="flow-node">Send USDC</div>
                <div className="flow-line" />
                <div className="flow-node">Sivan converts</div>
                <div className="flow-line" />
                <div className="flow-node accent">Receive USD / GBP</div>
              </div>
            </div>

            <div className="stats-grid">
              <Stat label="Account" value={hasUser ? 'Created' : 'Not started'} helper={user?.email || 'Start with your email'} />
              <Stat label="Verification" value={friendlyStatus(customer?.kycStatus)} helper="Required for withdrawals" />
              <Stat label="Bank accounts" value={String(accounts.length)} helper="Verified payout destinations" />
              <Stat label="Withdrawal fee" value={feePolicy ? `${feePolicy.percent}%` : '—'} helper="Shown before you deposit" />
            </div>

            <div className="panel-grid two">
              <UserGuidePanel />
              <WithdrawalsList withdrawals={withdrawals.slice(0, 4)} compact />
            </div>
          </section>
        )}

        {view === 'signup' && (
          <section className="form-layout">
            <article className="panel form-panel">
              <p className="eyebrow">Step 1</p>
              <h3>Create your account</h3>
              <p className="muted">Use your email to start. You can add payout details after verification.</p>
              <form className="form" onSubmit={handleSignup}>
                <label>Email<input name="email" type="email" placeholder="you@example.com" required /></label>
                <label>Full name<input name="fullName" placeholder="Ada Lovelace" required /></label>
                <button className="primary-btn" disabled={loading}>{loading ? 'Creating...' : 'Create account'}</button>
              </form>
            </article>
            <article className="premium-card">
              <span className="orb" />
              <h3>Built for simple global payouts.</h3>
              <p>No crypto exchange steps. No confusing provider language. Just a clear withdrawal path from USDC to bank.</p>
              <ul><li>Guided setup</li><li>Secure verification</li><li>Bank payout tracking</li></ul>
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
                  <button className="primary-btn" disabled={loading}>{loading ? 'Starting...' : 'Start verification'}</button>
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
            <BankForm onSubmit={handleBank} loading={loading} isVerified={isVerified} />
            <article className="panel">
              <div className="panel-head"><h3>Your bank accounts</h3><button className="ghost-btn small" onClick={loadUserData}>Refresh</button></div>
              <BankList accounts={accounts} />
            </article>
          </section>
        )}

        {view === 'withdraw' && (
          <section className="panel-grid two">
            <article className="panel form-panel">
              <p className="eyebrow">Step 4</p>
              <h3>Withdraw USDC</h3>
              <p className="muted">Choose a verified bank account and get a USDC deposit address.</p>
              {!hasBank ? <Empty>Add a bank account first.</Empty> : (
                <form className="form" onSubmit={handleWithdraw}>
                  <label>Bank account<select name="externalAccountId" defaultValue={primaryAccount?.id}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.bankName || 'Bank account'} · {account.currency.toUpperCase()} · ****{account.accountLast4 || '----'}</option>)}</select></label>
                  <label>USDC network<select name="sourceChain" defaultValue="ethereum"><option value="ethereum">Ethereum</option><option value="base">Base</option><option value="polygon">Polygon</option><option value="solana">Solana</option><option value="arbitrum">Arbitrum</option><option value="optimism">Optimism</option></select></label>
                  <label>Refund wallet address<input name="returnAddress" placeholder="Wallet address for returned funds" defaultValue="0x0000000000000000000000000000000000000000" /></label>
                  <button className="primary-btn" disabled={loading}>{loading ? 'Creating...' : 'Get deposit address'}</button>
                </form>
              )}
            </article>
            <DepositCard result={depositResult} />
          </section>
        )}

        {view === 'history' && <WithdrawalsList withdrawals={withdrawals} />}
      </main>
    </div>
  );
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

function BankForm({ onSubmit, loading, isVerified }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; loading: boolean; isVerified: boolean }) {
  const [currency, setCurrency] = useState('usd');
  if (!isVerified) return <article className="panel form-panel"><p className="eyebrow">Step 3</p><h3>Add your bank</h3><Empty>Complete verification before adding a bank account.</Empty></article>;
  return <article className="panel form-panel"><p className="eyebrow">Step 3</p><h3>Add your bank</h3><p className="muted">Your payout must go to a bank account you own.</p><form className="form" onSubmit={onSubmit}><label>Payout currency<select name="currency" value={currency} onChange={(event) => setCurrency(event.target.value)}><option value="usd">USD — US bank account</option><option value="gbp">GBP — UK bank account</option></select></label><label>Bank name<input name="bankName" defaultValue={currency === 'usd' ? 'Lead Bank' : 'Example UK Bank'} required /></label><label>Account owner name<input name="accountOwnerName" defaultValue="Ada Lovelace" required /></label><div className="split"><label>First name<input name="firstName" defaultValue="Ada" /></label><label>Last name<input name="lastName" defaultValue="Lovelace" /></label></div>{currency === 'usd' ? <><label>Routing number<input name="routingNumber" defaultValue="101019644" /></label><label>Account number<input name="accountNumber" defaultValue="215268129123" /></label></> : <><label>Sort code<input name="sortCode" defaultValue="123456" /></label><label>Account number<input name="gbAccountNumber" defaultValue="12345678" /></label></>}<button className="primary-btn" disabled={loading}>{loading ? 'Adding...' : 'Add bank account'}</button></form></article>;
}

function BankList({ accounts }: { accounts: ExternalAccountRecord[] }) {
  if (!accounts.length) return <Empty>No bank account added yet.</Empty>;
  return <div className="list">{accounts.map((account) => <div className="list-item" key={account.id}><strong>{account.bankName || 'Bank account'} • {account.currency.toUpperCase()}</strong><Badge status={account.status}>{friendlyStatus(account.status)}</Badge><small>{account.paymentRail.replaceAll('_', ' ')} · ****{account.accountLast4 || '----'}</small></div>)}</div>;
}

function DepositCard({ result }: { result: DepositResponse | null }) {
  if (!result) return <article className="deposit-card"><p className="eyebrow">Deposit address</p><h3>Ready when you are</h3><p className="muted">Create a withdrawal to receive a USDC deposit address. You will see the network, fee, and payout currency before sending.</p></article>;
  return <article className="deposit-card"><p className="eyebrow">Send USDC</p><h3>Deposit address created</h3><p className="muted">Send USDC on {result.deposit.chain} to this address. We will convert it and send {result.withdrawal.destinationCurrency.toUpperCase()} to your selected bank account.</p><div className="deposit-address">{result.deposit.address}</div><Kv label="Reference" value={shortRef(result.withdrawal.id)} /><Kv label="Fee" value={`${result.withdrawal.feePercent || '0'}%`} /><Kv label="Status" value={friendlyStatus(result.withdrawal.status)} /></article>;
}

function WithdrawalsList({ withdrawals, compact = false }: { withdrawals: WithdrawalRecord[]; compact?: boolean }) {
  return <article className="panel"><div className="panel-head"><div><p className="eyebrow">Withdrawals</p><h3>{compact ? 'Recent activity' : 'Withdrawal activity'}</h3></div></div>{!withdrawals.length ? <Empty>No withdrawals yet.</Empty> : compact ? <div className="list">{withdrawals.map((w) => <div className="list-item" key={w.id}><strong>{w.destinationCurrency.toUpperCase()} withdrawal</strong><Badge status={w.status}>{friendlyStatus(w.status)}</Badge><small>Reference {shortRef(w.id)}</small></div>)}</div> : <div className="table-wrap"><table className="table"><thead><tr><th>Reference</th><th>Status</th><th>Currency</th><th>Amount</th><th>Fee</th><th>Date</th></tr></thead><tbody>{withdrawals.map((w) => <tr key={w.id}><td>{shortRef(w.id)}</td><td><Badge status={w.status}>{friendlyStatus(w.status)}</Badge></td><td>{w.destinationCurrency.toUpperCase()}</td><td>{w.destinationAmount || '—'}</td><td>{w.feeAmount || (w.feePercent ? `${w.feePercent}%` : '—')}</td><td>{new Date(w.createdAt).toLocaleDateString()}</td></tr>)}</tbody></table></div>}</article>;
}

function UserGuidePanel() {
  return <article className="panel"><div className="panel-head"><div><p className="eyebrow">How it works</p><h3>A simple withdrawal flow</h3></div></div><div className="details-box"><Kv label="1" value="Create your Sivan account" /><Kv label="2" value="Complete verification" /><Kv label="3" value="Add your bank account" /><Kv label="4" value="Send USDC to your deposit address" /><Kv label="5" value="Receive USD/GBP in your bank account" /></div></article>;
}
