import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { UserRecord, WithdrawalRecord, OnrampOrderRecord, TransactionTimeline, NgnTransferRecord, BalanceTransferRecord, SupplierPaymentRecord, VirtualAccountTransactionRecord, WalletDepositRecord, ServiceAgreementsSummary } from '../../types';
import { buildActivityFeed, filterActivity, searchActivity, type ActivityRow } from '../../activityFeed';
import { ActivityRowItem } from '../activity/ActivityRowItem';
import { explorerLink, networkLabel, shortHash } from '../../blockExplorer';
import { NetworkLogo, logoChainFor } from '../receive/NetworkLogo';
import { useAskSivan, AssistantThread, followUpsFor, MAX_SESSION_MESSAGES, MAX_DAILY_MESSAGES, type AssistantContext } from '../support/askSivan';

function PageHero({ title, subtitle, action }: { title: string; subtitle: string; action?: React.ReactNode }) { return <div className="page-hero"><div><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>; }
function Kv({ label, value }: { label: string; value?: string | number | null }) { return <div className="kv"><span>{label}</span><strong>{value ?? '—'}</strong></div>; }
type CustomerTransactionRow = { id: string; kind: 'withdrawal' | 'onramp_order' | 'ngn_transfer'; label: string; direction: 'sell' | 'buy'; asset: string; amount: string; currency: string; status: string; createdAt: string; providerReference?: string; timeline?: TransactionTimeline; depositAddress?: string; network?: string; expiresAt?: string; cancellable?: boolean; raw: WithdrawalRecord | OnrampOrderRecord | NgnTransferRecord; };
function statusClass(status?: string) { if (!status) return 'pending'; if (['completed','kyc_approved','verified','active','RELEASED','RELEASED_TO_SELLER'].includes(status)) return 'success'; if (['failed','cancelled','kyc_rejected','CANCELLED','FAILED'].includes(status)) return 'danger'; return 'pending'; }
function friendlyStatus(status?: string) { const map: Record<string,string> = { created:'Started', kyc_not_started:'Not started', kyc_approved:'Verified', kyc_under_review:'Under review', kyc_incomplete:'Action required', kyc_rejected:'Verification failed', pending:'Pending', approved:'Approved', pending_deposit:'Waiting for USDC', deposit_received:'Deposit received', payout_processing:'Sending to bank', completed:'Completed', failed:'Failed', cancelled:'Cancelled', requires_action:'Action required', verified:'Verified', active:'Active', awaiting_payment:'Awaiting payment', payment_received:'Payment received', processing:'Processing', awaiting_crypto_deposit:'Waiting for your crypto', crypto_received:'Crypto received', settling:'Paying your bank', settled:'Paid to your bank', quote_created:'Quote created', flagged:'Being reviewed', expired:'Expired', PENDING_ACCEPTANCE:'Pending acceptance', PENDING_PAYMENT:'Pending payment', FUNDED:'Funded', IN_PROGRESS:'In progress', RELEASED:'Released', RELEASED_TO_SELLER:'Released' }; return status ? map[status] || status.replaceAll('_',' ') : 'Not started'; }
function Badge({ children, status }: { children: string; status?: string }) { return <span className={`badge ${statusClass(status)}`}>{children}</span>; }
function Empty({ children }: { children: string }) { return <div className="empty-state">{children}</div>; }
function shortRef(value?: string) { if (!value) return '—'; if (value.length <= 14) return value; return `${value.slice(0,8)}…${value.slice(-6)}`; }

