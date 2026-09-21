import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { UserRecord, WithdrawalRecord, OnrampOrderRecord, TransactionTimeline, NgnTransferRecord, BalanceTransferRecord, SupplierPaymentRecord, VirtualAccountTransactionRecord, WalletDepositRecord, ServiceAgreementsSummary } from '../../types';
import { buildActivityFeed, filterActivity, searchActivity, type ActivityRow } from '../../activityFeed';
import { ActivityRowItem } from '../activity/ActivityRowItem';
import { explorerLink, getNetworkExplorer, networkLabel, shortHash } from '../../blockExplorer';
import { NetworkLogo, logoChainFor } from '../receive/NetworkLogo';
import { useAskSivan, AssistantThread, followUpsFor, MAX_SESSION_MESSAGES, MAX_DAILY_MESSAGES, type AssistantContext } from '../support/askSivan';
import { ConfirmModal } from '../ConfirmModal';

function PageHero({ title, subtitle, action }: { title: string; subtitle: string; action?: React.ReactNode }) { return <div className="page-hero"><div><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>; }
function Kv({ label, value }: { label: string; value?: string | number | null }) { return <div className="kv"><span>{label}</span><strong>{value ?? '—'}</strong></div>; }
type CustomerTransactionRow = { id: string; kind: 'withdrawal' | 'onramp_order' | 'ngn_transfer'; label: string; direction: 'sell' | 'buy'; asset: string; amount: string; currency: string; status: string; createdAt: string; providerReference?: string; timeline?: TransactionTimeline; depositAddress?: string; network?: string; expiresAt?: string; cancellable?: boolean; raw: WithdrawalRecord | OnrampOrderRecord | NgnTransferRecord; };
function statusClass(status?: string) { if (!status) return 'pending'; if (['completed','kyc_approved','verified','active','RELEASED','RELEASED_TO_SELLER','released'].includes(status)) return 'success'; if (['failed','cancelled','kyc_rejected','CANCELLED','FAILED','declined','DECLINED'].includes(status)) return 'danger'; return 'pending'; }
function friendlyStatus(status?: string) { const map: Record<string,string> = { created:'Started', kyc_not_started:'Not started', kyc_approved:'Verified', kyc_under_review:'Under review', kyc_incomplete:'Action required', kyc_rejected:'Verification failed', pending:'Pending', approved:'Approved', pending_deposit:'Waiting for USDC', deposit_received:'Deposit received', payout_processing:'Sending to bank', completed:'Completed', failed:'Failed', cancelled:'Cancelled', requires_action:'Action required', verified:'Verified', active:'Active', awaiting_payment:'Awaiting payment', payment_received:'Payment received', processing:'Processing', awaiting_crypto_deposit:'Waiting for your crypto', crypto_received:'Crypto received', settling:'Paying your bank', settled:'Paid to your bank', quote_created:'Quote created', flagged:'Being reviewed', expired:'Expired', pending_seller_acceptance:'Pending seller acceptance', PENDING_SELLER_ACCEPTANCE:'Pending seller acceptance', PENDING_ACCEPTANCE:'Pending acceptance', pending_acceptance:'Pending acceptance', PENDING_PAYMENT:'Pending payment', pending_payment:'Pending payment', FUNDED:'Funded', funded:'Funded', IN_PROGRESS:'In progress', in_delivery:'In delivery', delivered:'Delivered', DELIVERED:'Delivered', RELEASED:'Released', released:'Released', RELEASED_TO_SELLER:'Released', declined:'Declined', DECLINED:'Declined' }; return status ? map[status] || status.replaceAll('_',' ') : 'Not started'; }
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
    const dealRows: ActivityRow[] = serviceAgreements.deals.map((d) => {
      const stLower = String(d.status || '').toLowerCase();
      const isPendingState = ['funded', 'in_delivery', 'pending_payment', 'pending_seller_acceptance', 'pending_acceptance', 'pending'].includes(stLower);
      const isSuccessState = ['released', 'completed'].includes(stLower);
      const state = isPendingState ? 'pending' : isSuccessState ? 'success' : statusClass(d.status);
      return {
        id: String(d.escrowId || d.id || ''),
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
        state: state as any,
        createdAt: d.createdAt || new Date().toISOString(),
        raw: d as any
      };
    });
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
      const dealIds = new Set(serviceAgreements?.deals?.map((d) => d.escrowId || d.id) || []);
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

  return <section className="app-page transactions-premium"><PageHero title="Transactions" subtitle="Follow every Sivan transaction from request to provider, settlement, bank or blockchain completion." action={<button className="primary-btn small" onClick={() => exportTransactions(filtered)}>Export CSV</button>} /><article className="transactions-table-card transaction-control-card"><div className="transactions-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by request ID, provider reference, amount..." /><div>{(['all','in','out','pending'] as const).map((item) => <button key={item} className={filter === item ? 'primary-btn small' : 'ghost-btn small'} onClick={() => setFilter(item)}>{item === 'all' ? 'All' : item === 'in' ? 'Money in' : item === 'out' ? 'Money out' : 'In progress'}</button>)}<button className={filter === 'agreements' ? 'primary-btn small' : 'ghost-btn small'} onClick={() => setFilter('agreements')}>Service agreements ({serviceAgreements?.deals?.length || 0})</button></div></div>{!combinedFeed.length ? <div className="dashboard-empty"><p>No transactions yet.</p><div className="button-row"><button className="secondary-btn" onClick={onStart}>Make a withdrawal</button><button className="secondary-btn" onClick={onBuy}>Start buying</button></div></div> : <div className="transaction-ledger-layout"><div className="activity-list activity-list-page">{filtered.map((row) => <ActivityRowItem key={`${row.kind}:${row.id}`} row={row} selected={selectedRow?.id === row.id} onOpen={() => setSelectedId(row.id)} />)}{!filtered.length && <Empty>No transactions match your filter.</Empty>}</div><TransactionTimelinePanel transaction={selected} activityRow={selectedRow} networkMode={networkMode} assistant={assistant} onAsk={askAboutSelected} onCancelTransfer={cancelTransfer} api={api} onRefresh={onRefresh} serviceAgreements={serviceAgreements} user={user} /></div>}</article></section>;
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
    if (row.label?.includes('P2P')) {
      return row.direction === 'in'
        ? 'Instant P2P transfer credited directly to your Sivan balance.'
        : 'Instant P2P transfer delivered directly to recipient Sivan balance.';
    }
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
  const stLower = String((row as any).status || row.state || '').toLowerCase();
  if (stLower === 'declined') {
    return 'This service agreement was declined by the contractor. No funds were moved.';
  }
  if (stLower === 'pending_seller_acceptance' || stLower === 'pending_acceptance') {
    return 'Awaiting contractor acceptance. Work and funding proceed once the terms are accepted.';
  }
  if (row.state === 'failed' || (row as any).status === 'cancelled' || stLower === 'cancelled') {
    return 'This transaction was cancelled or did not complete. Funds remain in or were returned to your balance.';
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

function ServiceAgreementActionBox({
  activityRow,
  serviceAgreements,
  api,
  onRefresh,
  networkMode,
  user,
}: {
  activityRow: ActivityRow;
  serviceAgreements?: ServiceAgreementsSummary;
  api?: any;
  onRefresh?: () => void;
  networkMode?: 'mainnet' | 'testnet';
  user?: UserRecord | null;
}) {
  const [loading, setLoading] = useState(false);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [declineModalOpen, setDeclineModalOpen] = useState(false);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const deal = serviceAgreements?.deals?.find((d) => d.escrowId === activityRow.id || d.id === activityRow.id) || (activityRow.raw as any);
  const isSeller = deal?.role === 'seller' || activityRow.direction === 'in';
  const isBuyer = deal?.role === 'buyer' || activityRow.direction === 'out';
  const status = String(deal?.status || activityRow.status || '').toUpperCase();
  const agreementId = deal?.escrowId || deal?.id || activityRow.id;

  const amount = Number(deal?.amountUsdc ?? deal?.amount ?? activityRow.amount ?? 0);
  const currency = String(deal?.currency || activityRow.asset || 'USDC').toUpperCase();
  const feeAmount = Number(deal?.feeAmountUsdc ?? (currency === 'USDC' ? (deal?.feeAmount ?? (amount * 0.01 < 0.5 ? 0.5 : amount * 0.01)) : 0));
  const feePayer = deal?.feePayer || 'buyer';
  const buyerTotal = Number(deal?.buyerTotalPayableUsdc ?? (feePayer === 'buyer' ? amount + feeAmount : feePayer === 'split' ? amount + (feeAmount / 2) : amount));
  const sellerNet = Number(deal?.sellerNetAmountUsdc ?? (feePayer === 'seller' ? Math.max(0, amount - feeAmount) : feePayer === 'split' ? Math.max(0, amount - (feeAmount / 2)) : amount));

  const network = String(deal?.network || activityRow.network || 'solana').toLowerCase();
  const isMainnet = networkMode === 'mainnet';

  const getExplorerTxUrl = (txHash: string) => {
    return getNetworkExplorer(network, txHash, undefined, isMainnet ? 'mainnet' : 'devnet').url;
  };

  const handleAccept = async () => {
    if (!api || !agreementId) return;
    setLoading(true);
    setActionError(null);
    try {
      await api(`/api/agreements/${encodeURIComponent(agreementId)}/accept`, {
        method: 'POST',
        body: JSON.stringify({
          sellerUserId: deal?.sellerUserId || user?.telegramUsername || user?.email || user?.id
        })
      });
      setActionSuccess('Agreement accepted! The client has been notified to fund the vault so work can begin.');
      window.dispatchEvent(new CustomEvent('sivan:agreements:refresh'));
      onRefresh?.();
    } catch (err: any) {
      setActionError(err?.message || 'Failed to accept agreement');
    } finally {
      setLoading(false);
    }
  };

  const executeDecline = async () => {
    if (!api || !agreementId) return;
    setDeclineModalOpen(false);
    setLoading(true);
    setActionError(null);
    try {
      await api(`/api/agreements/${encodeURIComponent(agreementId)}/decline`, {
        method: 'POST',
        body: JSON.stringify({
          sellerUserId: deal?.sellerUserId || user?.telegramUsername || user?.email || user?.id,
          reason: 'Declined by seller from web dashboard'
        })
      });
      setActionSuccess('Agreement declined.');
      window.dispatchEvent(new CustomEvent('sivan:agreements:refresh'));
      onRefresh?.();
    } catch (err: any) {
      setActionError(err?.message || 'Failed to decline agreement');
    } finally {
      setLoading(false);
    }
  };

  const handleDeliver = async () => {
    if (!api || !agreementId) return;
    setLoading(true);
    setActionError(null);
    try {
      await api(`/api/agreements/${encodeURIComponent(agreementId)}/deliver`, { method: 'POST' });
      setActionSuccess('Deliverables submitted! The client has been notified to review and release payment.');
      window.dispatchEvent(new CustomEvent('sivan:agreements:refresh'));
      onRefresh?.();
    } catch (err: any) {
      setActionError(err?.message || 'Failed to mark deliverable as submitted');
    } finally {
      setLoading(false);
    }
  };

  const handleFund = async () => {
    if (!api || !agreementId) return;
    setLoading(true);
    setActionError(null);
    try {
      await api(`/api/agreements/${encodeURIComponent(agreementId)}/fund`, { method: 'POST' });
      setActionSuccess('Agreement funded! Funds are securely locked in the vault.');
      window.dispatchEvent(new CustomEvent('sivan:agreements:refresh'));
      window.dispatchEvent(new CustomEvent('sivan:balances:refresh'));
      onRefresh?.();
    } catch (err: any) {
      setActionError(err?.message || 'Failed to fund agreement');
    } finally {
      setLoading(false);
    }
  };

  const handleRelease = async () => {
    if (!api || !agreementId) return;
    setLoading(true);
    setActionError(null);
    try {
      await api(`/api/agreements/${encodeURIComponent(agreementId)}/release`, { method: 'POST' });
      setActionSuccess('Funds released! Payment has settled directly into the contractor payout balance.');
      window.dispatchEvent(new CustomEvent('sivan:agreements:refresh'));
      window.dispatchEvent(new CustomEvent('sivan:balances:refresh'));
      onRefresh?.();
    } catch (err: any) {
      setActionError(err?.message || 'Failed to release funds');
    } finally {
      setLoading(false);
    }
  };

  const executeCancel = async () => {
    if (!api || !agreementId) return;
    setCancelModalOpen(false);
    setLoading(true);
    setActionError(null);
    try {
      await api(`/api/agreements/${encodeURIComponent(agreementId)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({
          cancelledBy: isBuyer ? 'buyer' : 'seller',
          reason: 'Cancelled from web dashboard'
        })
      });
      setActionSuccess('Agreement cancelled. Held funds refunded to your spendable balance if already funded.');
      window.dispatchEvent(new CustomEvent('sivan:agreements:refresh'));
      window.dispatchEvent(new CustomEvent('sivan:balances:refresh'));
      onRefresh?.();
    } catch (err: any) {
      setActionError(err?.message || 'Failed to cancel agreement');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ marginTop: '14px', padding: '14px', background: 'rgba(255,255,255,0.03)', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <strong style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#94a3b8' }}>
          Your Role: {isBuyer ? 'Client / Buyer' : 'Contractor / Seller'}
        </strong>
        <span style={{ fontSize: '12px', color: '#38bdf8' }}>
          {status === 'FUNDED' ? '🔒 Locked in Vault'
            : status === 'DELIVERED' ? '📦 Deliverables Submitted'
            : status === 'RELEASED' ? '✓ Settlement Complete'
            : status === 'PENDING_PAYMENT' ? '⏳ Awaiting Funding'
            : status === 'PENDING_SELLER_ACCEPTANCE' || status === 'PENDING_ACCEPTANCE' ? '⏳ Pending Seller Acceptance'
            : status === 'DECLINED' ? '✕ Declined'
            : status === 'CANCELLED' ? '✕ Cancelled'
            : status}
        </span>
      </div>

      <div style={{ marginTop: '8px', marginBottom: '12px', padding: '10px 12px', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', textAlign: 'center' }}>
        <div>
          <div style={{ fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase' }}>Milestone</div>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#f8fafc' }}>{amount.toFixed(2)} {currency}</div>
        </div>
        <div>
          <div style={{ fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase' }}>Sivan Fee ({feePayer})</div>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#38bdf8' }}>{feeAmount.toFixed(2)} {currency}</div>
        </div>
        <div>
          <div style={{ fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase' }}>{isBuyer ? 'Total to Pay' : 'Net Settlement'}</div>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#4ade80' }}>{(isBuyer ? buyerTotal : sellerNet).toFixed(2)} {currency}</div>
        </div>
      </div>

      {actionSuccess && (
        <div style={{ padding: '8px 12px', marginBottom: '10px', background: 'rgba(34,197,94,0.15)', border: '1px solid #22c55e', borderRadius: '6px', fontSize: '12px', color: '#4ade80' }}>
          {actionSuccess}
        </div>
      )}

      {actionError && (
        <div style={{ padding: '8px 12px', marginBottom: '10px', background: 'rgba(239,68,68,0.15)', border: '1px solid #ef4444', borderRadius: '6px', fontSize: '12px', color: '#f87171' }}>
          {actionError}
        </div>
      )}

      {/* Seller: Pending Acceptance */}
      {isSeller && (status === 'PENDING_SELLER_ACCEPTANCE' || status === 'PENDING_ACCEPTANCE') && (
        <div>
          <p style={{ fontSize: '12px', color: '#cbd5e1', marginBottom: '10px' }}>
            Agreement proposed by client. Review the milestone terms and accept to proceed to funding, or decline if terms cannot be met.
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="primary-btn small" onClick={handleAccept} disabled={loading} style={{ flex: 2, background: '#16a34a', borderColor: '#16a34a' }}>
              {loading ? 'Processing...' : '✓ Accept Agreement'}
            </button>
            <button className="ghost-btn small" onClick={() => setDeclineModalOpen(true)} disabled={loading} style={{ flex: 1, color: '#f87171' }}>
              ✕ Decline
            </button>
            <button className="ghost-btn small" onClick={() => setCancelModalOpen(true)} disabled={loading} style={{ flex: 1, color: '#94a3b8' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Buyer: Pending Acceptance */}
      {isBuyer && (status === 'PENDING_SELLER_ACCEPTANCE' || status === 'PENDING_ACCEPTANCE') && (
        <div>
          <p style={{ fontSize: '12px', color: '#cbd5e1', marginBottom: '10px' }}>
            Agreement proposal sent. Waiting for contractor to review and accept before funding can proceed.
          </p>
          <button className="ghost-btn small" onClick={() => setCancelModalOpen(true)} disabled={loading} style={{ width: '100%', color: '#f87171' }}>
            ✕ Cancel Agreement
          </button>
        </div>
      )}

      {/* Buyer: Pending Payment / Created */}
      {isBuyer && (status === 'PENDING_PAYMENT' || status === 'CREATED') && (
        <div>
          <p style={{ fontSize: '12px', color: '#cbd5e1', marginBottom: '10px' }}>
            {status === 'PENDING_PAYMENT'
              ? 'Contractor accepted this agreement! Lock funds in the vault to activate the milestone and allow work to begin.'
              : 'This agreement is waiting to be funded. Lock funds in the vault to activate the milestone and allow work to begin.'}
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="primary-btn small" onClick={handleFund} disabled={loading} style={{ flex: 2 }}>
              {loading ? 'Funding Vault...' : '🔒 Fund Agreement & Lock in Vault'}
            </button>
            <button className="ghost-btn small" onClick={() => setCancelModalOpen(true)} disabled={loading} style={{ flex: 1, color: '#f87171' }}>
              ✕ Cancel
            </button>
          </div>
        </div>
      )}

      {/* Seller: Pending Payment / Created */}
      {isSeller && (status === 'PENDING_PAYMENT' || status === 'CREATED') && (
        <div>
          <p style={{ fontSize: '12px', color: '#cbd5e1', marginBottom: '10px' }}>
            Agreement accepted. Waiting for client to fund the vault before delivery begins.
          </p>
          <button className="ghost-btn small" onClick={() => setCancelModalOpen(true)} disabled={loading} style={{ width: '100%', color: '#f87171' }}>
            ✕ Cancel Agreement
          </button>
        </div>
      )}

      {/* Seller: Funded / In Progress */}
      {isSeller && (status === 'FUNDED' || status === 'IN_PROGRESS') && (
        <div>
          <p style={{ fontSize: '12px', color: '#cbd5e1', marginBottom: '10px' }}>
            Work is underway. When complete, submit your deliverables to request milestone payment release.
          </p>
          <button className="primary-btn small" onClick={handleDeliver} disabled={loading} style={{ width: '100%' }}>
            {loading ? 'Submitting...' : '🚀 Submit Deliverables & Request Release'}
          </button>
        </div>
      )}

      {/* Seller: Delivered */}
      {isSeller && status === 'DELIVERED' && (
        <p style={{ fontSize: '12px', color: '#38bdf8', margin: 0 }}>
          ✓ Deliverables submitted. Waiting for the client to review and release vault funds.
        </p>
      )}

      {/* Buyer: Funded / In Progress / Delivered */}
      {isBuyer && (status === 'FUNDED' || status === 'IN_PROGRESS' || status === 'DELIVERED') && (
        <div>
          <p style={{ fontSize: '12px', color: '#cbd5e1', marginBottom: '10px' }}>
            {status === 'DELIVERED'
              ? 'Contractor has submitted deliverables. Review the work and approve to release payment.'
              : 'Funds are securely held in the vault. Release funds upon satisfactory delivery.'}
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="primary-btn small" onClick={handleRelease} disabled={loading} style={{ flex: 2 }}>
              {loading ? 'Releasing...' : '✓ Approve & Release Funds'}
            </button>
            <button className="ghost-btn small" onClick={() => setCancelModalOpen(true)} disabled={loading} style={{ flex: 1, color: '#f87171' }}>
              ✕ Cancel
            </button>
          </div>
        </div>
      )}

      {/* Status: Released */}
      {status === 'RELEASED' && (
        <p style={{ fontSize: '12px', color: '#4ade80', margin: 0 }}>
          ✓ All funds successfully released and settled to contractor.
        </p>
      )}

      {/* Status: Declined */}
      {status === 'DECLINED' && (
        <div style={{ padding: '8px 12px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '6px' }}>
          <p style={{ fontSize: '12px', color: '#f87171', margin: 0 }}>
            ✕ Agreement was declined by contractor.
            {deal?.sellerDeclineReason && <span> Reason: "{deal.sellerDeclineReason}"</span>}
          </p>
        </div>
      )}

      {/* Status: Cancelled */}
      {status === 'CANCELLED' && (
        <p style={{ fontSize: '12px', color: '#94a3b8', margin: 0 }}>
          ✕ Agreement was cancelled and held funds returned to spendable balance.
        </p>
      )}

      {(deal?.fundingTxHash || deal?.releaseTxHash || deal?.feeTxHash || deal?.txHash) && (
        <div style={{ marginTop: '12px', padding: '10px 12px', background: 'rgba(56,189,248,0.06)', borderRadius: '8px', border: '1px solid rgba(56,189,248,0.2)' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#94a3b8', marginBottom: '6px' }}>
            Blockchain Settlement Receipts ({networkLabel(network)})
          </div>
          {deal.fundingTxHash && (
            <a
              href={getExplorerTxUrl(deal.fundingTxHash)}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: '12px', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: '4px', textDecoration: 'none', marginBottom: '4px' }}
            >
              <span>🔒 Vault Funding Receipt</span>
              <span style={{ fontSize: '10px', opacity: 0.8 }}>↗</span>
            </a>
          )}
          {deal.releaseTxHash && (
            <a
              href={getExplorerTxUrl(deal.releaseTxHash)}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: '12px', color: '#4ade80', display: 'flex', alignItems: 'center', gap: '4px', textDecoration: 'none', marginBottom: '4px' }}
            >
              <span>✓ Contractor Settlement Release Receipt</span>
              <span style={{ fontSize: '10px', opacity: 0.8 }}>↗</span>
            </a>
          )}
          {deal.feeTxHash && (
            <a
              href={getExplorerTxUrl(deal.feeTxHash)}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: '12px', color: '#a78bfa', display: 'flex', alignItems: 'center', gap: '4px', textDecoration: 'none' }}
            >
              <span>🧾 Sivan Platform Fee Receipt</span>
              <span style={{ fontSize: '10px', opacity: 0.8 }}>↗</span>
            </a>
          )}
        </div>
      )}

      <ConfirmModal
        open={declineModalOpen}
        title="Decline Service Agreement"
        description="Are you sure you want to decline this service agreement? The client will be notified that you have declined the deal."
        confirmLabel="Yes, Decline Deal"
        isDestructive
        loading={loading}
        onConfirm={executeDecline}
        onCancel={() => setDeclineModalOpen(false)}
      />

      <ConfirmModal
        open={cancelModalOpen}
        title="Cancel Service Agreement"
        description="Are you sure you want to cancel this agreement? Locked funds will return immediately to your spendable balance."
        confirmLabel="Yes, Cancel Agreement"
        isDestructive
        loading={loading}
        onConfirm={executeCancel}
        onCancel={() => setCancelModalOpen(false)}
      />
    </div>
  );
}

function TransactionTimelinePanel({
  transaction,
  activityRow,
  networkMode,
  assistant,
  onAsk,
  onCancelTransfer,
  api,
  onRefresh,
  serviceAgreements,
  user,
}: {
  transaction: CustomerTransactionRow | null;
  activityRow?: ActivityRow | null;
  networkMode?: 'mainnet' | 'testnet';
  assistant: ReturnType<typeof useAskSivan>;
  onAsk: (question?: string) => void;
  onCancelTransfer?: (id: string) => Promise<void> | void;
  api?: any;
  onRefresh?: () => void;
  serviceAgreements?: ServiceAgreementsSummary;
  user?: UserRecord | null;
}) {
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
      <div className="transaction-explanation-box">{transactionExplanation('withdrawal', transaction.status)}</div>
      <div className="timeline-meta-grid">
        <Kv label="Request ID" value={transaction.id} />
        <Kv label="Amount" value={`${transaction.amount} ${transaction.currency}`} />
        <Kv label="Asset" value={transaction.asset} />
        <Kv label="Network" value={networkLabel(transaction.network)} />
        <Kv label="Bank account" value={(transaction as any).recipient || (transaction as any).destinationAccount || '—'} />
        <Kv label="When" value={new Date(transaction.createdAt).toLocaleString()} />
      </div>
      {waiting && <div className="deposit-instructions-box"><p><strong>Deposit Address</strong></p><code className="address-display">{transaction.depositAddress || 'Generating deposit address...'}</code><small className="deposit-note">Send exactly {transaction.amount} {transaction.asset} on {networkLabel(transaction.network)} to complete your off-ramp.</small></div>}
      <AskSivanBlock assistant={assistant} row={activityRow ?? null} onAsk={onAsk} />
    </aside>;
  }
  if (!transaction?.timeline && activityRow) {
    const deal = serviceAgreements?.deals?.find((d) => d.escrowId === activityRow.id || d.id === activityRow.id) || (activityRow.raw as any);
    const isAgreement = activityRow.label.startsWith('Agreement:') || Boolean((activityRow.raw as any)?.escrowId) || Boolean(deal?.escrowId);
    const isP2p = activityRow.kind === 'balance_transfer' && (activityRow.network === 'sivan_p2p' || (activityRow.raw as any)?.network === 'sivan_p2p' || activityRow.label.includes('P2P'));
    const link = explorerLink({
      network: activityRow.network,
      txHash: activityRow.providerReference,
      networkMode,
    });
    const chainMark = logoChainFor(activityRow.network);
    const onChain = Boolean(activityRow.network) && activityRow.network !== 'sivan_p2p';
    return <aside className="transaction-timeline-card">
      <div className="timeline-card-head">
        <div>
          <p className="eyebrow">{isAgreement ? 'Service Agreement' : isP2p ? 'P2P Direct Transfer' : 'Transaction'}</p>
          <h3>{activityRow.label}</h3>
          <small>{activityRow.statusLabel}</small>
        </div>
        <Badge status={activityRow.state === 'success' ? 'completed' : activityRow.state === 'failed' ? 'failed' : 'processing'}>{activityRow.statusLabel}</Badge>
      </div>
      <div className="transaction-explanation-box">{activitySummaryExplanation(activityRow)}</div>
      <div className="timeline-meta-grid">
        <Kv label="Agreement / Request ID" value={activityRow.id} />
        <Kv label="Amount" value={`${activityRow.amount} ${activityRow.currency}`} />
        <Kv label="Asset" value={activityRow.asset ?? activityRow.currency} />
        {(isAgreement || Boolean((activityRow.raw as any)?.channel)) && (
          <Kv
            label="Origin Channel"
            value={
              String(deal?.channel || (activityRow.raw as any)?.channel || 'web').toLowerCase() === 'telegram'
                ? '✈ Telegram'
                : String(deal?.channel || (activityRow.raw as any)?.channel || 'web').toLowerCase() === 'whatsapp'
                  ? '💬 WhatsApp'
                  : String(deal?.channel || (activityRow.raw as any)?.channel || 'web').toLowerCase() === 'webmcp' || String(deal?.channel || (activityRow.raw as any)?.channel || 'web').toLowerCase() === 'agent'
                    ? '✦ Sivan AI / MCP'
                    : '🌐 Web App'
            }
          />
        )}
        <Kv label="Network" value={isP2p ? 'Sivan Instant P2P' : onChain ? networkLabel(deal?.network || activityRow.network || 'celo') : 'Bank transfer'} />
        <Kv label="When" value={new Date(activityRow.createdAt).toLocaleString()} />
        {onChain && (
          <Kv
            label="Settlement proof"
            value={
              activityRow.providerReference
                ? shortHash(activityRow.providerReference)
                : deal?.fundingTxHash
                  ? shortHash(deal.fundingTxHash)
                  : activityRow.state === 'pending' || (deal?.status && deal.status !== 'released' && deal.status !== 'cancelled')
                    ? `Locked in ${networkLabel(deal?.network || activityRow.network || 'celo')} Vault`
                    : 'Confirmed'
            }
          />
        )}
        {isP2p && <Kv label="Settlement proof" value="Instant Internal Ledger" />}
      </div>
      {isAgreement && <ServiceAgreementActionBox activityRow={activityRow} serviceAgreements={serviceAgreements} api={api} onRefresh={onRefresh} networkMode={networkMode} user={user} />}
      {link
        ? <a className="secondary-btn small explorer-link" href={link.url} target="_blank" rel="noreferrer" style={{ marginTop: '10px' }}>
            {chainMark && <NetworkLogo chain={chainMark} size={14} />}
            View on {link.label} ↗
          </a>
        : onChain && activityRow.state === 'pending'
          ? <small className="deposit-note">Settlement secured via non-custodial multi-chain smart agreement vault.</small>
          : onChain
            ? <small className="deposit-note">Settlement confirmed on-chain.</small>
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
