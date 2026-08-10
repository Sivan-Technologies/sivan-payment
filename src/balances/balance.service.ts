import { z } from 'zod';
import { validateAddressForChain, type AddressChain } from '../wallets/address-validation.js';
import { createAuditLog } from '../audit/audit.service.js';
import { db } from '../database/json-database.js';
import { badRequest, forbidden, notFound } from '../shared/errors.js';
import { id, nowIso } from '../shared/id.js';
import { getSpendable } from './unified-balance.service.js';
import { chainFamily, walletServesNetwork } from '../wallets/chain-family.js';
import { getWalletProvider } from '../wallets/provider/provider-registry.js';
import { resolveActiveWalletProvider } from '../wallets/wallet-controls.service.js';
import { getAdminFeeSettings } from '../admin/admin-fees.service.js';
import { DEFAULT_TRANSFER_FEE, DEFAULT_TRANSFER_MIN_SEND, quoteTransferFee, type TransferFeeConfig } from './transfer-fee-policy.js';
import { recipientNeedsTokenAccount } from '../wallets/solana/spl-transfer.js';
import { evaluateGasLimits } from './gas-usage.service.js';
import { resolveNetworkMode } from '../wallets/network-mode.js';

export type BalanceAsset = 'usdc' | 'usdt';
/**
 * Networks Sivan knows about.
 *
 * avalanche_c_chain stays in the union deliberately even though it is no longer
 * enabled: historical ledger rows and transfers reference it, and removing the
 * member would make that stored data unreadable. It is excluded from the
 * DEFAULTS instead, which is the switch that actually governs new activity.
 */
export type BalanceNetwork = 'base' | 'solana' | 'avalanche_c_chain' | 'polygon' | 'ethereum' | 'arbitrum' | 'tron';
/**
 * `fee` is Sivan's transfer margin, recorded as its own entry.
 *
 * Not folded into debit_transfer: the fee has to be separable from the amount
 * sent or Sivan's revenue is unmeasurable, and a support agent looking at a
 * transfer needs to see what the user paid us distinctly from what left for
 * the recipient. Same reasoning as the NGN rail, where the provider's cut and
 * Sivan's margin are reported separately so a provider price rise cannot be
 * mistaken for Sivan earning more.
 *
 * It moves money from `held` to `spent`, exactly like debit_transfer - from
 * the user's point of view it left, because it did.
 */
export type BalanceLedgerKind = 'credit_pending' | 'credit_available' | 'debit_transfer' | 'hold' | 'hold_release' | 'adjustment' | 'fee';
export type BalanceTransferStatus = 'requested' | 'pending_review' | 'processing' | 'completed' | 'rejected' | 'failed';

export const balanceTransferControlsSchema = z.object({
  transfersEnabled: z.boolean().default(false),
  minimumSendAmount: z.coerce.number().positive().default(10),
  manualReviewThreshold: z.coerce.number().positive().default(1000),
  riskHoldsEnabled: z.boolean().default(true),
  supportedNetworks: z.array(z.enum(['base', 'solana', 'avalanche_c_chain', 'polygon', 'ethereum', 'arbitrum', 'tron'])).default(['base', 'solana', 'ethereum']),
  updatedBy: z.string().min(2).default('admin_api_key'),
  reason: z.string().max(1000).optional(),
});

export const createBalanceTransferSchema = z.object({
  asset: z.enum(['usdc', 'usdt']).default('usdc'),
  network: z.enum(['base', 'solana', 'avalanche_c_chain', 'polygon', 'ethereum', 'arbitrum']),
  amount: z.coerce.number().positive(),
  destinationAddress: z.string().min(8).max(160),
  note: z.string().max(500).optional(),
});

export const adminBalanceAdjustmentSchema = z.object({
  userId: z.string().min(1),
  asset: z.enum(['usdc', 'usdt']).default('usdc'),
  amount: z.coerce.number(),
  status: z.enum(['pending', 'available']).default('available'),
  reason: z.string().min(5).max(1000),
  adjustedBy: z.string().min(2).default('admin_api_key'),
});

type LedgerMetadata = {
  entryId: string;
  userId: string;
  customerId?: string;
  asset: BalanceAsset;
  amount: string;
  kind: BalanceLedgerKind;
  status: 'pending' | 'available' | 'held' | 'completed' | 'rejected' | 'failed';
  sourceType: string;
  sourceId: string;
  description?: string;
  network?: BalanceNetwork;
  destinationAddress?: string;
  transferId?: string;
};

type TransferMetadata = {
  transferId: string;
  userId: string;
  asset: BalanceAsset;
  network: BalanceNetwork;
  amount: string;
  /**
   * Sivan's fee, DEDUCTED from `amount`. The user's balance falls by `amount`;
   * the recipient receives `netAmount`. Optional because transfers created
   * before the fee existed have neither.
   */
  fee?: string;
  /** What actually reaches the recipient: amount - fee. */
  netAmount?: string;
  /** The one-time recipient-account portion of `fee`, when one applied. */
  newRecipientFee?: string;
  /** True when this transfer created the recipient's token account. */
  createsRecipientAccount?: boolean;
  destinationAddress: string;
  status: BalanceTransferStatus;
  note?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Set once the transfer has actually been broadcast.
   *
   * All optional because a transfer awaiting review has none of them yet, and
   * a SPONSORED transfer has a userOperationHash but no txHash until a bundler
   * includes it on chain. Declaring them properly rather than casting keeps
   * that distinction visible to every consumer.
   */
  providerTransferId?: string;
  txHash?: string;
  userOperationHash?: string;
  sponsored?: boolean;
};