export function TransactionsView({ user, api, withdrawals, onrampOrders, ngnTransfers = [], balanceTransfers = [], supplierPayments = [], virtualAccountTransactions = [], walletDeposits = [], serviceAgreements, networkMode, initialSelectedId, onStart, onBuy, onRefresh }: { user: UserRecord | null; api: <T>(path: string, options?: RequestInit) => Promise<T>; withdrawals: WithdrawalRecord[]; onrampOrders: OnrampOrderRecord[]; ngnTransfers?: NgnTransferRecord[]; /** Crypto sends, supplier payouts and virtual-account deposits appeared on NEITHER screen before this - not even under View all. */ balanceTransfers?: BalanceTransferRecord[]; supplierPayments?: SupplierPaymentRecord[]; virtualAccountTransactions?: VirtualAccountTransactionRecord[]; /** Inbound deposits. Were on the DASHBOARD feed but not here - the same divergence this file's own comment warns about, reintroduced when deposits shipped. */ walletDeposits?: WalletDepositRecord[]; serviceAgreements?: ServiceAgreementsSummary; /** Testnet badging on explorer links. Server-stated, never guessed. */ networkMode?: 'mainnet' | 'testnet'; /** Row to open on arrival, set when a dashboard row was clicked. */ initialSelectedId?: string; onStart: () => void; onBuy: () => void; /** Re-reads transfers after a cancel, so the row reflects what the SERVER decided rather than what we hoped. */ onRefresh?: () => Promise<void> }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'in' | 'out' | 'pending' | 'agreements'>('all');
  const feed = useMemo(
    () => buildActivityFeed({ withdrawals, onrampOrders, ngnTransfers, balanceTransfers, supplierPayments, virtualAccountTransactions, walletDeposits }),
    [withdrawals, onrampOrders, ngnTransfers, balanceTransfers, supplierPayments, virtualAccountTransactions, walletDeposits]
  );

  const combinedFeed = useMemo(() => {
    if (!serviceAgreements?.deals || serviceAgreements.deals.length === 0) return feed;
    const dealRows: ActivityRow[] = serviceAgreements.deals.map((d) => ({
      id: d.escrowId,
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
      state: statusClass(d.status) as any,
      createdAt: d.createdAt || new Date().toISOString(),
      raw: d as any
    }));
    const map = new Map<string, ActivityRow>();
    for (const r of [...dealRows, ...feed]) {
      map.set(r.id, r);
    }
    return Array.from(map.values()).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }, [feed, serviceAgreements]);

  /**
   * The detail panel still needs the richer per-source shape (timeline,
   * deposit address, cancellability), so those rows are kept and looked up by
   * id. The FEED decides what exists and in what order; this only decorates.
   */
  const detailRows = useMemo<CustomerTransactionRow[]>(() => {
    const sells = withdrawals.map((w): CustomerTransactionRow => ({
      id: w.id,
      kind: 'withdrawal',
      label: 'Withdrawal',
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
    // NAIRA TRANSFERS ARE A THIRD SOURCE, AND WERE MISSING ENTIRELY.
    //
    // withdrawals and onrampOrders are both Bridge-shaped. A Nigerian selling
    // USDC for naira writes to payments_ngn_transfers and to neither of those,
    // so this page told a user with a live sell and a real Breet deposit
    // address that they had no transactions.
    const naira = ngnTransfers.map((t): CustomerTransactionRow => ({
      id: t.id,
      kind: 'ngn_transfer',
      label: t.direction === 'offramp' ? 'Withdrawal to naira' : 'Buy crypto with naira',
      direction: t.direction === 'offramp' ? 'sell' : 'buy',
      asset: (t.direction === 'offramp' ? t.sourceCurrency : t.destinationCurrency)?.toUpperCase() || 'USDC',
      // Show the leg the user thinks in: naira out for a sell, naira in for a buy.
      amount: (t.direction === 'offramp' ? t.destinationAmount : t.sourceAmount) || '—',
      currency: (t.direction === 'offramp' ? t.destinationCurrency : t.sourceCurrency)?.toUpperCase() || 'NGN',
      status: t.status,
      createdAt: t.createdAt,
      providerReference: t.providerTransferId || t.providerQuoteId,
      // The whole point of an off-ramp that is awaiting funds: without this the
      // user has nowhere to send their crypto.
      depositAddress: t.depositAddress,
      // Server-derived. The chain was always in quoteMetadata.network and
      // never surfaced, so the deposit panel showed an address with no way to
      // tell which network it belonged to.
      network: t.network,
      expiresAt: t.expiresAt,
      cancellable: t.cancellable,
      raw: t
    }));
    return [...sells, ...buys, ...naira];
  }, [withdrawals, onrampOrders, ngnTransfers]);
  const detailById = useMemo(() => new Map(detailRows.map((row) => [row.id, row])), [detailRows]);
  /**
   * Filtering and search live in the shared module too. They were a hand-rolled
   * predicate here that the dashboard had no equivalent of, so "Processing" on
   * one screen and "in progress" on another could mean different sets.
   */
  const filtered = useMemo(() => {
    if (filter === 'agreements') {
      const dealIds = new Set(serviceAgreements?.deals?.map((d) => d.escrowId) || []);
      const matched = combinedFeed.filter((row) => dealIds.has(row.id));
      return searchActivity(matched, query);
    }
    return searchActivity(filterActivity(combinedFeed, filter as any), query);
  }, [combinedFeed, filter, query, serviceAgreements]);
  const [selectedId, setSelectedId] = useState<string>(initialSelectedId ?? '');
  useEffect(() => { if (initialSelectedId) setSelectedId(initialSelectedId); }, [initialSelectedId]);
  const selectedRow: ActivityRow | null = filtered.find((row) => row.id === selectedId) || filtered[0] || null;
  const selected = selectedRow ? detailById.get(selectedRow.id) ?? null : null;

  /**
   * ONE CONVERSATION, SHARED WITH THE SUPPORT DRAWER.
   *
   * This page used to hold a single `assistantAnswer` object rendered into a
   * <pre>: one shot, no follow-up, and a second click silently replaced the
   * first answer. It also duplicated none of the drawer's guards, so the
   * 5-per-chat and 10-per-day limits were simply absent here - a user could
   * ask unlimited questions from Transactions while Support enforced a cap.
   *
   * useAskSivan owns the thread, the limits, the warmup and the error copy, so
   * both surfaces enforce the same rules by construction rather than by two
   * people remembering to.
   *
   * No intro bubble: the drawer greets a user who opened a blank chat, but
   * here the transaction is already on screen and a greeting would just push
   * the answer down.
   */
  const assistant = useAskSivan({ userId: user?.id, hasUser: Boolean(user?.id), api });

  /**
   * Reset the thread when the user selects a DIFFERENT transaction.
   *
   * Without this, answers about the previous row stay on screen under the new
   * one's timeline - the single most misleading thing this panel could do,
   * because every answer names a Request ID the user is no longer looking at.
   */
  useEffect(() => {
    assistant.setMessages([]);
    assistant.setError('');
  }, [selectedRow?.id]);

  async function cancelTransfer(id: string) {
    if (!user) return;
    await api(`/api/users/${user.id}/ngn-transfers/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'Cancelled from the transactions page.' }) });
    await onRefresh?.();
  }

  /**
   * Ask about the row the user is LOOKING AT, whatever kind it is.
   *
   * The old version read `tx.direction` off the detail record, which only
   * exists for withdrawals, buy orders and naira transfers. A deposit, crypto
   * send or supplier payout has no detail row, so the button was absent from
   * that branch entirely - and had it been present it would have asked
   * "Where is my buy order?" about a deposit.
   *
   * Driven by the ACTIVITY row instead, which every kind has, and the question
   * is chosen per kind so the assistant is never asked the wrong one.
   */
  function contextForRow(row: ActivityRow | null): AssistantContext {
    const kind = String(row?.kind ?? 'general');
    const resourceType = (
      kind === 'virtual_account_deposit' ? 'virtual_account_transaction' : kind
    ) as AssistantContext['resourceType'];
    const ticketType: AssistantContext['ticketType'] =
      kind === 'withdrawal' || kind === 'ngn_transfer' ? 'withdrawal'
      : kind === 'onramp_order' ? 'onramp_payment'
      : kind === 'wallet_deposit' || kind === 'virtual_account_deposit' ? 'deposit_not_detected'
      : 'other';
    return { resourceType, resourceId: row?.id, ticketType, subject: `Question about ${row?.label ?? 'a transaction'}` };
  }

  function openingQuestionFor(row: ActivityRow | null): string {
    switch (String(row?.kind)) {
      case 'withdrawal':
      case 'ngn_transfer': return 'What is the status of this withdrawal, and where is the money going?';
      case 'onramp_order': return 'What is the status of this buy order?';
      case 'wallet_deposit':
      case 'virtual_account_deposit': return 'What is the status of this deposit?';
      case 'balance_transfer': return 'What is the status of this crypto send?';
      case 'supplier_payment': return 'What is the status of this supplier payment?';
      default: return 'What is the status of this transaction?';
    }
  }

  function askAboutSelected(question?: string) {
    if (!selectedRow) return;
    void assistant.prewarm();
    void assistant.send(question ?? openingQuestionFor(selectedRow), contextForRow(selectedRow));
  }

  const showAgreementsTab = Boolean(serviceAgreements?.deals && serviceAgreements.deals.length > 0);

  return <section className="app-page transactions-premium"><PageHero title="Transactions" subtitle="Follow every Sivan transaction from request to provider, settlement, bank or blockchain completion." action={<button className="primary-btn small" onClick={() => exportTransactions(filtered)}>Export CSV</button>} /><article className="transactions-table-card transaction-control-card"><div className="transactions-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by request ID, provider reference, amount..." /><div>{(['all','in','out','pending'] as const).map((item) => <button key={item} className={filter === item ? 'primary-btn small' : 'ghost-btn small'} onClick={() => setFilter(item)}>{item === 'all' ? 'All' : item === 'in' ? 'Money in' : item === 'out' ? 'Money out' : 'In progress'}</button>)}{showAgreementsTab && <button className={filter === 'agreements' ? 'primary-btn small' : 'ghost-btn small'} onClick={() => setFilter('agreements')}>Service Agreements ({serviceAgreements?.deals?.length || 0})</button>}</div></div>{!combinedFeed.length ? <div className="dashboard-empty"><p>No transactions yet.</p><div className="button-row"><button className="secondary-btn" onClick={onStart}>Make a withdrawal</button><button className="secondary-btn" onClick={onBuy}>Start buying</button></div></div> : <div className="transaction-ledger-layout"><div className="activity-list activity-list-page">{filtered.map((row) => <ActivityRowItem key={`${row.kind}:${row.id}`} row={row} selected={selectedRow?.id === row.id} onOpen={() => setSelectedId(row.id)} />)}{!filtered.length && <Empty>No transactions match your filter.</Empty>}</div><TransactionTimelinePanel transaction={selected} activityRow={selectedRow} networkMode={networkMode} assistant={assistant} onAsk={askAboutSelected} onCancelTransfer={cancelTransfer} /></div>}</article></section>;
}

/**
 * Human countdown to the moment an unfunded order closes itself.
 *
 * Rounded to whole units and never negative: "-3h left" on a clock that has
 * already run out is worse than saying nothing.
 */
function timeLeft(iso?: string): { text: string; urgent: boolean } | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return undefined;
  if (ms <= 0) return { text: 'Closing now', urgent: true };
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  // Under two hours is where a user genuinely needs to act, so that is where
  // the styling changes rather than at some round number of hours.
  const urgent = hours < 2;
  if (hours >= 1) return { text: `${hours}h ${minutes}m left to send`, urgent };
  return { text: `${minutes}m left to send`, urgent };
}

/**
 * WHERE TO SEND, ON WHICH CHAIN, BY WHEN - AND HOW TO BACK OUT.
 *
 * Reported with a screenshot of a sell showing a bare deposit address:
 * "the network should show here telling the user which network chain they
 * would send to", and "seems like a stale sell".
 *
 * THE NETWORK IS THE DANGEROUS OMISSION. The address in that screenshot,
 * AVXsBHMhRtc5LqoLTvaQBX7oUayS4f3h1TrATUX1v7Df, is Solana - confirmed against
 * the live record, quoteMetadata.network is "solana". Nothing on screen said
 * so. USDC exists on Solana, Base, Ethereum and more; send it on the wrong one
 * and it is gone. There is no recall on chain, and the rail is not watching
 * that network for that address. Asking a user to infer a chain from whether
 * a string starts with 0x is not a design.
 *
 * So the network is stated FIRST, before the address, in the reading order
 * someone follows when they are about to move money - and repeated in the
 * warning underneath, because this is the one mistake that cannot be undone.
 *
 * THE STALENESS is the second half. An unfunded sell had no visible deadline
 * and no way out: it sat looking live until a 24h sweep closed it. Now the
 * deadline is shown, and the user can close it themselves.
 */
function DepositInstruction({ transaction, onCancel }: { transaction: CustomerTransactionRow; onCancel?: (id: string) => Promise<void> | void }) {
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const remaining = timeLeft(transaction.expiresAt);
  const network = transaction.network;

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(transaction.depositAddress!);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked by permissions or an insecure context. The
      // address is selectable text either way.
    }
  };

  return <div className="deposit-instruction">
    <div className="deposit-instruction-head">
      <strong>Send {transaction.asset} to this address</strong>
      {remaining && <span className={`deposit-countdown ${remaining.urgent ? 'urgent' : ''}`}>{remaining.text}</span>}
    </div>

    {/* THE NETWORK, BEFORE THE ADDRESS. A user who has already copied the
        address has stopped reading. */}
    <div className="deposit-network-row">
      <span className="deposit-network-label">Network</span>
      {network
        ? <span className="deposit-network-chip">{network.replaceAll('_', ' ')}</span>
        : <span className="deposit-network-unknown">Not specified - check with support before sending</span>}
    </div>

    <span className="deposit-address-value" title={transaction.depositAddress}>{transaction.depositAddress}</span>

    <div className="deposit-instruction-actions">
      <button className="secondary-btn small" onClick={copy}>{copied ? '✓ Copied' : 'Copy address'}</button>
      {transaction.cancellable && onCancel && (confirming
        ? <>
            <button className="danger-btn small" disabled={cancelling} onClick={async () => {
              setCancelling(true);
              try { await onCancel(transaction.id); } finally { setCancelling(false); setConfirming(false); }
            }}>{cancelling ? 'Cancelling…' : 'Yes, cancel it'}</button>
            <button className="ghost-btn small" disabled={cancelling} onClick={() => setConfirming(false)}>Keep it open</button>
          </>
        // Two-step, because a mis-tap next to "Copy address" would otherwise
        // destroy a live order.
        : <button className="ghost-btn small" onClick={() => setConfirming(true)}>Cancel this withdrawal</button>)}
    </div>

    {network
      ? <small className="deposit-warning">Send only {transaction.asset} on <b>{network.replaceAll('_', ' ')}</b>. Funds sent on any other network cannot be recovered.</small>
      : <small className="deposit-warning">Confirm the network with support before sending. Funds sent on the wrong network cannot be recovered.</small>}
    {remaining && <small className="deposit-note">If nothing arrives by then, this order closes on its own and no funds move. You can start a new one at any time.</small>}
  </div>;
}

/**
 * One sentence explaining what this transaction IS, for rows that have no
 * server-built timeline.
 *
 * Written per kind rather than per status: a user opening a row wants to know
 * what happened to their money, and the status badge beside it already says
 * where it has got to. Deliberately does not promise timing - Sivan does not
 * control when a chain confirms, and a guessed ETA that passes is worse than
 * no ETA at all.
 */
function activitySummaryExplanation(row: ActivityRow): string {
  const network = row.network ? networkLabel(row.network) : 'the network';
  if (row.kind === 'balance_transfer') {
    if (row.state === 'success') return `Sent on ${network}. The recipient has the funds and the transaction is confirmed on chain.`;
    if (row.state === 'failed') return `This send did not go through, and the amount was returned to your balance. Nothing left your wallet.`;
    return `Submitted to ${network} and waiting for confirmation. Your balance already reflects it, and it cannot be reversed once broadcast.`;
  }
  if (row.kind === 'wallet_deposit') {
    if (row.state === 'success') return `Received on ${network} and confirmed. It is part of your spendable balance.`;
    return `We have seen this deposit on ${network} and it is still confirming. You do not need to do anything.`;
  }
  if (row.kind === 'supplier_payment') {
    if (row.state === 'success') return 'Paid to your supplier.';
    if (row.state === 'failed') return 'This supplier payment did not complete. The amount has not left your balance.';
    return 'This supplier payment is being processed. Larger payouts are reviewed by a person before they are released.';
  }
  if (row.kind === 'virtual_account_deposit') {
    return row.state === 'success'
      ? 'This bank deposit has settled into your balance.'
      : 'This bank deposit has arrived and is being settled into your balance.';
  }
  return row.state === 'success' ? 'This transaction is complete.' : 'This transaction is still in progress.';
}

/**
 * The Ask Sivan block that sits under every transaction, whatever its kind.
 *
 * ONE component used by BOTH render branches of the panel below. They diverged
 * before: the timeline branch had the button and the activityRow fallback -
 * which serves deposits, crypto sends and supplier payouts - had only a
 * "share your Request ID" note. Reported from a deposit screenshot as the
 * assistant being missing; it was never rendered on that path.
 */
function AskSivanBlock({ assistant, row, onAsk }: { assistant: ReturnType<typeof useAskSivan>; row: ActivityRow | null; onAsk: (question?: string) => void }) {
  const started = assistant.messages.length > 0;
  const followUps = row ? followUpsFor(String(row.kind), String(row.state)) : [];

  return <div className="support-reference-box ask-sivan-inline">
    <strong>Need support?</strong>
    <span>Ask about this transaction, or share the Request ID with support to have it traced.</span>

    {started && <AssistantThread messages={assistant.messages} busy={assistant.busy} />}

    {/* The opening question, only while there is nothing to follow up on. */}
    {!started && <button className="secondary-btn small" onClick={() => onAsk()} disabled={assistant.busy || assistant.exhausted}>
      {assistant.busy ? 'Sivan Assistant is checking...' : 'Ask Sivan about this transaction'}
    </button>}

    {/* FOLLOW-UPS APPEAR ONLY AFTER AN ANSWER, and only while questions remain.
        Offering them before the first answer would be asking the user to pick
        a follow-up to nothing. */}
    {started && !assistant.exhausted && followUps.length > 0 && <div className="ask-sivan-quick">
      {followUps.map((question) => <button key={question} onClick={() => onAsk(question)} disabled={assistant.busy}>{question}</button>)}
    </div>}

    {/* Free text stays available but SECONDARY - a chip is one tap and cannot
        be phrased into a question the evidence cannot answer. */}
    {started && !assistant.exhausted && <form className="ask-sivan-compose" onSubmit={(event) => { event.preventDefault(); onAsk(assistant.draft); }}>
      <input value={assistant.draft} onChange={(event) => assistant.setDraft(event.target.value)} placeholder="Ask something else about this transaction..." disabled={assistant.busy} />
      <button className="primary-btn small" disabled={assistant.busy || !assistant.draft.trim()}>Send</button>
    </form>}

    {/* THE COUNTER IS SHOWN ONLY ONCE A CONVERSATION EXISTS.
        Displaying "0/10 today" beside an unclicked button advertises a limit
        to someone who has not asked for anything. Once they are talking, it is
        the honest thing - better than hitting a wall mid-conversation. */}
    {started && <div className="ask-sivan-limits">
      <span>{assistant.sessionUsed}/{MAX_SESSION_MESSAGES} this transaction</span>
      <span>{assistant.dailyUsed}/{MAX_DAILY_MESSAGES} today</span>
    </div>}

    {assistant.exhausted && <span className="muted">You have reached the Ask Sivan limit. Create a support ticket from the Support page and the team will follow up.</span>}
    {assistant.error && <div className="form-error">{assistant.error}</div>}
  </div>;
}

function TransactionTimelinePanel({ transaction, activityRow, networkMode, assistant, onAsk, onCancelTransfer }: { transaction: CustomerTransactionRow | null; activityRow?: ActivityRow | null; networkMode?: 'mainnet' | 'testnet'; assistant: ReturnType<typeof useAskSivan>; onAsk: (question?: string) => void; onCancelTransfer?: (id: string) => Promise<void> | void }) {
  // A NAIRA TRANSFER HAS NO BRIDGE TIMELINE, AND MUST NOT FALL THROUGH TO
  // "Select a transaction to see its timeline."
  //
  // For an off-ramp awaiting funds the deposit address IS the transaction:
  // without it on screen the user has nowhere to send their crypto and the
  // sell can never complete. That was the state this page left them in.
  if (!transaction?.timeline && transaction?.kind === 'ngn_transfer') {
    const waiting = transaction.status === 'awaiting_crypto_deposit';
    return <aside className="transaction-timeline-card">
      <div className="timeline-card-head">
        <div><p className="eyebrow">Transaction</p><h3>{transaction.label}</h3>
          <small>{friendlyStatus(transaction.status)}</small></div>
        <Badge status={transaction.status}>{friendlyStatus(transaction.status)}</Badge>
      </div>
      <div className="transaction-explanation-box">
        {waiting
          ? `Send ${transaction.asset} to the address below. Your bank is paid automatically once it arrives.`
          : transaction.status === 'settlement_processing'
            ? 'Your crypto has been received and converted. We are still waiting for bank payout confirmation from the provider.'
            : transaction.status === 'bank_processing'
              ? 'Your bank payout is processing. We will mark this complete after the provider confirms settlement.'
              : `We are processing this ${transaction.direction === 'sell' ? 'withdrawal' : 'buy'}. No action is needed from you.`}
      </div>
      <div className="timeline-meta-grid">
        <Kv label="Request ID" value={transaction.id} />
        <Kv label="Provider reference" value={transaction.providerReference || 'Pending'} />
        <Kv label="You receive" value={`${transaction.amount} ${transaction.currency}`} />
        <Kv label="Asset" value={transaction.asset} />
      </div>
      {transaction.depositAddress && <DepositInstruction transaction={transaction} onCancel={onCancelTransfer} />}
      {/* THE THIRD BRANCH. Naira payouts render here, not through the timeline
          or the activityRow fallback - and this is the panel in the reported
          screenshot, the one whose "Need support?" box had no way to ask
          anything. Found only by reading the rendered DOM: the two branches I
          had already fixed both looked correct in the source. */}
      <AskSivanBlock assistant={assistant} row={activityRow ?? null} onAsk={onAsk} />
    </aside>;
  }
  /**
   * A SELECTED ROW MUST NEVER SHOW "Select a transaction".
   *
   * Reported with two screenshots: a crypto send is clicked, the row takes the
   * green selected border, and the panel still reads "Select a transaction to
   * see its timeline." The naira sell beside it opens a full detail view, so
   * the page looks broken rather than incomplete.
   *
   * Cause: `detailRows` is built from withdrawals, on-ramp orders and naira
   * transfers only. A crypto send, deposit, supplier payout or virtual-account
   * deposit is not in that map, so detailById.get() returned undefined and this
   * line rendered the empty state - the same state as "nothing is selected".
   *
   * Only Bridge-backed flows carry a step-by-step `timeline`, and inventing one
   * for a crypto send would be fabricating steps the server never reported. But
   * the feed row already holds everything that matters for these: amount, asset,
   * network, status, and the transaction hash. So this renders a real summary
   * from what we actually know, and links to the block explorer where the user
   * can verify the send themselves.
   */
  if (!transaction?.timeline && activityRow) {
    const link = explorerLink({
      network: activityRow.network,
      // providerReference carries txHash || userOperationHash for a send, and
      // the tx hash for a deposit. explorerLink returns undefined rather than
      // guessing when it cannot build an honest URL.
      txHash: activityRow.providerReference,
      networkMode,
    });
    const chainMark = logoChainFor(activityRow.network);
    /**
     * Does this transaction happen on a blockchain at all?
     *
     * Three of the seven activity kinds - withdrawals, supplier payouts and
     * virtual-account deposits - move fiat over bank rails. They correctly
     * carry no network, and the panel must not offer them a hash field or
     * promise an explorer link that cannot exist.
     */
    const onChain = Boolean(activityRow.network);
    return <aside className="transaction-timeline-card">
      <div className="timeline-card-head">
        <div>
          <p className="eyebrow">Transaction</p>
          <h3>{activityRow.label}</h3>
          <small>{activityRow.statusLabel}</small>
        </div>
        <Badge status={activityRow.state === 'success' ? 'completed' : activityRow.state === 'failed' ? 'failed' : 'processing'}>{activityRow.statusLabel}</Badge>
      </div>
      <div className="transaction-explanation-box">{activitySummaryExplanation(activityRow)}</div>
      <div className="timeline-meta-grid">
        <Kv label="Request ID" value={activityRow.id} />
        <Kv label="Amount" value={`${activityRow.amount} ${activityRow.currency}`} />
        <Kv label="Asset" value={activityRow.asset ?? activityRow.currency} />
        <Kv label="Network" value={onChain ? networkLabel(activityRow.network) : 'Bank transfer'} />
        <Kv label="When" value={new Date(activityRow.createdAt).toLocaleString()} />
        {/* Only for rows that HAVE a chain. A withdrawal to a bank has no
            transaction hash and never will, so showing "Pending" there implies
            one is on its way. Omitted entirely rather than shown as a dash. */}
        {/* "Pending" only while it genuinely is. A confirmed row with no hash
            is not waiting for one - see the note below the grid. */}
        {onChain && <Kv label="Transaction hash" value={activityRow.providerReference ? shortHash(activityRow.providerReference) : activityRow.state === 'pending' ? 'Pending' : 'Not recorded'} />}
      </div>
      {link
        ? <a className="secondary-btn small explorer-link" href={link.url} target="_blank" rel="noreferrer">
            {chainMark && <NetworkLogo chain={chainMark} size={14} />}
            View on {link.label} ↗
          </a>
        /* No link rather than a guessed one: a 404 reads to the user as
           evidence about their money, not about our URL.
           And the "link is coming" note ONLY for on-chain rows - promising a
           bank payout an explorer link is a promise that can never come true. */
        : onChain && activityRow.state === 'pending'
          ? <small className="deposit-note">A block explorer link appears once the network confirms this transaction.</small>
          /**
           * A CONFIRMED transfer with no hash will never get one.
           *
           * Caught in a rendered screenshot: a deposit reading "Confirmed" also
           * said a link would appear "once the network confirms" - it already
           * had. The poller detects deposits by diffing balances, so it sees
           * that money arrived without ever seeing the transaction, and no
           * amount of waiting produces a hash. Saying so is better than a
           * promise that silently never resolves.
           */
          : onChain
            ? <small className="deposit-note">This was detected from an on-chain balance change, so there is no transaction link for it.</small>
            : null}
      <AskSivanBlock assistant={assistant} row={activityRow} onAsk={onAsk} />
    </aside>;
  }
  if (!transaction?.timeline) return <aside className="transaction-timeline-card"><Empty>Select a transaction to see its timeline.</Empty></aside>;
  const timeline = transaction.timeline;
  /**
   * `steps` IS OPTIONAL AT RUNTIME, WHATEVER THE TYPE SAYS.
   *
   * TransactionTimeline declares `steps: TimelineStep[]`, so every read here
   * typechecked - and the naira rail returns a timeline with no steps at all.
   * `timeline.steps.find(...)` then threw
   *
   *     TypeError: Cannot read properties of undefined (reading 'map')
   *
   * which the error boundary turned into "Something went wrong. Please refresh
   * or try again." on a full black screen, AFTER the withdrawal had already
   * been created. Located by resolving the minified frame
   * index-C-SSW4RJ.js:11:90413 through the sourcemap to this file.
   *
   * A missing step list is a degraded card. A thrown error is a lost deposit
   * address and a user who cannot tell whether their money moved. Defaulting
   * to [] costs nothing and removes the whole class of failure.
   */
  const steps = timeline.steps ?? [];
  const currentStep = steps.find((step) => step.status === 'current') || steps.find((step) => step.status === 'failed') || steps[steps.length - 1];
  return <aside className="transaction-timeline-card"><div className="timeline-card-head"><div><p className="eyebrow">Transaction Timeline</p><h3>{transaction.label}</h3><small>{currentStep?.label || friendlyStatus(timeline.status)}</small></div><Badge status={timeline.status}>{friendlyStatus(timeline.status)}</Badge></div><div className="transaction-explanation-box">{timeline.explanation || transactionExplanation(timeline.transactionType, timeline.status)}</div><div className="timeline-meta-grid"><Kv label="Request ID" value={timeline.requestId} /><Kv label="Internal transaction ID" value={timeline.internalTransactionId} /><Kv label="Provider reference" value={timeline.providerReference || 'Pending'} /><Kv label="Amount" value={`${timeline.amount || transaction.amount} ${timeline.currency || transaction.currency}`} /><Kv label="Currency" value={timeline.currency || transaction.currency} /><Kv label="Asset" value={timeline.asset || transaction.asset} /></div><div className="customer-timeline-list">{steps.map((step, index) => <div className={`customer-timeline-step ${step.status}`} key={step.key}><div className="timeline-rail"><span>{step.status === 'completed' ? '✓' : step.status === 'failed' ? '!' : step.status === 'current' ? '•' : index + 1}</span>{index < steps.length - 1 && <i />}</div><div><strong>{step.label}</strong><time>{step.at ? new Date(step.at).toLocaleTimeString() : step.status === 'pending' ? 'Pending' : 'In progress'}</time><small>{step.description}</small></div></div>)}</div><AskSivanBlock assistant={assistant} row={activityRow ?? null} onAsk={onAsk} /></aside>;
}

export function InlineTransactionTimeline({ timeline }: { timeline: TransactionTimeline }) {
  /**
   * Same guard as the panel above, and this is the one that actually crashed
   * the reported flow: this component renders on the CONFIRM screen, so the
   * throw happened at the exact moment the user pressed the button that
   * creates the withdrawal.
   */
  const steps = timeline?.steps ?? [];
  return <div className="inline-transaction-timeline"><div className="transaction-explanation-box">{timeline.explanation || transactionExplanation(timeline.transactionType, timeline.status)}</div><div className="timeline-meta-grid"><Kv label="Request ID" value={timeline.requestId} /><Kv label="Provider reference" value={timeline.providerReference || 'Pending'} /><Kv label="Amount" value={`${timeline.amount || '—'} ${timeline.currency || ''}`} /><Kv label="Internal transaction ID" value={timeline.internalTransactionId} /></div><div className="customer-timeline-list compact">{steps.map((step, index) => <div className={`customer-timeline-step ${step.status}`} key={step.key}><div className="timeline-rail"><span>{step.status === 'completed' ? '✓' : step.status === 'failed' ? '!' : step.status === 'current' ? '•' : index + 1}</span>{index < steps.length - 1 && <i />}</div><div><strong>{step.label}</strong><time>{step.at ? new Date(step.at).toLocaleTimeString() : step.status === 'pending' ? 'Pending' : 'In progress'}</time><small>{step.description}</small></div></div>)}</div></div>;
}

function transactionExplanation(type: string, status: string) {
  const withdrawal: Record<string, string> = {
    pending_deposit: 'We are waiting for your USDC/USDT to arrive on the selected network.',
    deposit_received: 'Your crypto has arrived. We are preparing your bank payout.',
    blockchain_confirmed: 'Your crypto has arrived on-chain. We are waiting for the provider to confirm conversion.',
    converting: 'Your crypto is being converted into your selected payout currency.',
    settlement_processing: 'Your crypto has been converted. Bank payout confirmation is still pending.',
    bank_processing: 'Your bank payout is processing. We will mark this complete after provider settlement proof arrives.',
    payout_processing: 'We are waiting for the banking partner to confirm your transfer.',
    completed: 'Your bank payout is complete.',
    failed: 'This withdrawal could not be completed. Contact support with your Request ID.',
    requires_action: 'This withdrawal needs additional review. Support may contact you for next steps.',
    requires_review: 'This withdrawal needs support review before it can be marked complete.'
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

/**
 * Exports the FEED, so a download contains every source the screen shows.
 * Previously typed to the three-source row, which meant a CSV could never
 * include a crypto send even once the page listed one.
 */
function exportTransactions(rows: ActivityRow[]) {
  const csv = ['type,direction,requestId,status,amount,currency,asset,network,providerReference,date', ...rows.map((tx) => [tx.kind, tx.direction, tx.id, tx.statusLabel, tx.amount, tx.currency, tx.asset || '', tx.network || '', tx.providerReference || '', tx.createdAt].map(csvCell).join(','))].join('\n');
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
