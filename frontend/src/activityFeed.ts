/**
 * STRUCTURAL TYPES, NOT AN IMPORT FROM ./types.
 *
 * The backend test suite imports this module directly, and the backend
 * tsconfig uses moduleResolution node16 - which requires explicit .js
 * extensions. Importing ./types would drag the whole frontend type graph
 * (and its extensionless imports) into that compile and fail it.
 *
 * Declaring only the fields this module reads is also honest about the
 * coupling: the feed depends on a handful of properties, not on the full
 * shape of six records, and a structural type says so.
 */
// No index signature: the frontend's real TransactionTimeline has typed
// members that a Record<string, unknown> intersection rejects. Only the three
// fields this module actually reads are declared.
type Timeline = { amount?: string; currency?: string; providerReference?: string };
interface WithdrawalRecord { id: string; status: string; createdAt: string; sourceCurrency?: string; destinationCurrency?: string; sourceAmount?: string; destinationAmount?: string; providerDrainId?: string; destinationReference?: string; transactionTimeline?: Timeline }
interface OnrampOrderRecord { id: string; status: string; createdAt: string; sourceCurrency?: string; destinationCurrency?: string; amount?: string; providerTransferId?: string; providerReference?: string; transactionTimeline?: Timeline }
interface NgnTransferRecord { id: string; status: string; createdAt: string; direction: string; sourceCurrency?: string; destinationCurrency?: string; sourceAmount?: string; destinationAmount?: string; providerTransferId?: string; providerQuoteId?: string; network?: string }
interface BalanceTransferRecord { transferId: string; status: string; createdAt: string; asset: string; amount: string; network?: string; txHash?: string; userOperationHash?: string }
interface SupplierPaymentRecord { id: string; status: string; createdAt: string; amount: string; sourceAsset?: string; destinationCurrency?: string; providerTransferId?: string; bridgeTransferId?: string; supplier?: { supplierName?: string } | null }
interface VirtualAccountTransactionRecord { id: string; status: string; createdAt: string; sourceCurrency?: string; destinationCurrency?: string; sourceAmount?: string; destinationAmount?: string; depositReference?: string; depositId?: string }
type TransactionTimeline = Timeline;

/**
 * ONE ACTIVITY FEED, ASSEMBLED FROM EVERY WAY MONEY MOVES.
 *
 * Reported: "in my dashboard in the recent transaction i see nothing but in
 * the send and transfer there something there".
 *
 * Measured before writing anything. The frontend already LOADS six money
 * sources in one Promise.allSettled. The dashboard was handed two of them:
 *
 *   App.tsx:1876
 *   <DashboardTransactions withdrawals={withdrawals} onrampOrders={onrampOrders} .../>
 *
 * On the reporter's live account that was 0 rows displayed against 15 real
 * records - 5 crypto sends and 10 naira transfers. And crypto sends, supplier
 * payouts and virtual-account deposits appeared on NEITHER screen, so "View
 * all" did not show them either.
 *
 * WHY A SHARED MODULE AND NOT FOUR MORE PROPS.
 *
 * The obvious fix is to pass the missing four into DashboardTransactions. That
 * produces two independent merge implementations, which is precisely how the
 * current inconsistency happened: TransactionsView grew a naira mapper and the
 * dashboard did not. One merge, two views onto it.
 *
 * NOT A NEW BACKEND ENDPOINT. All six are already in memory on the client. An
 * /api/users/:id/activity would add a round trip and a second place for the
 * merge to live and drift.
 */

/** Every money-movement source the product has. Adding one means adding here. */
export type ActivityKind =
  | 'withdrawal'
  | 'onramp_order'
  | 'ngn_transfer'
  | 'balance_transfer'
  | 'supplier_payment'
  | 'virtual_account_deposit';

/**
 * WHAT THE USER IS ACTUALLY ASKING, which is not "which table is this in".
 *
 *   in       money arriving - a buy, a virtual-account deposit
 *   out      money leaving - a sell, a naira sell, a crypto send, a supplier payout
 *   internal moving between places the user already controls
 *
 * A Nigerian selling USDC for naira and an American selling USDC for USD are
 * the same act to the person doing it, and they live in different tables. The
 * feed groups by direction so the storage detail stays invisible.
 */
export type ActivityDirection = 'in' | 'out' | 'internal';

/** Coarse state, derived once so every screen agrees on the colour. */
export type ActivityState = 'pending' | 'success' | 'failed';

export interface ActivityRow {
  id: string;
  kind: ActivityKind;
  direction: ActivityDirection;
  /** What happened, in the user's words. */
  label: string;
  /** The leg the user thinks in. */
  amount: string;
  currency: string;
  /** What they sent or received, when it differs from `currency`. */
  asset?: string;
  /** Raw provider status, kept so a detail view can still be specific. */
  status: string;
  /** One vocabulary across all six sources - see activityStatusLabel. */
  statusLabel: string;
  state: ActivityState;
  createdAt: string;
  providerReference?: string;
  /** Chain, when the row is an on-chain movement. */
  network?: string;
  timeline?: TransactionTimeline;
  /** The original record, for screens that need more than the summary. */
  raw: unknown;
}

