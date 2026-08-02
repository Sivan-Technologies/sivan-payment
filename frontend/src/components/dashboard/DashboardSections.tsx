import { useState } from 'react';
import type { AssetControl, NetworkControl, PaymentControl, UserRecord, WithdrawalRecord, OnrampOrderRecord, VerificationSummary } from '../../types';

function statusClass(status?: string) { if (!status) return 'pending'; if (['completed','kyc_approved','verified','active'].includes(status)) return 'success'; if (['failed','cancelled','kyc_rejected'].includes(status)) return 'danger'; return 'pending'; }
function friendlyStatus(status?: string) { const map: Record<string,string> = { created:'Started', kyc_not_started:'Not started', kyc_approved:'Verified', kyc_under_review:'Under review', kyc_incomplete:'Action required', kyc_rejected:'Verification failed', pending:'Pending', approved:'Approved', pending_deposit:'Waiting for USDC', deposit_received:'Deposit received', payout_processing:'Sending to bank', completed:'Completed', failed:'Failed', cancelled:'Cancelled', requires_action:'Action required', verified:'Verified', active:'Active', awaiting_payment:'Awaiting payment' }; return status ? map[status] || status.replaceAll('_',' ') : 'Not started'; }
function Badge({ children, status }: { children: string; status?: string }) { return <span className={`badge ${statusClass(status)}`}>{children}</span>; }
function Empty({ children }: { children: string }) { return <div className="empty-state">{children}</div>; }
function shortRef(value?: string) { if (!value) return '—'; if (value.length <= 14) return value; return `${value.slice(0,8)}…${value.slice(-6)}`; }

function SidebarSetupCard({ setupPercent, hasUser, isVerified, hasBank, onContinue }: { setupPercent: number; hasUser: boolean; isVerified: boolean; hasBank: boolean; onContinue: () => void }) {
  const helper = !hasUser ? 'Create your account to start.' : !isVerified ? 'Verify your identity next.' : !hasBank ? 'Add your payout method.' : 'Ready for transactions.';
  return <article className="sidebar-setup-card"><p>Account setup</p><strong>{setupPercent}%</strong><div className="bar"><div className="fill" style={{ width: `${setupPercent}%` }} /></div><small>{helper}</small><button className="primary-btn" onClick={onContinue}>Continue setup ›</button></article>;
}

export function PublicSidebarCta({ onCreate }: { onCreate: () => void }) {
  return <article className="sidebar-setup-card public-cta"><p>New to Sivan?</p><strong>Start</strong><small>Create your account to access payments, verification, and linked WhatsApp identity.</small><button className="primary-btn" onClick={onCreate}>Create account ›</button></article>;
}

export function KpiCard({ label, value, sub, trend }: { label: string; value: string; sub: string; trend: string }) {
  return <article className="kpi-card"><p>{label}</p><strong>{value}</strong><span>{sub}</span><small>{trend}</small></article>;
}

export function DashboardTransactions({ withdrawals, onrampOrders, onStart, onBuy, onViewAll }: { withdrawals: WithdrawalRecord[]; onrampOrders: OnrampOrderRecord[]; onStart: () => void; onBuy: () => void; onViewAll: () => void }) {
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

export function TwoFactorRecommendationCard({ completedCount, onEnable, onDismiss }: { completedCount: number; onEnable: () => void; onDismiss: () => void }) {
  const active = completedCount > 0;
  return <article className={`security-card two-factor-recommendation ${active ? 'after-activity' : ''}`}><div className="security-icon">⚿</div><div><p className="eyebrow">Security recommendation</p><h3>{active ? 'Secure your account before your next payment' : 'Protect your Sivan account'}</h3><p>{active ? 'You’ve completed your first Sivan transaction. Add authenticator 2FA to protect future transfers and payouts.' : 'Enable authenticator 2FA to secure transfers and payouts. You can skip this for now.'}</p><div className="recommendation-actions"><button className="primary-btn small" onClick={onEnable}>Enable 2FA</button><button className="ghost-btn small" onClick={onDismiss}>{active ? 'Not now' : 'Maybe later'}</button></div></div></article>;
}

export function DashboardSetupPanel({ setupPercent, hasUser, isVerified, hasBank, user, summary, onContinue }: { setupPercent: number; hasUser: boolean; isVerified: boolean; hasBank: boolean; user: UserRecord | null; summary: VerificationSummary | null; onContinue: () => void }) {
  const whatsappLinked = Boolean(user?.whatsappNumber || user?.whatsappVerifiedAt);
  const buttonLabel = !isVerified ? 'Start verification →' : !hasBank ? 'Add payout bank →' : 'Manage payment methods →';

  // COPY FOLLOWS THE PATH, NOT THE BRIDGE FLOW.
  //
  // "Identity verified / ~3 minutes" describes a document-and-selfie check. A
  // Nigerian is never asked for either - they confirm a bank account in their
  // own name - so this promised the wrong thing and set the wrong expectation
  // about how long it takes.
  const isNgnPath = summary?.path === 'ngn_bank';
  const verifyTitle = isNgnPath ? 'Bank verified' : 'Identity verified';
  const verifySub = isVerified
    ? 'Ready'
    : summary?.hasPendingPayoutReview
      // A queued NUBAN is not "not started". Telling the user it takes a
      // minute when it is already sitting with a reviewer reads as a failure.
      ? 'Being checked'
      : isNgnPath ? 'About a minute' : '~3 minutes';

  // On the NGN path the payout bank IS the verification - one action clears
  // both - so presenting them as two separate outstanding steps overstates
  // what is left to do.
  const bankSub = hasBank
    ? 'Bank added'
    : isNgnPath ? 'Added when you verify' : 'Add a bank to sell crypto';

  return <article className="dashboard-setup-panel"><div className="panel-head"><div><p className="eyebrow">Setup</p><h3>Account setup</h3></div><strong className="setup-percent-pill">{setupPercent}%</strong></div><div className="setup-list"><SetupLine done={hasUser} title="Email confirmed" sub={user?.email ? 'Signed in securely' : 'Create account'} /><SetupLine done={whatsappLinked} optional title="WhatsApp linked" sub="Optional for escrow and alerts" /><SetupLine done={isVerified} title={verifyTitle} sub={verifySub} /><SetupLine done={hasBank} title="Payout bank" sub={bankSub} /></div><div className="setup-progress"><div><span style={{ width: `${setupPercent}%` }} /></div><strong>{setupPercent}%</strong></div><button className="primary-btn" onClick={onContinue}>{buttonLabel}</button></article>;
}

function SetupLine({ done, title, sub, optional = false }: { done: boolean; title: string; sub: string; optional?: boolean }) {
  return <div className={`setup-line ${done ? 'done' : ''} ${optional ? 'optional' : ''}`}><span>{done ? '✓' : optional ? '•' : '○'}</span><div><strong>{title}</strong><small>{sub}</small></div></div>;
}

function SecurityReminder({ onSettings }: { onSettings: () => void }) {
  return <article className="security-card"><div className="security-icon">◈</div><div><h3>Security reminder</h3><p>Enable two-factor authentication and never share your seed phrase. Sivan will never ask for wallet private keys or 2FA codes outside the dashboard.</p><button onClick={onSettings}>Security settings →</button></div></article>;
}


