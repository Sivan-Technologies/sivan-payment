import { z } from 'zod';
import { validateAddressForChain, type AddressChain } from '../wallets/address-validation.js';
import { createAuditLog } from '../audit/audit.service.js';
import { db } from '../database/json-database.js';
import { badRequest, forbidden, notFound } from '../shared/errors.js';
import { id, nowIso } from '../shared/id.js';
import { getSpendable } from './unified-balance.service.js';
import { chainFamily } from '../wallets/chain-family.js';
import { getWalletProvider } from '../wallets/provider/provider-registry.js';
import { resolveActiveWalletProvider } from '../wallets/wallet-controls.service.js';

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
export type BalanceLedgerKind = 'credit_pending' | 'credit_available' | 'debit_transfer' | 'hold' | 'hold_release' | 'adjustment';
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

function ledgerLogs() {
  return db.read().then((data) => (data.auditLogs ?? [])
    .filter((log) => log.action === 'balance.ledger_entry')
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
  return {
    transfersEnabled: process.env.BALANCE_TRANSFERS_ENABLED === 'true',
    minimumSendAmount: Number(process.env.BALANCE_TRANSFER_MIN_AMOUNT || 10),
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
    supportedNetworks: ['base', 'solana', 'ethereum'] as BalanceNetwork[],
    updatedBy: 'env',
    reason: 'Environment fallback settings',
    ...(saved ?? {}),
    updatedAt: latest?.createdAt ?? (saved as any)?.updatedAt ?? nowIso(),
  };
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
  return (await ledgerLogs())
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
  const transfer: TransferMetadata = {
    transferId: id('btx'),
    userId,
    asset: input.asset,
    network: input.network,
    amount: money(input.amount),
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
      const executed = await executeBalanceTransfer(userId, transfer);
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
  const wallet = await db.findUserWalletForNetwork(userId, transfer.network);
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

  const provider = getWalletProvider(await resolveActiveWalletProvider());
  const result = await provider.createTransfer({
    providerWalletId: wallet.providerWalletId,
    providerCustomerId: wallet.customerId,
    asset: transfer.asset as any,
    chain: transfer.network as any,
    amount: transfer.amount,
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
    userId, asset: transfer.asset, amount: transfer.amount, kind: 'debit_transfer', status: 'completed',
    sourceType: 'balance_transfer', sourceId: transfer.transferId,
    description: `On-chain transfer submitted to ${transfer.network}`,
    network: transfer.network, destinationAddress: transfer.destinationAddress, transferId: transfer.transferId,
  }, { actorType: 'system', actorId: 'balance_transfer' });

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
