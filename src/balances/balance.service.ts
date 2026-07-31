import { z } from 'zod';
import { createAuditLog } from '../audit/audit.service.js';
import { db } from '../database/json-database.js';
import { badRequest, forbidden, notFound } from '../shared/errors.js';
import { id, nowIso } from '../shared/id.js';

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

async function transferLogs() {
  const data = await db.read();
  return (data.auditLogs ?? [])
    .filter((log) => log.action === 'balance.transfer_requested')
    .map((log) => ({ log, transfer: log.metadata as TransferMetadata }))
    .filter((item) => item.transfer?.transferId);
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
  const balance = await getUserBalance(userId);
  const assetBalance = balance.balances.find((item) => item.asset === input.asset);
  if (amount(assetBalance?.available) < input.amount) throw badRequest('Insufficient settled USDC balance.');
  const now = nowIso();
  const transfer: TransferMetadata = {
    transferId: id('btx'),
    userId,
    asset: input.asset,
    network: input.network,
    amount: money(input.amount),
    destinationAddress: input.destinationAddress,
    status: input.amount >= controls.manualReviewThreshold || controls.riskHoldsEnabled ? 'pending_review' : 'requested',
    note: input.note,
    createdAt: now,
    updatedAt: now,
  };
  await createBalanceLedgerEntry({ userId, asset: input.asset, amount: money(input.amount), kind: 'hold', status: 'held', sourceType: 'balance_transfer', sourceId: transfer.transferId, description: `Hold settled ${input.asset.toUpperCase()} for transfer to ${input.network}`, network: input.network, destinationAddress: input.destinationAddress, transferId: transfer.transferId }, { actorType: 'user', actorId: userId });
  await createAuditLog({ actorType: 'user', actorId: userId, action: 'balance.transfer_requested', resourceType: 'balance_transfer', resourceId: transfer.transferId, ipAddress: context.ipAddress, userAgent: context.userAgent, severity: 'warning', metadata: transfer });
  return transfer;
}

export async function listAllBalanceTransfers() {
  return (await transferLogs()).map((item) => item.transfer).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createAdminBalanceAdjustment(input: z.infer<typeof adminBalanceAdjustmentSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const data = await db.read();
  if (!data.users.some((user) => user.id === input.userId)) throw notFound('User');
  const entry = await createBalanceLedgerEntry({ userId: input.userId, asset: input.asset, amount: money(input.amount), kind: 'adjustment', status: input.status === 'available' ? 'available' : 'pending', sourceType: 'admin_adjustment', sourceId: id('adj'), description: input.reason }, { actorType: 'admin', actorId: input.adjustedBy });
  await createAuditLog({ actorType: 'admin', actorId: input.adjustedBy, action: 'balance.adjustment_created', resourceType: 'balance_ledger_entry', resourceId: entry.entryId, severity: 'warning', ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { ...entry, reason: input.reason } });
  return entry;
}