function amount(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function money(value: number) {
  return value.toFixed(6).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

/**
 * ONE INDEXED QUERY, NOT THE WHOLE DATABASE.
 *
 * This was db.read(), which issues ~40 sequential `select *` queries - every
 * table, including the entire audit log - to find rows with a single action.
 *
 * Measured on the deployed test API: GET /api/users/:id/balance/unified took
 * 9.8s, 10.2s, 10.1s. The Cloudflare worker gives up at 12s, so the balance
 * card sat one bad second away from a 503 on every load - and when it lost,
 * the user saw "Could not reach the network / Retrying shortly" while their
 * money was perfectly readable on chain. That is exactly the reported bug, and
 * it explains why it came and went rather than failing consistently.
 *
 * The audit log is the specific problem: it grows without bound, so this got
 * slower every day the platform ran. listAuditLogsByActions filters on action
 * IN THE DATABASE and the ledger read stops scaling with unrelated traffic.
 */
function ledgerLogs(userId?: string) {
  return db.listBalanceLedgerLogs(userId).then((logs) => logs
    .map((log) => ({ log, entry: log.metadata as LedgerMetadata }))
    .filter((item) => item.entry?.entryId));
}

/**
 * Audit actions that carry a transfer's state, oldest meaning first.
 *
 * A transfer is not stored as a row - it is reconstructed from its audit
 * trail. That is fine, but only if EVERY event in the trail is read.
 */
const TRANSFER_EVENTS = [
  'balance.transfer_requested',
  'balance.transfer_requires_operator',
  'balance.transfer_submitted',
  'balance.transfer_failed',
  'balance.transfer_approved',
  'balance.transfer_rejected',
  /**
   * The terminal one, and the one that did not exist.
   *
   * Nothing ever marked a send finished: 'completed' was declared in the
   * status union and only ever assigned to ledger entries. A transfer that
   * settled on chain in seconds still read "Processing" hours later, because
   * the last event anyone wrote was the submission.
   *
   * Listed here as well as emitted, because emitting it and not reading it
   * would be the same bug wearing a new hat - caught by
   * test:transfer-confirmation, which failed on exactly that.
   */
  'balance.transfer_confirmed',
  'balance.transfer_stale',
  /**
   * Written when the broadcast outlived the HTTP response deadline. Carries
   * status 'processing', so a transfer that timed out at the gateway still
   * reads correctly instead of being stuck at whatever the request event said.
   */
  'balance.transfer_slow_broadcast',
] as const;

/**
 * Every transfer, at its LATEST known state.
 *
 * This used to filter on 'balance.transfer_requested' alone, so the status
 * shown was whatever it was at creation and never changed again. Confirmed
 * against the live api-test service: GET /api/admin/balance/transfers reported
 *
 *   {"status":"requested", ...}
 *
 * for a transfer whose audit log, seconds later, recorded
 * balance.transfer_requires_operator with status pending_review. The user's
 * own screen said "requested" while the ledger held the money and no operator
 * queue knew about it.
 *
 * Every subsequent event - submitted, failed, approved, rejected - was written
 * correctly and then read by nobody. Folding them in per transferId, ordered
 * by time, is the whole fix.
 */
async function transferLogs() {
  const data = await db.read();
  const events = (data.auditLogs ?? [])
    .filter((log) => (TRANSFER_EVENTS as readonly string[]).includes(log.action))
    .map((log) => ({ log, transfer: log.metadata as TransferMetadata }))
    .filter((item) => item.transfer?.transferId)
    .sort((a, b) => a.log.createdAt.localeCompare(b.log.createdAt));

  const latest = new Map<string, { log: typeof events[number]['log']; transfer: TransferMetadata }>();
  for (const event of events) {
    const existing = latest.get(event.transfer.transferId);
    latest.set(event.transfer.transferId, {
      // Keep the ORIGINAL log for createdAt - the request time is what a user
      // recognises, not the moment an operator happened to touch it.
      log: existing?.log ?? event.log,
      // Merged, not replaced: a later event may omit fields the first carried.
      transfer: { ...(existing?.transfer ?? {}), ...event.transfer },
    });
  }
  return [...latest.values()];
}

export async function getBalanceTransferControls() {
  const data = await db.read();
  const latest = (data.auditLogs ?? [])
    .filter((log) => log.action === 'balance.transfer_controls.updated')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const saved = (latest?.metadata as any)?.settings as z.infer<typeof balanceTransferControlsSchema> | undefined;
  /**
   * The values below are FALLBACKS. `...(saved ?? {})` at the end of this
   * object overrides every one of them with whatever an admin last saved, so
   * env is only consulted before anyone has touched the controls. Verified by
   * saving a minimum of 42 and reading it back.
   *
   * The minimum send amount now prefers the FEE TAB, because it only makes
   * sense beside the fee curve: it is the thing that stops the fee floor
   * becoming an absurd effective rate on a tiny transfer. Applied after the
   * spread, below, so it wins over the older per-control value - one number,
   * one place to set it.
   */
  const fees = await getAdminFeeSettings().catch(() => undefined);
  return {
    transfersEnabled: process.env.BALANCE_TRANSFERS_ENABLED === 'true',
    manualReviewThreshold: Number(process.env.BALANCE_TRANSFER_MANUAL_REVIEW_THRESHOLD || 1000),
    riskHoldsEnabled: true,
    // Defaults chosen against what BOTH Breet and the wallet layer can service.
    //
    //   solana / ethereum  - work in both directions at Breet, and Privy issues
    //                        keys for both (ed25519 for Solana, secp256k1 EVM)
    //   base               - off-ramp only; Breet publishes no Base withdrawal,
    //                        but the EVM key already covers the address
    //
    // NOT enabled, each for a different reason:
    //
    //   tron              - Breet handles it fine, but Privy's documented chains
    //                       are EVM, Solana, Bitcoin and Stellar. Tron uses its
    //                       own address encoding and account model, so an EVM
    //                       key does not yield a Tron address. Enabling it would
    //                       mean a second wallet provider purely for one chain,
    //                       which defeats having a single wallet layer. Kept in
    //                       the Breet map so it is one line to enable if Privy
    //                       adds support.
    //   avalanche_c_chain - Breet supports AVAX the coin but no USDC or USDT on
    //                       that chain, either direction.
    /**
     * ETHEREUM IS DISABLED FOR TRANSFERS, and this is an economic decision
     * rather than a technical one - the EVM key serves it perfectly well.
     *
     * Sivan sponsors gas. Modelled against real 2026 costs (Solana ~$0.0005,
     * Base ~$0.01, Ethereum L1 ~$3) and the 0.5%/$0.10/$1.00 fee curve:
     *
     *     amount    fee     solana     base     ethereum
     *     $10       $0.10   +0.100     +0.090   -2.900
     *     $100      $0.50   +0.499     +0.490   -2.500
     *     $500      $1.00   +1.000     +0.990   -2.000
     *
     * Ethereum loses money on EVERY transfer at EVERY size, because a $1 cap
     * cannot cover $2-5 of L1 gas. Break-even at 0.5% needs a $600 transfer and
     * the cap prevents ever reaching it. Raising the cap to $5 would make a $10
     * Ethereum send cost half the amount, which is worse than not offering it.
     *
     * Base and Solana serve the identical purpose at roughly 1/300th the cost,
     * and Base is already the default. Re-enable only alongside an
     * Ethereum-specific cap, or when L1 gas makes it viable.
     */
    supportedNetworks: ['base', 'solana'] as BalanceNetwork[],
    updatedBy: 'env',
    reason: 'Environment fallback settings',
    ...(saved ?? {}),
    /**
     * AFTER the spread on purpose.
     *
     * The minimum send amount is set in the fee tab, beside the fee curve it
     * has to agree with, so that value is authoritative when it exists. Placing
     * it before the spread would let a stale per-control value silently win and
     * leave two screens disagreeing about the same number.
     */
    minimumSendAmount:
      fees?.transferMinimumSendAmount ??
      saved?.minimumSendAmount ??
      Number(process.env.BALANCE_TRANSFER_MIN_AMOUNT || DEFAULT_TRANSFER_MIN_SEND),
    updatedAt: latest?.createdAt ?? (saved as any)?.updatedAt ?? nowIso(),
  };
}

/**
 * The fee curve currently in force, from the admin fee tab.
 *
 * Falls back to the defaults if the settings cannot be read, rather than
 * throwing or charging nothing: a fee tab that is briefly unavailable must not
 * silently make every transfer free.
 */
export async function getTransferFeeConfig(): Promise<TransferFeeConfig> {
  const fees = await getAdminFeeSettings().catch(() => undefined);
  return {
    percent: fees?.transferFeePercent ?? DEFAULT_TRANSFER_FEE.percent,
    minimumUsd: fees?.transferFeeMinimumUsd ?? DEFAULT_TRANSFER_FEE.minimumUsd,
    maximumUsd: fees?.transferFeeMaximumUsd ?? DEFAULT_TRANSFER_FEE.maximumUsd,
    newRecipientUsd: fees?.transferFeeNewRecipientUsd ?? DEFAULT_TRANSFER_FEE.newRecipientUsd,
  };
}

/**
 * Price a transfer against the live admin configuration.
 *
 * `createsRecipientAccount` is supplied by the caller because determining it
 * needs an RPC round trip to check whether the recipient already holds the
 * token. The quote ENDPOINT does not know the destination address, so it
 * quotes the base fee and the UI shows the surcharge as conditional; the
 * transfer path resolves it for real before charging.
 */
export async function quoteTransfer(amount: number, options: { createsRecipientAccount?: boolean } = {}) {
  return quoteTransferFee(amount, await getTransferFeeConfig(), options);
}

export async function updateBalanceTransferControls(input: z.infer<typeof balanceTransferControlsSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const current = await getBalanceTransferControls();
  const parsed = balanceTransferControlsSchema.parse(input);
  const next = { ...current, ...parsed, updatedAt: nowIso() };
  await createAuditLog({
    actorType: 'admin',
    actorId: parsed.updatedBy,
    action: 'balance.transfer_controls.updated',
    resourceType: 'balance_transfer_controls',
    resourceId: 'global',
    severity: 'warning',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { previous: current, settings: next, reason: parsed.reason ?? 'Balance transfer controls update' }
  });
  return next;
}

export async function createBalanceLedgerEntry(input: Omit<LedgerMetadata, 'entryId'> & { entryId?: string }, context: { actorType?: 'system' | 'user' | 'admin' | 'provider'; actorId?: string } = {}) {
  const existing = await ledgerLogs();
  if (existing.some((item) => item.entry.sourceType === input.sourceType && item.entry.sourceId === input.sourceId && item.entry.kind === input.kind)) {
    return existing.find((item) => item.entry.sourceType === input.sourceType && item.entry.sourceId === input.sourceId && item.entry.kind === input.kind)!.entry;
  }
  const entry: LedgerMetadata = { ...input, entryId: input.entryId || id('bal') };
  await createAuditLog({
    actorType: context.actorType || 'system',
    actorId: context.actorId,
    action: 'balance.ledger_entry',
    resourceType: 'balance_ledger_entry',
    resourceId: entry.entryId,
    severity: entry.kind === 'adjustment' ? 'warning' : 'info',
    metadata: entry
  });
  return entry;
}

export async function listUserBalanceLedger(userId: string) {
  // userId pushed into the query. The .filter below is kept as a belt-and-
  // braces check on the JSONB match, not as the primary filter.
  return (await ledgerLogs(userId))
    .map((item) => ({ ...item.entry, createdAt: item.log.createdAt }))
    .filter((entry) => entry.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getUserBalance(userId: string) {
  const entries = await listUserBalanceLedger(userId);
  const byAsset: Record<string, { asset: string; pending: number; available: number; held: number; spent: number; totalCredited: number }> = {};
  const ensure = (asset: string) => byAsset[asset] ||= { asset, pending: 0, available: 0, held: 0, spent: 0, totalCredited: 0 };
  for (const entry of entries) {
    const row = ensure(entry.asset);
    const value = amount(entry.amount);
    if (entry.kind === 'credit_pending') row.pending += value;
    if (entry.kind === 'credit_available' || entry.kind === 'adjustment') { row.available += value; row.totalCredited += Math.max(value, 0); }
    if (entry.kind === 'hold') { row.available -= value; row.held += value; }
    if (entry.kind === 'hold_release') { row.available += value; row.held -= value; }
    if (entry.kind === 'debit_transfer') { row.held -= value; row.spent += value; }
    // Identical arithmetic to debit_transfer. The distinction is in the RECORD,
    // not the balance: the user's money is gone either way, but only this entry
    // is Sivan's revenue.
    if (entry.kind === 'fee') { row.held -= value; row.spent += value; }
  }
  return {
    userId,
    balances: Object.values(byAsset).map((row) => ({ ...row, pending: money(row.pending), available: money(Math.max(row.available, 0)), held: money(Math.max(row.held, 0)), spent: money(row.spent), totalCredited: money(row.totalCredited) })),
    ledger: entries,
    updatedAt: nowIso()
  };
}

export async function listUserBalanceTransfers(userId: string) {
  return (await transferLogs())
    .map((item) => ({ ...item.transfer, createdAt: item.transfer.createdAt || item.log.createdAt }))
    .filter((transfer) => transfer.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * How long a send may hold the HTTP response open.
 *
 * MUST stay under the Cloudflare worker's UPSTREAM_TIMEOUT_MS (12000). At or
 * above it the worker aborts first and the user gets a 503 for a transfer that
 * is still running - which is exactly the bug this exists to prevent. 9s
 * leaves room for the reverse proxy and TLS on both hops.
 */
const BROADCAST_RESPONSE_DEADLINE_MS = Number(process.env.BALANCE_TRANSFER_RESPONSE_DEADLINE_MS || 9000);

/** Marker so the caller can tell "still going" apart from "it failed". */
const BROADCAST_PENDING = Symbol('broadcast_pending');

/**
 * Run the broadcast, but answer within the deadline whatever happens.
 *
 * NOTHING IS CANCELLED ON TIMEOUT. There is no way to un-send a signed
 * transaction, and pretending otherwise is how a ledger ends up disagreeing
 * with a chain. The promise keeps running; we simply stop waiting for it.
 *
 * The still-running promise gets its own .then/.catch so that whichever way it
 * finishes is recorded. Without that, a rejection after we have already
 * responded becomes an unhandled rejection and, on some Node versions, takes
 * the process down - killing every other in-flight request.
 */
async function raceBroadcastDeadline(userId: string, transfer: TransferMetadata): Promise<TransferMetadata> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof BROADCAST_PENDING>((resolve) => {
    timer = setTimeout(() => resolve(BROADCAST_PENDING), BROADCAST_RESPONSE_DEADLINE_MS);
    // unref so a pending timer can never hold the process open at shutdown.
    timer.unref?.();
  });

  const broadcast = executeBalanceTransfer(userId, transfer);

  /**
   * Attached BEFORE the race, not after. If the broadcast rejects while we are
   * still waiting, the race rethrows and the caller's catch releases the hold -
   * correct. If it rejects AFTER we have responded, this handler is the only
   * thing standing between us and an unhandled rejection.
   */
  broadcast.catch(async (error) => {
    await createAuditLog({
      actorType: 'system', actorId: 'balance_transfer', action: 'balance.transfer_failed',
      resourceType: 'balance_transfer', resourceId: transfer.transferId, severity: 'error',
      metadata: {
        ...transfer, status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        afterResponse: true,
      },
    }).catch(() => undefined);
    await createBalanceLedgerEntry({
      userId, asset: transfer.asset, amount: transfer.amount, kind: 'hold_release', status: 'available',
      sourceType: 'balance_transfer', sourceId: transfer.transferId,
      description: 'Release hold after the transfer failed once the response had already been sent',
      network: transfer.network, destinationAddress: transfer.destinationAddress, transferId: transfer.transferId,
    }, { actorType: 'system', actorId: 'balance_transfer' }).catch(() => undefined);
  });

  const winner = await Promise.race([broadcast, deadline]);
  if (timer) clearTimeout(timer);

  if (winner !== BROADCAST_PENDING) return winner as TransferMetadata;

  /**
   * The send is still in flight. Report it as SUBMITTED, not failed, and leave
   * the hold in place - the coins are on their way out of the wallet.
   *
   * 'processing' is the same status a completed broadcast writes, so the UI
   * needs no new state: the on-chain receipt shows "Waiting for the network
   * reference" until the signature lands, and the transfer-confirmer promotes
   * it to completed once the chain confirms.
   */
  await createAuditLog({
    actorType: 'system', actorId: 'balance_transfer', action: 'balance.transfer_slow_broadcast',
    resourceType: 'balance_transfer', resourceId: transfer.transferId, severity: 'warning',
    metadata: {
      ...transfer,
      deadlineMs: BROADCAST_RESPONSE_DEADLINE_MS,
      reason: 'The provider had not answered within the response deadline. The broadcast was NOT cancelled.',
    },
  });

  return { ...transfer, status: 'processing', updatedAt: nowIso() };
}

export async function requestBalanceTransfer(userId: string, input: z.infer<typeof createBalanceTransferSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const controls = await getBalanceTransferControls();
  if (!controls.transfersEnabled) throw forbidden('Transfers from settled USDC balance are currently disabled.');
  if (!controls.supportedNetworks.includes(input.network)) throw forbidden(`${input.network} transfers are currently disabled.`);
  if (input.amount < controls.minimumSendAmount) throw badRequest(`Minimum transfer amount is ${controls.minimumSendAmount} ${input.asset.toUpperCase()}.`);

  // THE DESTINATION WAS ONLY LENGTH-CHECKED: z.string().min(8).max(160).
  //
  // That accepted a Solana address for a Base transfer, an EVM address for a
  // Solana transfer, and outright nonsense. Privy signs what it is told to
  // sign, so every one of those broadcasts real funds to an address nobody
  // controls - and on-chain there is no recall.
  //
  // Checked BEFORE the hold is placed, so a rejected address does not leave
  // the user's balance locked behind a transfer that can never settle.
  const addressCheck = validateAddressForChain(input.destinationAddress, input.network as AddressChain);
  if (!addressCheck.valid) throw badRequest(addressCheck.reason ?? 'That destination address is not valid.');
  /**
   * SPENDABLE, NOT "settled ledger available".
   *
   * Reported: "I have balance in the receive wallet now, but not showing in
   * the dashboard or the transfer area." This line was the reason. It asked
   * the LEDGER what the user had, and the ledger is only ever credited by
   * Bridge virtual-account settlements and admin adjustments - verified by
   * grepping every caller of createBalanceLedgerEntry. Crypto that lands in
   * the user's own Privy wallet credits nothing, so their real money was
   * invisible to the one check that decides whether they may spend it.
   *
   * getSpendable() answers from chain + ledger credits - holds. See
   * unified-balance.service.ts for the model.
   *
   * null means the chain could not be read AND the ledger holds nothing. That
   * is "we do not know", and it must refuse: assuming zero blocks a funded
   * user, and assuming plenty signs a transfer that will revert on chain after
   * we have already told them it worked.
   */
  const spendable = await getSpendable(userId, input.asset);
  if (spendable === null) {
    throw badRequest('We could not read your wallet balance just now. Please try again in a moment.');
  }
  if (spendable < input.amount) {
    throw badRequest(`Insufficient ${input.asset.toUpperCase()} balance. You can send up to ${money(spendable)}.`);
  }
  const now = nowIso();
  /**
   * WHEN A HUMAN MUST LOOK.
   *
   * This was `amount >= threshold || riskHoldsEnabled`, and riskHoldsEnabled
   * defaults to TRUE - so the OR made the threshold dead code and EVERY
   * transfer went to manual review regardless of size. A 30 USDC send sat in
   * a queue behind a 1,000 limit that could never apply.
   *
   * riskHoldsEnabled now means what its name says: whether review applies at
   * all. With it on, the threshold decides. With it off, nothing is held.
   */
  const needsReview = controls.riskHoldsEnabled && input.amount >= controls.manualReviewThreshold;

  /**
   * PRICE THE TRANSFER.
   *
   * Sivan sponsors gas on every send and charged nothing for it - there was no
   * fee logic anywhere in this file. The fee is DEDUCTED: the user's balance
   * falls by the full `amount`, and `netAmount` is what reaches the recipient.
   * That matches exchange withdrawal behaviour, which is what a user arriving
   * from Binance already expects, and it means a "send max" can never be
   * rejected for being fee-short of its own balance.
   *
   * Quoted from the admin fee tab, through the one shared policy module, so
   * the number charged here is the same one the confirm dialog showed.
   */
  /**
   * Does this transfer have to create the recipient's token account?
   *
   * Solana only - an EVM transfer has no equivalent cost. Checked here rather
   * than trusted from the client, because the client cannot be allowed to
   * decide whether it pays a surcharge.
   */
  const createsRecipientAccount = input.network === 'solana'
    ? await recipientNeedsTokenAccount({
        recipientAddress: input.destinationAddress,
        asset: input.asset,
        production: resolveNetworkMode() === 'mainnet',
      })
    : false;

  /**
   * GAS LIMITS. Checked BEFORE the hold and before anything is priced.
   *
   * Sivan sponsors the network fee, so an unbounded stream of transfers to
   * fresh addresses is a direct drain on funds nobody has authorised. See
   * gas-policy.ts for why the meaningful limit is NEW RECIPIENTS rather than
   * transfer count.
   *
   * In warn mode the decision is computed and audited but not enforced, which
   * is the intended launch state: these thresholds are guesses until real
   * traffic exists.
   */
  const gasDecision = await evaluateGasLimits({ userId, createsRecipientAccount });
  if (gasDecision.wouldRefuse) {
    await createAuditLog({
      actorType: 'system',
      actorId: 'gas_limits',
      action: gasDecision.allowed ? 'gas.limit_warned' : 'gas.limit_refused',
      resourceType: 'balance_transfer',
      resourceId: userId,
      severity: gasDecision.allowed ? 'warning' : 'error',
      metadata: { userId, rule: gasDecision.rule, tier: gasDecision.tier, ...gasDecision.detail },
    }).catch(() => undefined);
  }
  if (!gasDecision.allowed) {
    throw badRequest(gasDecision.reason ?? 'This transfer exceeds your current daily limit.');
  }

  const quote = await quoteTransfer(input.amount, { createsRecipientAccount });

  const transfer: TransferMetadata = {
    transferId: id('btx'),
    userId,
    asset: input.asset,
    network: input.network,
    amount: money(input.amount),
    fee: quote.fee,
    netAmount: quote.netAmount,
    // Recorded so the ledger, the receipt and support can all tell WHY this
    // transfer cost more than the one before it to the same amount.
    newRecipientFee: quote.newRecipientFee,
    createsRecipientAccount: quote.createsRecipientAccount,
    destinationAddress: input.destinationAddress,
    status: needsReview ? 'pending_review' : 'requested',
    note: input.note,
    createdAt: now,
    updatedAt: now,
  };
  await createBalanceLedgerEntry({ userId, asset: input.asset, amount: money(input.amount), kind: 'hold', status: 'held', sourceType: 'balance_transfer', sourceId: transfer.transferId, description: `Hold settled ${input.asset.toUpperCase()} for transfer to ${input.network}`, network: input.network, destinationAddress: input.destinationAddress, transferId: transfer.transferId }, { actorType: 'user', actorId: userId });
  await createAuditLog({ actorType: 'user', actorId: userId, action: 'balance.transfer_requested', resourceType: 'balance_transfer', resourceId: transfer.transferId, ipAddress: context.ipAddress, userAgent: context.userAgent, severity: 'warning', metadata: transfer });

  /**
   * AND NOW ACTUALLY SEND IT.
   *
   * Before this, requestBalanceTransfer validated, wrote a hold, wrote an
   * audit log and returned. Nothing ever touched a chain. `grep -rn
   * '\.createTransfer('` across src/ returned NOTHING - the Privy adapter that
   * signs, sponsors gas and broadcasts was not reachable from any route in the
   * product. "Send crypto" marked money as spoken for and stopped.
   *
   * Only when no human review is required. A transfer awaiting review must
   * stay held and unsent, or the review is theatre.
   *
   * Failure RELEASES THE HOLD. Leaving it in place would strand the user's
   * funds behind a transfer that never happened and that no queue is watching -
   * silently unspendable money is worse than a visible error.
   */
  if (!needsReview) {
    try {
      /**
       * BROADCAST, BUT NEVER HOLD THE HTTP RESPONSE PAST THE GATEWAY.
       *
       * Reported: "during transfer an error toast would come to the frontend
       * but the transfer still went through".
       *
       * Measured, and it is not a mystery. The Cloudflare worker in front of
       * this API aborts an upstream request at UPSTREAM_TIMEOUT_MS = 12000,
       * and because a POST is not retryable it returns
       *
       *   503 UPSTREAM_UNAVAILABLE ... "it was NOT retried"
       *
       * while the request CONTINUES executing on Render. So the send really
       * did happen; only the answer was thrown away.
       *
       * A Solana send does, sequentially: getSpendable (chain reads across
       * every network the wallet serves), getWallet (a privyRequest whose
       * IN_PROGRESS backoff alone sums to 9.45s), buildSplTransfer (another
       * RPC to check the recipient's token account), then signAndSendTransaction.
       * Comfortably past 12s whenever Privy is slow.
       *
       * So the broadcast is raced against a deadline that is DELIBERATELY
       * under the gateway's. If it wins, the user gets the full result exactly
       * as before. If it loses, the send is NOT cancelled - it keeps running,
       * and the user is told the truth: it is submitted and being confirmed.
       * The transfer-confirmer then moves it to completed once the chain says
       * so.
       *
       * The hold is NOT released on timeout, which is the whole point. The old
       * catch released it and marked the transfer failed, so a send that was
       * about to succeed had its money handed back on paper while the coins
       * left the wallet - the ledger and the chain disagreeing is far worse
       * than a slow response.
       */
      const executed = await raceBroadcastDeadline(userId, transfer);
      return executed;
    } catch (error) {
      await createBalanceLedgerEntry({
        userId, asset: input.asset, amount: money(input.amount), kind: 'hold_release', status: 'available',
        sourceType: 'balance_transfer', sourceId: transfer.transferId,
        description: 'Release hold after the on-chain transfer could not be submitted',
        network: input.network, destinationAddress: input.destinationAddress, transferId: transfer.transferId,
      }, { actorType: 'system', actorId: 'balance_transfer' });
      await createAuditLog({
        actorType: 'system', actorId: 'balance_transfer', action: 'balance.transfer_failed',
        resourceType: 'balance_transfer', resourceId: transfer.transferId, severity: 'error',
        metadata: { ...transfer, status: 'failed', reason: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  return transfer;
}

/**
 * Broadcast a held transfer from the user's own wallet.
 *
 * Separated from requestBalanceTransfer so an admin approving a reviewed
 * transfer runs the SAME code path. Two implementations of "send the money"
 * is how one of them silently rots.
 */
/**
 * Of several wallets that can sign for this network, which one holds the money?
 *
 * Asks each wallet's OWN custodian -- a Bridge wallet is read through Bridge,
 * a Privy wallet through Privy -- because that is the whole point: the two
 * live at different providers.
 *
 * Returns undefined rather than throwing when nothing reports a balance, so
 * the caller keeps its existing choice. A provider outage must not turn a
 * valid transfer into an error; it should fall back to today's behaviour.
 */
async function pickFundedWallet(
  candidates: Awaited<ReturnType<typeof db.listUserWallets>>,
  transfer: { network: string; asset: string; amount: number | string }
) {
  const activeProviderName = await resolveActiveWalletProvider();
  const wanted = String(transfer.asset).toLowerCase();

  const readings = await Promise.all(
    candidates.map(async (row) => {
      try {
        const provider = getWalletProvider(row.provider ?? activeProviderName);
        const balances = await provider.getBalances(
          row.providerWalletId,
          row.customerId,
          row.address,
          transfer.network as any
        );
        const match = (balances ?? []).find(
          (entry: any) => String(entry?.asset ?? '').toLowerCase() === wanted
        );
        const amount = Number(match?.amount ?? 0);
        return { row, amount: Number.isFinite(amount) ? amount : 0 };
      } catch {
        // An unreachable custodian is not evidence of an empty wallet.
        return { row, amount: -1 };
      }
    })
  );

  const usable = readings.filter((entry) => entry.amount > 0);
  if (!usable.length) return undefined;

  // Prefer a wallet that alone covers the send; otherwise the fullest one.
  // TransferMetadata carries amount as a string, so coerce once here.
  const needed = Number(transfer.amount) || 0;
  const covers = usable.filter((entry) => entry.amount >= needed);
  const pool = covers.length ? covers : usable;
  return pool.sort((a, b) => b.amount - a.amount)[0].row;
}

export async function executeBalanceTransfer(userId: string, transfer: TransferMetadata): Promise<TransferMetadata> {
  /**
   * Which wallet signs. base/ethereum and the other EVM chains share one
   * secp256k1 key; Solana needs its ed25519 wallet. Getting this wrong signs
   * against a wallet that does not hold the funds.
   */
  /**
   * WHICH WALLET SIGNS - BY FAMILY, NOT BY LITERAL CHAIN STRING.
   *
   * This was:
   *
   *   const walletChain = transfer.network === 'solana' ? 'solana' : 'ethereum';
   *   const wallet = await db.findUserWallet(userId, walletChain);
   *
   * findUserWallet matches `chain` exactly. Every wallet actually provisioned
   * in this deployment is filed as chain:'base' - both `wallet.created` audit
   * events on api-test read {"chain":"base"} - so a Base send looked for an
   * 'ethereum' row, found none, and fell into the pooled-custody branch below.
   *
   * Reported with a screenshot: a 10 USDC send to Base against a wallet
   * holding 108 USDC, well under the 1,000 review threshold, came back "held"
   * and never moved. The alert was right, the diagnosis in the audit log said
   * "No ethereum wallet - balance is in pooled custody", and both were an
   * artifact of a string comparison. Base and Ethereum are one secp256k1 key
   * at one 0x address; which name the row carries is provisioning trivia.
   */
  /**
   * AND WHEN THE USER HOLDS MORE THAN ONE WALLET ON THAT FAMILY, THE ONE WITH
   * THE MONEY SIGNS.
   *
   * findUserWalletForNetwork returns the OLDEST matching row (`created_at asc`
   * on postgres, insertion order on json). With a single custodian that was
   * always the right row. It stops being right the moment a user holds two:
   * someone who on-ramped through a Bridge virtual account has a Bridge wallet
   * holding the funds AND an older Privy wallet holding nothing, so the send
   * was signed against the empty one and fell into pooled-custody review while
   * their money sat spendable in the other.
   *
   * That combination is now the DEFAULT, because the Bridge -> Privy sweep
   * ships disabled: balances legitimately stay where they landed.
   *
   * Picks the funded wallet, falling back to the original choice when no
   * wallet reports a balance -- a zero-balance send still needs a signer, and
   * a provider that cannot answer must not block the transfer.
   */
  const candidates = (await db.listUserWallets(userId))
    .filter((row) => row.status !== 'closed' && walletServesNetwork(row.chain, transfer.network));

  let wallet = await db.findUserWalletForNetwork(userId, transfer.network);

  if (candidates.length > 1) {
    const funded = await pickFundedWallet(candidates, transfer);
    if (funded) wallet = funded;
  }

  const walletChain = chainFamily(transfer.network) === 'solana' ? 'solana' : 'ethereum';
  if (!wallet) {
    /**
     * NO WALLET IS NOT AN ERROR - IT IS A DIFFERENT CUSTODY STORY.
     *
     * Caught by test:balance-transfer, which passed before this change and
     * failed after: a user funded ENTIRELY by a Bridge virtual-account
     * settlement or an admin adjustment has spendable balance in the ledger
     * and no Privy wallet of their own. Those funds sit in pooled custody and
     * are moved by an operator, not signed for here.
     *
     * Throwing rejected a legitimate transfer AND, because the caller releases
     * the hold on failure, made it look like the request had simply bounced.
     * Left pending_review instead, which is exactly what it needs: a human.
     */
    const queued: TransferMetadata = { ...transfer, status: 'pending_review', updatedAt: nowIso() };
    await createAuditLog({
      actorType: 'system', actorId: 'balance_transfer', action: 'balance.transfer_requires_operator',
      resourceType: 'balance_transfer', resourceId: transfer.transferId, severity: 'warning',
      metadata: { ...queued, reason: `No ${walletChain} wallet - balance is in pooled custody and needs an operator payout.` },
    });
    return queued;
  }

  /**
   * THE WALLET'S OWN PROVIDER, NOT THE ACTIVE ONE.
   *
   * This read resolveActiveWalletProvider(), which is a deployment-wide
   * setting for issuing NEW wallets - it says nothing about who holds THIS
   * wallet. Every existing wallet row records the provider that issued it,
   * precisely because the active provider can change and existing wallets keep
   * their custodian.
   *
   * With one provider in use the two happened to agree, so the bug was
   * invisible. It stops being invisible the moment a user holds a Bridge
   * wallet (virtual-account settlement) while the active provider is Privy:
   * a Bridge wallet id would be handed to Privy, which has never heard of it.
   * At best the send fails; at worst it is attempted against the wrong wallet.
   *
   * Falling back to the active provider only when the row has no provider
   * recorded - old rows predating the column.
   */
  const provider = getWalletProvider(wallet.provider ?? (await resolveActiveWalletProvider()));
  const result = await provider.createTransfer({
    providerWalletId: wallet.providerWalletId,
    providerCustomerId: wallet.customerId,
    asset: transfer.asset as any,
    chain: transfer.network as any,
    /**
     * THE NET, NOT THE GROSS. The fee is deducted, so the chain moves
     * `amount - fee` and Sivan keeps the difference. Sending `transfer.amount`
     * here would move the full sum on chain and leave the fee ledger entry
     * describing money that never stayed - the ledger and the chain
     * disagreeing, which is the failure mode this whole file is careful about.
     *
     * `?? transfer.amount` for transfers created before the fee existed: they
     * have no netAmount and must still send their full amount.
     */
    amount: transfer.netAmount ?? transfer.amount,
    toAddress: transfer.destinationAddress,
    // Derived from the transfer id, so a retry of the SAME transfer cannot
    // double-spend even if this function is called twice.
    idempotencyKey: `btx_${transfer.transferId}`,
    reference: transfer.transferId,
  });

  /**
   * The hold becomes a debit. Not a hold_release - the money left, it was not
   * returned. Getting this backwards would credit the user for funds they no
   * longer have.
   */
  await createBalanceLedgerEntry({
    userId, asset: transfer.asset, amount: transfer.netAmount ?? transfer.amount, kind: 'debit_transfer', status: 'completed',
    sourceType: 'balance_transfer', sourceId: transfer.transferId,
    description: `On-chain transfer submitted to ${transfer.network}`,
    network: transfer.network, destinationAddress: transfer.destinationAddress, transferId: transfer.transferId,
  }, { actorType: 'system', actorId: 'balance_transfer' });

  /**
   * THE FEE, AS ITS OWN ENTRY.
   *
   * Written only after the provider accepted the broadcast, and only when
   * there is one. Charging before the send succeeds would take money for a
   * transfer that then failed - and the catch below releases the WHOLE hold,
   * which would leave the user credited back an amount that no longer matches
   * what was taken.
   *
   * debit_transfer above covers the net; this covers the fee. Together they
   * clear exactly the hold that was placed, so `held` returns to zero. That
   * conservation is asserted in test:transfer-fee-ledger.
   */
  const feeAmount = Number(transfer.fee ?? 0);
  if (feeAmount > 0) {
    await createBalanceLedgerEntry({
      userId, asset: transfer.asset, amount: transfer.fee as string, kind: 'fee', status: 'completed',
      sourceType: 'balance_transfer', sourceId: transfer.transferId,
      /**
       * The description names the surcharge when one applied, so a support
       * agent reading the ledger can answer "why did this transfer cost more
       * than my last one" without recomputing the curve.
       */
      description: Number(transfer.newRecipientFee ?? 0) > 0
        ? `Sivan transfer fee on ${transfer.network} (includes ${transfer.newRecipientFee} one-time recipient account setup)`
        : `Sivan transfer fee on ${transfer.network}`,
      network: transfer.network, destinationAddress: transfer.destinationAddress, transferId: transfer.transferId,
    }, { actorType: 'system', actorId: 'balance_transfer' });
  }

  const sent: TransferMetadata = {
    ...transfer,
    status: 'processing',
    // A SPONSORED transfer is an ERC-4337 user operation: there is no
    // transaction hash until a bundler includes it, so the user-operation hash
    // is the only identifier that exists at this moment.
    providerTransferId: result.providerTransferId,
    txHash: result.txHash,
    userOperationHash: result.userOperationHash,
    sponsored: result.sponsored,
    updatedAt: nowIso(),
  };

  await createAuditLog({
    actorType: 'system', actorId: 'balance_transfer', action: 'balance.transfer_submitted',
    resourceType: 'balance_transfer', resourceId: transfer.transferId, severity: 'info', metadata: sent,
  });

  return sent;
}

export async function listAllBalanceTransfers() {
  return (await transferLogs()).map((item) => item.transfer).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const balanceTransferDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().min(5).max(1000),
  decidedBy: z.string().min(2).default('admin_api_key'),
});

/**
 * RELEASE OR REFUSE A TRANSFER THAT IS WAITING ON A HUMAN.
 *
 * THERE WAS NO WAY TO DO THIS. Grep confirmed it: no approve route, no reject
 * route, no service function, nothing anywhere in src/ that moved a transfer
 * out of pending_review. Every route was GET, POST-create, or controls.
 *
 * So the manual-review threshold was a one-way door. A transfer that crossed
 * it had its funds held on the ledger, permanently, with no mechanism in the
 * product to send it or give it back. On api-test a real 10 USDC hold is
 * sitting in exactly that state right now.
 *
 * That is worse than the threshold not existing. A control that can stop money
 * but cannot then release it is not a control, it is a leak.
 *
 * APPROVE runs the SAME executeBalanceTransfer as an auto-approved send, so
 * there is one implementation of "send the money" and the reviewed path cannot
 * quietly rot away from the unreviewed one.
 *
 * REJECT releases the hold back to the user. Not a debit - the money never
 * left, and recording it as spent would lose it.
 */
export async function decideBalanceTransfer(
  transferId: string,
  input: z.infer<typeof balanceTransferDecisionSchema>,
  context: { ipAddress?: string; userAgent?: string } = {}
) {
  const found = (await transferLogs()).find((item) => item.transfer.transferId === transferId);
  if (!found) throw notFound('Balance transfer');
  const transfer = found.transfer;

  /**
   * Only a transfer actually awaiting review may be decided.
   *
   * Without this, approving an already-submitted transfer would broadcast it a
   * SECOND time and debit the user twice. The provider idempotency key guards
   * the same transfer id, but relying on a downstream vendor for a rule this
   * important is not a guard, it is a hope.
   */
  if (transfer.status !== 'pending_review') {
    throw badRequest(`This transfer is ${transfer.status}, not awaiting review.`);
  }

  if (input.decision === 'reject') {
    await createBalanceLedgerEntry({
      userId: transfer.userId, asset: transfer.asset, amount: transfer.amount,
      kind: 'hold_release', status: 'available',
      sourceType: 'balance_transfer', sourceId: transfer.transferId,
      description: `Hold released after review: ${input.reason}`,
      network: transfer.network, destinationAddress: transfer.destinationAddress,
      transferId: transfer.transferId,
    }, { actorType: 'admin', actorId: input.decidedBy });

    const rejected: TransferMetadata = { ...transfer, status: 'rejected', updatedAt: nowIso() };
    await createAuditLog({
      actorType: 'admin', actorId: input.decidedBy, action: 'balance.transfer_rejected',
      resourceType: 'balance_transfer', resourceId: transfer.transferId, severity: 'warning',
      ipAddress: context.ipAddress, userAgent: context.userAgent,
      metadata: { ...rejected, reason: input.reason },
    });
    return rejected;
  }

  /**
   * The approval is recorded BEFORE the send is attempted.
   *
   * If the broadcast then fails, the trail still shows who approved it and
   * when. Writing it afterwards would lose the decision on exactly the
   * occasions an auditor most wants to see it.
   */
  await createAuditLog({
    actorType: 'admin', actorId: input.decidedBy, action: 'balance.transfer_approved',
    resourceType: 'balance_transfer', resourceId: transfer.transferId, severity: 'warning',
    ipAddress: context.ipAddress, userAgent: context.userAgent,
    metadata: { ...transfer, status: 'requested', reason: input.reason },
  });

  try {
    return await executeBalanceTransfer(transfer.userId, { ...transfer, status: 'requested' });
  } catch (error) {
    // Same release-on-failure rule as the automatic path: a hold behind a
    // transfer that never happened is silently unspendable money.
    await createBalanceLedgerEntry({
      userId: transfer.userId, asset: transfer.asset, amount: transfer.amount,
      kind: 'hold_release', status: 'available',
      sourceType: 'balance_transfer', sourceId: transfer.transferId,
      description: 'Release hold after an approved transfer could not be submitted',
      network: transfer.network, destinationAddress: transfer.destinationAddress,
      transferId: transfer.transferId,
    }, { actorType: 'system', actorId: 'balance_transfer' });
    await createAuditLog({
      actorType: 'system', actorId: 'balance_transfer', action: 'balance.transfer_failed',
      resourceType: 'balance_transfer', resourceId: transfer.transferId, severity: 'error',
      metadata: { ...transfer, status: 'failed', reason: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
}

export async function createAdminBalanceAdjustment(input: z.infer<typeof adminBalanceAdjustmentSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const data = await db.read();
  if (!data.users.some((user) => user.id === input.userId)) throw notFound('User');
  const entry = await createBalanceLedgerEntry({ userId: input.userId, asset: input.asset, amount: money(input.amount), kind: 'adjustment', status: input.status === 'available' ? 'available' : 'pending', sourceType: 'admin_adjustment', sourceId: id('adj'), description: input.reason }, { actorType: 'admin', actorId: input.adjustedBy });
  await createAuditLog({ actorType: 'admin', actorId: input.adjustedBy, action: 'balance.adjustment_created', resourceType: 'balance_ledger_entry', resourceId: entry.entryId, severity: 'warning', ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { ...entry, reason: input.reason } });
  return entry;
}