/**
 * ONE STATUS VOCABULARY.
 *
 * There were three separate friendlyStatus maps - in TransactionsSection,
 * DashboardSections and TradeTransferSections - with different keys and
 * different words for the same idea. A naira sell said "Waiting for your
 * crypto", a crypto send "Processing", a buy "Awaiting payment": all meaning
 * IN FLIGHT. Invisible while each list lived on its own screen; glaring the
 * moment they sit in one feed.
 *
 * Grouped by what the user should DO, which is the only thing a status is for:
 *
 *   waiting on them   they must send funds or act
 *   waiting on us     nothing for them to do
 *   done / failed     terminal
 */
const STATUS_LABELS: Record<string, string> = {
  // Waiting on the user.
  awaiting_payment: 'Waiting for your payment',
  pending_deposit: 'Waiting for your crypto',
  awaiting_crypto_deposit: 'Waiting for your crypto',
  awaiting_deposit: 'Waiting for your crypto',
  requires_action: 'Needs your attention',

  // Waiting on us or a provider. Deliberately all the same two words: the
  // difference between "settling" and "bank_processing" is our plumbing, not
  // something the user can act on.
  created: 'In progress',
  quote_created: 'In progress',
  quote_accepted: 'In progress',
  pending: 'In progress',
  approved: 'In progress',
  processing: 'In progress',
  requested: 'In progress',
  payment_received: 'In progress',
  deposit_received: 'In progress',
  crypto_received: 'In progress',
  blockchain_confirmed: 'In progress',
  settlement_processing: 'Paying out',
  bank_processing: 'Paying out',
  settling: 'Paying out',
  payout_processing: 'Paying out',
  crypto_sent: 'Sent',

  // A human is looking. Named, because the user genuinely cannot speed it up.
  pending_review: 'Under review',
  requires_review: 'Under review',
  flagged: 'Under review',

  // Terminal.
  completed: 'Completed',
  settled: 'Completed',
  success: 'Completed',
  failed: 'Failed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  canceled: 'Cancelled',
  expired: 'Expired',
};

const SUCCESS_STATUSES = new Set(['completed', 'settled', 'success', 'crypto_sent']);
const FAILED_STATUSES = new Set(['failed', 'rejected', 'cancelled', 'canceled', 'expired']);

