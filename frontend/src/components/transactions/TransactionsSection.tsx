import { FormEvent, useMemo, useState } from 'react';
import type { UserRecord, WithdrawalRecord, OnrampOrderRecord, TransactionTimeline } from '../../types';

function PageHero({ title, subtitle, action }: { title: string; subtitle: string; action?: React.ReactNode }) { return <div className="page-hero"><div><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>; }
function Kv({ label, value }: { label: string; value?: string | number | null }) { return <div className="kv"><span>{label}</span><strong>{value ?? '—'}</strong></div>; }
type CustomerTransactionRow = { id: string; kind: 'withdrawal' | 'onramp_order'; label: string; direction: 'sell' | 'buy'; asset: string; amount: string; currency: string; status: string; createdAt: string; providerReference?: string; timeline?: TransactionTimeline; raw: WithdrawalRecord | OnrampOrderRecord; };
function statusClass(status?: string) { if (!status) return 'pending'; if (['completed','kyc_approved','verified','active'].includes(status)) return 'success'; if (['failed','cancelled','kyc_rejected'].includes(status)) return 'danger'; return 'pending'; }
function friendlyStatus(status?: string) { const map: Record<string,string> = { created:'Started', kyc_not_started:'Not started', kyc_approved:'Verified', kyc_under_review:'Under review', kyc_incomplete:'Action required', kyc_rejected:'Verification failed', pending:'Pending', approved:'Approved', pending_deposit:'Waiting for USDC', deposit_received:'Deposit received', payout_processing:'Sending to bank', completed:'Completed', failed:'Failed', cancelled:'Cancelled', requires_action:'Action required', verified:'Verified', active:'Active', awaiting_payment:'Awaiting payment', payment_received:'Payment received', processing:'Processing' }; return status ? map[status] || status.replaceAll('_',' ') : 'Not started'; }
function Badge({ children, status }: { children: string; status?: string }) { return <span className={`badge ${statusClass(status)}`}>{children}</span>; }
function Empty({ children }: { children: string }) { return <div className="empty-state">{children}</div>; }
function shortRef(value?: string) { if (!value) return '—'; if (value.length <= 14) return value; return `${value.slice(0,8)}…${value.slice(-6)}`; }

export function TransactionsView({ user, api, withdrawals, onrampOrders, onStart, onBuy }: { user: UserRecord | null; api: <T>(path: string, options?: RequestInit) => Promise<T>; withdrawals: WithdrawalRecord[]; onrampOrders: OnrampOrderRecord[]; onStart: () => void; onBuy: () => void }) {
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

export function InlineTransactionTimeline({ timeline }: { timeline: TransactionTimeline }) {
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