export function activityStatusLabel(status?: string): string {
  if (!status) return 'In progress';
  const key = String(status).toLowerCase();
  // Unknown statuses degrade to a readable form rather than showing a raw
  // snake_case token - a new provider state must never leak machine wording.
  return STATUS_LABELS[key] ?? key.replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function activityState(status?: string): ActivityState {
  const key = String(status ?? '').toLowerCase();
  if (SUCCESS_STATUSES.has(key)) return 'success';
  if (FAILED_STATUSES.has(key)) return 'failed';
  return 'pending';
}

const upper = (value?: string) => (value ? String(value).toUpperCase() : undefined);

export interface ActivitySources {
  withdrawals?: WithdrawalRecord[];
  onrampOrders?: OnrampOrderRecord[];
  ngnTransfers?: NgnTransferRecord[];
  balanceTransfers?: BalanceTransferRecord[];
  supplierPayments?: SupplierPaymentRecord[];
  virtualAccountTransactions?: VirtualAccountTransactionRecord[];
}

/**
 * Merge every source into one time-ordered feed.
 *
 * Every source is optional and defaults to empty: a caller that has not loaded
 * one yet gets fewer rows, never a crash. The dashboard mounts before some of
 * these resolve.
 */
export function buildActivityFeed(sources: ActivitySources): ActivityRow[] {
  const rows: ActivityRow[] = [];

  for (const w of sources.withdrawals ?? []) {
    rows.push({
      id: w.id,
      kind: 'withdrawal',
      direction: 'out',
      label: 'Sell crypto',
      amount: w.destinationAmount || w.sourceAmount || w.transactionTimeline?.amount || '—',
      currency: upper(w.destinationCurrency) || upper(w.transactionTimeline?.currency) || '—',
      asset: upper(w.sourceCurrency) || 'USDC',
      status: w.status,
      statusLabel: activityStatusLabel(w.status),
      state: activityState(w.status),
      createdAt: w.createdAt,
      providerReference: w.transactionTimeline?.providerReference || w.providerDrainId || w.destinationReference,
      timeline: w.transactionTimeline,
      raw: w,
    });
  }

  for (const o of sources.onrampOrders ?? []) {
    rows.push({
      id: o.id,
      kind: 'onramp_order',
      direction: 'in',
      label: 'Buy crypto',
      amount: o.amount || o.transactionTimeline?.amount || '—',
      currency: upper(o.sourceCurrency) || upper(o.transactionTimeline?.currency) || '—',
      asset: upper(o.destinationCurrency) || 'USDC',
      status: o.status,
      statusLabel: activityStatusLabel(o.status),
      state: activityState(o.status),
      createdAt: o.createdAt,
      providerReference: o.transactionTimeline?.providerReference || o.providerTransferId || o.providerReference,
      timeline: o.transactionTimeline,
      raw: o,
    });
  }

  for (const t of sources.ngnTransfers ?? []) {
    const offramp = t.direction === 'offramp';
    rows.push({
      id: t.id,
      kind: 'ngn_transfer',
      // An off-ramp is money leaving even though naira arrives in their bank:
      // the asset the user holds AT SIVAN is what goes down.
      direction: offramp ? 'out' : 'in',
      label: offramp ? 'Sell crypto to naira' : 'Buy crypto with naira',
      amount: (offramp ? t.destinationAmount : t.sourceAmount) || '—',
      currency: upper(offramp ? t.destinationCurrency : t.sourceCurrency) || 'NGN',
      asset: upper(offramp ? t.sourceCurrency : t.destinationCurrency) || 'USDC',
      status: t.status,
      statusLabel: activityStatusLabel(t.status),
      state: activityState(t.status),
      createdAt: t.createdAt,
      providerReference: t.providerTransferId || t.providerQuoteId,
      network: t.network,
      raw: t,
    });
  }

  /**
   * CRYPTO SENDS - on NEITHER screen before this.
   *
   * The reporter's own USDC sends were visible only on the Send & transfer
   * page, which is how the discrepancy was noticed at all.
   *
   * 'internal' rather than 'out': the user is moving their own funds to their
   * own wallet. Calling that an outgoing payment alongside a supplier payout
   * would misdescribe it.
   */
  for (const b of sources.balanceTransfers ?? []) {
    rows.push({
      id: b.transferId,
      kind: 'balance_transfer',
      direction: 'internal',
      label: 'Send crypto',
      amount: b.amount,
      currency: upper(b.asset) || 'USDC',
      asset: upper(b.asset) || 'USDC',
      status: b.status,
      statusLabel: activityStatusLabel(b.status),
      state: activityState(b.status),
      createdAt: b.createdAt,
      providerReference: b.txHash || b.userOperationHash,
      network: b.network,
      raw: b,
    });
  }

  for (const p of sources.supplierPayments ?? []) {
    rows.push({
      id: p.id,
      kind: 'supplier_payment',
      direction: 'out',
      // The supplier's name is the useful label; the id means nothing to them.
      label: p.supplier?.supplierName ? `Pay ${p.supplier.supplierName}` : 'Supplier payout',
      amount: p.amount,
      currency: upper(p.destinationCurrency) || 'USD',
      asset: upper(p.sourceAsset) || 'USDC',
      status: p.status,
      statusLabel: activityStatusLabel(p.status),
      state: activityState(p.status),
      createdAt: p.createdAt,
      providerReference: p.providerTransferId || p.bridgeTransferId,
      raw: p,
    });
  }

  for (const v of sources.virtualAccountTransactions ?? []) {
    rows.push({
      id: v.id,
      kind: 'virtual_account_deposit',
      direction: 'in',
      label: 'Virtual account deposit',
      amount: v.sourceAmount || v.destinationAmount || '—',
      currency: upper(v.sourceCurrency) || '—',
      asset: upper(v.destinationCurrency) || 'USDC',
      status: v.status,
      statusLabel: activityStatusLabel(v.status),
      state: activityState(v.status),
      createdAt: v.createdAt,
      providerReference: v.depositReference || v.depositId,
      raw: v,
    });
  }

  /**
   * Newest first, with a STABLE tiebreak on id.
   *
   * Several sources stamp createdAt from the same request, so equal timestamps
   * are common. Without the tiebreak the order of those rows depends on array
   * order and can shuffle between renders, which reads as the list flickering.
   */
  return rows.sort((a, b) => {
    const byTime = String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
    return byTime !== 0 ? byTime : String(a.id).localeCompare(String(b.id));
  });
}

/** Money in / out / internal, for grouping and filters. */
export function filterActivity(rows: ActivityRow[], filter: 'all' | 'in' | 'out' | 'pending'): ActivityRow[] {
  if (filter === 'all') return rows;
  // 'pending' is deliberately a state filter and not a direction: "what is
  // still moving" is the question people actually open this page to answer.
  if (filter === 'pending') return rows.filter((row) => row.state === 'pending');
  if (filter === 'in') return rows.filter((row) => row.direction === 'in');
  return rows.filter((row) => row.direction === 'out' || row.direction === 'internal');
}

/** Free-text search across the fields a user might actually remember. */
export function searchActivity(rows: ActivityRow[], query: string): ActivityRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) =>
    [row.id, row.label, row.amount, row.currency, row.asset, row.status, row.statusLabel, row.providerReference, row.network]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(needle)
  );
}
