import { db } from '../database/json-database.js';
import { getActiveBankingRailName, getBankingRailAdapter, listRegisteredRails } from '../banking-rail/banking-rail-registry.js';
import { getLiveFloatTelemetry } from './admin-float-settings.service.js';
import { getNgnAgreementLedger } from '../ngn/balance-agreements/runtime.js';
import { calculateDvaInflowFee } from '../ngn/fees/dva-inflow-fee.js';
import { adminSyncUserDva } from '../virtual-accounts/service/paystackDvaService.js';
import type { VirtualAccountRecord, VirtualAccountTransactionRecord } from '../virtual-accounts/types/virtual-account.types.js';
import type { NgnTransferRecord } from '../ngn/types/ngn.types.js';

export interface NormalizedNgnVirtualAccount {
  id: string;
  provider: string;
  providerAccountId: string;
  customerId?: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  currency: 'NGN';
  status: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NgnInflowBreakdown {
  bankDepositsNgn: number;
  p2pReceivedNgn: number;
  serviceAgreementPayoutsNgn: number;
  reversalRefundsNgn: number;
  otherInflowNgn: number;
}

export interface NgnOutflowBreakdown {
  bankWithdrawalsNgn: number;
  utilityBillsNgn: number;
  p2pSentNgn: number;
  serviceAgreementSettlementsNgn: number;
  platformFeesNgn: number;
  otherOutflowNgn: number;
}

export interface NgnLedgerProof {
  expectedEquityNgn: number;
  actualEquityNgn: number;
  discrepancyNgn: number;
  balanced: boolean;
}

export interface AdminNgnUserRow {
  userId: string;
  aliases: string[];
  fullName: string;
  username?: string;
  email?: string;
  whatsappNumber?: string;
  kycStatus: string;
  availableNgn: number;
  heldNgn: number;
  agreementHeldNgn: number;
  totalEquityNgn: number;
  totalInflowNgn: number;
  inflowCount: number;
  totalOutflowNgn: number;
  outflowCount: number;
  totalFeesPaidNgn: number;
  netFlowNgn: number;
  directOfframpVolumeNgn: number;
  directOfframpCount: number;
  totalNgnFootprintNgn: number;
  inflowBreakdown: NgnInflowBreakdown;
  outflowBreakdown: NgnOutflowBreakdown;
  ledgerProof: NgnLedgerProof;
  lastActivityAt: string | null;
  virtualAccount: NormalizedNgnVirtualAccount | null;
  virtualAccounts: NormalizedNgnVirtualAccount[];
}

export interface AdminNgnStatementEntry {
  entryId: string;
  createdAt: string;
  direction: 'INFLOW' | 'OUTFLOW' | 'HOLD' | 'RELEASE';
  flowCategory:
    | 'bank_deposit'
    | 'bank_withdrawal'
    | 'p2p_receive'
    | 'p2p_send'
    | 'service_agreement_lock'
    | 'service_agreement_release'
    | 'service_agreement_refund'
    | 'utility_purchase'
    | 'reversal_refund'
    | 'platform_fee'
    | 'admin_adjustment'
    | 'other';
  categoryLabel: string;
  kind: string;
  amountNgn: number;
  grossAmountNgn: number;
  feeNgn: number;
  availableBeforeNgn: number;
  availableAfterNgn: number;
  heldBeforeNgn: number;
  heldAfterNgn: number;
  provider: string;
  reference: string;
  counterparty?: string;
  status: string;
  description: string;
}

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

function cleanText(text?: string): string {
  if (!text) return '';
  return String(text).replace(/\u2014/g, '.').replace(/—/g, '.').trim();
}

function normalizePhoneDigits(raw?: string): string {
  if (!raw) return '';
  const cleaned = String(raw).replace(/^whatsapp:/i, '').trim();
  const digits = cleaned.replace(/\D/g, '');
  return digits.length >= 10 ? digits : '';
}

function extractNormalizedVirtualAccount(acc: VirtualAccountRecord): NormalizedNgnVirtualAccount | null {
  const isNgn =
    String(acc.currency || '').toLowerCase() === 'ngn' ||
    ['paystack', 'mono', 'flutterwave', 'nomba', 'kora', 'anchor'].includes(String(acc.provider || '').toLowerCase());
  if (!isNgn) return null;

  const raw = (acc.rawProviderPayload ?? {}) as Record<string, any>;
  const accountNumber = String(
    raw.account_number ||
    raw.accountNumber ||
    acc.accountNumberMasked ||
    ''
  ).trim();
  const bankName = String(
    acc.bankName ||
    raw.bank?.name ||
    raw.bank_name ||
    raw.bankName ||
    'NGN Partner Bank'
  ).trim();
  const accountName = String(
    acc.accountName ||
    raw.account_name ||
    raw.accountName ||
    ''
  ).trim();

  const status = String(acc.status || 'pending').toLowerCase();
  const active = status === 'active' || (Boolean(accountNumber) && status !== 'rejected' && status !== 'closed');

  return {
    id: acc.id,
    provider: String(acc.provider || getActiveBankingRailName()).toLowerCase(),
    providerAccountId: String(acc.providerAccountId || acc.id),
    customerId: acc.customerId,
    bankName,
    accountNumber,
    accountName,
    currency: 'NGN',
    status,
    active,
    createdAt: acc.createdAt,
    updatedAt: acc.updatedAt,
  };
}

function resolveEntryProvider(
  entry: Record<string, any>,
  actorId?: string,
  vaTx?: VirtualAccountTransactionRecord,
  ngnTx?: NgnTransferRecord,
  defaultRail = 'paystack'
): string {
  if (vaTx?.provider) return String(vaTx.provider).toLowerCase();
  if (ngnTx?.provider) return String(ngnTx.provider).toLowerCase();
  if (actorId && !['system', 'user', 'admin', 'admin_api_key', 'balance_transfer'].includes(actorId)) {
    return String(actorId).toLowerCase();
  }
  const srcType = String(entry.sourceType || '').toLowerCase();
  const desc = String(entry.description || '').toLowerCase();
  if (desc.includes('paystack')) return 'paystack';
  if (desc.includes('mono')) return 'mono';
  if (desc.includes('nomba')) return 'nomba';
  if (desc.includes('flutterwave')) return 'flutterwave';
  if (desc.includes('breet')) return 'breet';
  if (srcType.includes('p2p')) return 'sivan_p2p';
  if (srcType.includes('agreement') || desc.includes('agreement')) return 'service_agreement';
  if (srcType.includes('utility') || srcType.includes('airtime') || srcType.includes('data') || srcType.includes('electricity')) {
    return 'utility_rail';
  }
  if (srcType === 'virtual_account_transaction' || srcType === 'ngn_cashout' || srcType === 'ngn_bank_transfer') {
    return defaultRail;
  }
  return 'sivan_ledger';
}

function classifyLedgerEntry(
  entry: Record<string, any>,
  vaTx?: VirtualAccountTransactionRecord,
  ngnTx?: NgnTransferRecord
): {
  direction: AdminNgnStatementEntry['direction'];
  flowCategory: AdminNgnStatementEntry['flowCategory'];
  categoryLabel: string;
  counterparty?: string;
  grossAmountNgn: number;
  feeNgn: number;
} {
  const kind = String(entry.kind || '');
  const srcType = String(entry.sourceType || '').toLowerCase();
  const desc = String(entry.description || '');
  const descLower = desc.toLowerCase();
  const amountVal = round2(Math.abs(Number(entry.amount ?? 0)));

  let grossAmountNgn = amountVal;
  let feeNgn = 0;
  let counterparty: string | undefined;

  if (vaTx) {
    const srcAmt = Number(vaTx.sourceAmount ?? 0);
    const dstAmt = Number(vaTx.destinationAmount ?? 0);
    if (srcAmt > 0) {
      grossAmountNgn = round2(srcAmt);
      feeNgn = dstAmt > 0 && srcAmt >= dstAmt ? round2(srcAmt - dstAmt) : round2(calculateDvaInflowFee(srcAmt).feeNgn);
    }
    const raw = (vaTx.rawPayload ?? {}) as Record<string, any>;
    const senderName = raw.authorization?.sender_name || raw.sender_name;
    const senderBank = raw.authorization?.sender_bank || raw.sender_bank;
    if (senderName || senderBank) {
      counterparty = [senderName, senderBank].filter(Boolean).join(' • ');
    }
  } else {
    const grossMatch = desc.match(/gross\s+([\d.,]+)\s*NGN/i);
    const feeMatch = desc.match(/fee\s+([\d.,]+)\s*NGN/i);
    if (grossMatch) grossAmountNgn = round2(Number(grossMatch[1].replace(/,/g, '')));
    if (feeMatch) feeNgn = round2(Number(feeMatch[1].replace(/,/g, '')));
  }

  if (ngnTx) {
    const meta = (ngnTx.metadata ?? {}) as Record<string, any>;
    const rawTx = ngnTx as Record<string, any>;
    const bankName = rawTx.bankName || meta.bankName;
    const accountName = rawTx.accountName || meta.accountName;
    const accountNumber = rawTx.accountNumber || meta.accountNumber;
    if (accountName || bankName || accountNumber) {
      counterparty = [accountName, bankName, accountNumber].filter(Boolean).join(' • ');
    }
    if (meta.feeNgn && !feeNgn) {
      feeNgn = round2(Number(meta.feeNgn));
    }
  }

  if (kind === 'credit_available' || kind === 'credit_pending') {
    if (srcType === 'virtual_account_transaction' || descLower.includes('dva') || descLower.includes('deposit')) {
      return {
        direction: 'INFLOW',
        flowCategory: 'bank_deposit',
        categoryLabel: 'Bank Deposit (Virtual Account)',
        counterparty,
        grossAmountNgn,
        feeNgn,
      };
    }
    if (srcType.includes('p2p') || descLower.includes('p2p')) {
      return {
        direction: 'INFLOW',
        flowCategory: 'p2p_receive',
        categoryLabel: 'P2P Transfer In',
        counterparty: entry.destinationAddress || counterparty,
        grossAmountNgn: amountVal,
        feeNgn: 0,
      };
    }
    if (srcType.includes('agreement') || descLower.includes('agreement') || descLower.includes('release')) {
      return {
        direction: 'INFLOW',
        flowCategory: 'service_agreement_release',
        categoryLabel: 'Service Agreement Payout',
        counterparty,
        grossAmountNgn: amountVal,
        feeNgn: 0,
      };
    }
    if (descLower.includes('reversal') || descLower.includes('refund')) {
      return {
        direction: 'INFLOW',
        flowCategory: 'reversal_refund',
        categoryLabel: 'Transfer Reversal / Refund',
        counterparty,
        grossAmountNgn: amountVal,
        feeNgn: 0,
      };
    }
    return {
      direction: 'INFLOW',
      flowCategory: 'other',
      categoryLabel: 'NGN Credit Inflow',
      counterparty,
      grossAmountNgn,
      feeNgn,
    };
  }

  if (kind === 'adjustment') {
    const signed = Number(entry.amount ?? 0);
    return {
      direction: signed >= 0 ? 'INFLOW' : 'OUTFLOW',
      flowCategory: 'admin_adjustment',
      categoryLabel: signed >= 0 ? 'Admin Credit Adjustment' : 'Admin Debit Adjustment',
      counterparty: 'Admin Treasury',
      grossAmountNgn: amountVal,
      feeNgn: 0,
    };
  }

  if (kind === 'hold') {
    if (srcType.includes('agreement') || descLower.includes('agreement')) {
      return {
        direction: 'HOLD',
        flowCategory: 'service_agreement_lock',
        categoryLabel: 'Service Agreement Lock (Hold)',
        counterparty: entry.sourceId,
        grossAmountNgn: amountVal,
        feeNgn: 0,
      };
    }
    return {
      direction: 'HOLD',
      flowCategory: 'bank_withdrawal',
      categoryLabel: 'Payout / Spend Hold',
      counterparty,
      grossAmountNgn: amountVal,
      feeNgn,
    };
  }

  if (kind === 'hold_release') {
    if (srcType.includes('agreement') || descLower.includes('agreement')) {
      return {
        direction: 'RELEASE',
        flowCategory: 'service_agreement_refund',
        categoryLabel: 'Service Agreement Hold Released',
        counterparty: entry.sourceId,
        grossAmountNgn: amountVal,
        feeNgn: 0,
      };
    }
    return {
      direction: 'RELEASE',
      flowCategory: 'reversal_refund',
      categoryLabel: 'Hold Released (Reversed / Cancelled)',
      counterparty,
      grossAmountNgn: amountVal,
      feeNgn: 0,
    };
  }

  if (kind === 'fee') {
    return {
      direction: 'OUTFLOW',
      flowCategory: 'platform_fee',
      categoryLabel: 'Platform Transfer / Service Fee',
      counterparty: 'Sivan Treasury',
      grossAmountNgn: amountVal,
      feeNgn: amountVal,
    };
  }

  // debit_transfer
  if (
    srcType.includes('utility') ||
    srcType.includes('airtime') ||
    srcType.includes('data') ||
    srcType.includes('electricity') ||
    srcType.includes('cable') ||
    descLower.includes('airtime') ||
    descLower.includes('data') ||
    descLower.includes('electricity') ||
    descLower.includes('meter')
  ) {
    return {
      direction: 'OUTFLOW',
      flowCategory: 'utility_purchase',
      categoryLabel: 'Utility / Bill Payment',
      counterparty: entry.destinationAddress || counterparty,
      grossAmountNgn: amountVal,
      feeNgn,
    };
  }

  if (srcType.includes('p2p') || descLower.includes('p2p')) {
    return {
      direction: 'OUTFLOW',
      flowCategory: 'p2p_send',
      categoryLabel: 'P2P Transfer Out',
      counterparty: entry.destinationAddress || counterparty,
      grossAmountNgn: amountVal,
      feeNgn,
    };
  }

  if (srcType.includes('agreement') || descLower.includes('agreement')) {
    return {
      direction: 'OUTFLOW',
      flowCategory: 'service_agreement_lock',
      categoryLabel: 'Service Agreement Settlement',
      counterparty: entry.sourceId,
      grossAmountNgn: amountVal,
      feeNgn,
    };
  }

  return {
    direction: 'OUTFLOW',
    flowCategory: 'bank_withdrawal',
    categoryLabel: 'Bank Withdrawal (NIP Payout)',
    counterparty: entry.destinationAddress || counterparty,
    grossAmountNgn: amountVal,
    feeNgn,
  };
}

/**
 * Builds canonical user identity map so entries under `whatsapp:+234...`, `+234...`,
 * or `usr_...` unify cleanly under one user profile.
 */
async function loadCanonicalUserResolver() {
  const [adminUsersRaw, identityLinks, virtualAccounts, vaTransactions, ngnTransfers, ledgerLogs] = await Promise.all([
    db.listAdminUsersView({ limit: 2000, offset: 0 }).catch(() => []),
    db.listCustomerIdentityLinks().catch(() => []),
    db.listVirtualAccounts().catch(() => []),
    db.listVirtualAccountTransactions().catch(() => []),
    db.listNgnTransfers().catch(() => []),
    db.listBalanceLedgerLogs().catch(() => []),
  ]);

  const adminUsers = adminUsersRaw as Array<Record<string, any>>;
  const byId = new Map<string, Record<string, any>>();
  const aliasToCanonical = new Map<string, string>();
  const canonicalAliases = new Map<string, Set<string>>();

  const registerAlias = (canonicalId: string, alias?: string) => {
    if (!canonicalId || !alias) return;
    const trimmed = String(alias).trim();
    if (!trimmed) return;
    aliasToCanonical.set(trimmed, canonicalId);
    aliasToCanonical.set(trimmed.toLowerCase(), canonicalId);

    const set = canonicalAliases.get(canonicalId) ?? new Set<string>();
    set.add(trimmed);
    canonicalAliases.set(canonicalId, set);

    const digits = normalizePhoneDigits(trimmed);
    if (digits) {
      aliasToCanonical.set(digits, canonicalId);
      aliasToCanonical.set(`+${digits}`, canonicalId);
      aliasToCanonical.set(`whatsapp:+${digits}`, canonicalId);
      aliasToCanonical.set(`whatsapp:${digits}`, canonicalId);
      set.add(`+${digits}`);
      set.add(`whatsapp:+${digits}`);
    }
  };

  for (const u of adminUsers) {
    if (!u?.id) continue;
    byId.set(u.id, u);
    registerAlias(u.id, u.id);
    if (u.whatsappNumber) registerAlias(u.id, u.whatsappNumber);
    if (u.phone) registerAlias(u.id, u.phone);
    if (u.telegramUserId) registerAlias(u.id, `telegram:${u.telegramUserId}`);
  }

  for (const link of identityLinks) {
    if (link.status === 'linked' && link.paymentUserId) {
      if (link.whatsappNumber) registerAlias(link.paymentUserId, link.whatsappNumber);
      if (link.telegramUserId) registerAlias(link.paymentUserId, `telegram:${link.telegramUserId}`);
    }
  }

  const resolveCanonicalId = (rawUserId?: string): string => {
    if (!rawUserId) return '';
    const trimmed = String(rawUserId).trim();
    if (!trimmed) return '';
    const direct = aliasToCanonical.get(trimmed) || aliasToCanonical.get(trimmed.toLowerCase());
    if (direct) return direct;
    const digits = normalizePhoneDigits(trimmed);
    if (digits) {
      const byDigits = aliasToCanonical.get(digits) || aliasToCanonical.get(`+${digits}`);
      if (byDigits) {
        registerAlias(byDigits, trimmed);
        return byDigits;
      }
    }
    registerAlias(trimmed, trimmed);
    return trimmed;
  };

  return {
    byId,
    canonicalAliases,
    resolveCanonicalId,
    virtualAccounts,
    vaTransactions,
    ngnTransfers,
    ledgerLogs,
  };
}

export async function getAdminNgnLedgerDashboard(options: {
  search?: string;
  filter?: 'all' | 'with_balance' | 'with_dva' | 'active_holds';
  sort?: 'available_desc' | 'inflow_desc' | 'outflow_desc' | 'recent_desc';
} = {}) {
  const activeRail = getActiveBankingRailName();
  const registeredRails = listRegisteredRails();

  const [resolver, floatTelemetry, serviceAgreements] = await Promise.all([
    loadCanonicalUserResolver(),
    getLiveFloatTelemetry().catch(() => null),
    db.listServiceAgreements(500).catch(() => []),
  ]);

  const { byId, canonicalAliases, resolveCanonicalId, virtualAccounts, vaTransactions, ngnTransfers, ledgerLogs } = resolver;

  // Map VA transactions and NGN transfers by ID and reference for fast enrichment
  const vaTxMap = new Map<string, VirtualAccountTransactionRecord>();
  for (const tx of vaTransactions) {
    if (String(tx.sourceCurrency || '').toLowerCase() === 'ngn' || String(tx.destinationCurrency || '').toLowerCase() === 'ngn' || tx.provider === 'paystack') {
      vaTxMap.set(tx.id, tx);
      if (tx.depositId) vaTxMap.set(tx.depositId, tx);
      if (tx.depositReference) vaTxMap.set(tx.depositReference, tx);
    }
  }

  const ngnTxMap = new Map<string, NgnTransferRecord>();
  for (const tx of ngnTransfers) {
    ngnTxMap.set(tx.id, tx);
    if (tx.settlementReference) ngnTxMap.set(tx.settlementReference, tx);
    if (tx.providerTransferId) ngnTxMap.set(tx.providerTransferId, tx);
  }

  // Group NGN virtual accounts per canonical user
  const userVas = new Map<string, NormalizedNgnVirtualAccount[]>();
  for (const acc of virtualAccounts) {
    const norm = extractNormalizedVirtualAccount(acc);
    if (!norm) continue;
    const uid = resolveCanonicalId(acc.userId);
    if (!uid) continue;
    const list = userVas.get(uid) ?? [];
    list.push(norm);
    userVas.set(uid, list);
  }

  // Group NGN Service Agreement holds per canonical buyer
  const userAgreementHolds = new Map<string, number>();
  for (const ag of serviceAgreements) {
    const currency = String((ag as any).currency || (ag as any).asset || '').toUpperCase();
    const status = String(ag.status || '').toUpperCase();
    if (currency === 'NGN' && ['FUNDED', 'FUNDED_PENDING_ACCEPTANCE', 'IN_PROGRESS', 'IN_DELIVERY', 'DELIVERED', 'DISPUTED'].includes(status)) {
      const buyerId = resolveCanonicalId((ag as any).buyerUserId || (ag as any).buyerId || (ag as any).creatorUserId);
      const amt = Number((ag as any).amount ?? 0);
      if (buyerId && amt > 0) {
        userAgreementHolds.set(buyerId, round2((userAgreementHolds.get(buyerId) ?? 0) + amt));
      }
    }
  }

  // Process all NGN balance ledger entries in chronological order
  interface UserLedgerAccumulator {
    available: number;
    held: number;
    spent: number;
    totalInflowNgn: number;
    inflowCount: number;
    totalOutflowNgn: number;
    outflowCount: number;
    totalFeesPaidNgn: number;
    dvaInflowFeesNgn: number;
    directOfframpVolumeNgn: number;
    directOfframpCount: number;
    inflowBreakdown: NgnInflowBreakdown;
    outflowBreakdown: NgnOutflowBreakdown;
    lastActivityAt: string | null;
    heldBySource: Map<string, number>;
    seenEntryIds: Set<string>;
  }

  const accumulators = new Map<string, UserLedgerAccumulator>();
  const ensureAcc = (uid: string): UserLedgerAccumulator => {
    let acc = accumulators.get(uid);
    if (!acc) {
      acc = {
        available: 0,
        held: 0,
        spent: 0,
        totalInflowNgn: 0,
        inflowCount: 0,
        totalOutflowNgn: 0,
        outflowCount: 0,
        totalFeesPaidNgn: 0,
        dvaInflowFeesNgn: 0,
        directOfframpVolumeNgn: 0,
        directOfframpCount: 0,
        inflowBreakdown: {
          bankDepositsNgn: 0,
          p2pReceivedNgn: 0,
          serviceAgreementPayoutsNgn: 0,
          reversalRefundsNgn: 0,
          otherInflowNgn: 0,
        },
        outflowBreakdown: {
          bankWithdrawalsNgn: 0,
          utilityBillsNgn: 0,
          p2pSentNgn: 0,
          serviceAgreementSettlementsNgn: 0,
          platformFeesNgn: 0,
          otherOutflowNgn: 0,
        },
        lastActivityAt: null,
        heldBySource: new Map<string, number>(),
        seenEntryIds: new Set<string>(),
      };
      accumulators.set(uid, acc);
    }
    return acc;
  };

  for (const log of ledgerLogs) {
    const entry = (log.metadata ?? {}) as Record<string, any>;
    if (!entry.entryId || String(entry.asset || '').toLowerCase() !== 'ngn') continue;

    const uid = resolveCanonicalId(entry.userId);
    if (!uid) continue;

    const acc = ensureAcc(uid);
    if (acc.seenEntryIds.has(entry.entryId)) continue;
    acc.seenEntryIds.add(entry.entryId);

    const val = Number(entry.amount ?? 0);
    if (!Number.isFinite(val)) continue;

    const sourceKey = `ngn::${entry.sourceId || entry.transferId || entry.entryId}`;
    const createdAt = log.createdAt;
    if (!acc.lastActivityAt || createdAt > acc.lastActivityAt) {
      acc.lastActivityAt = createdAt;
    }

    const vaTx = vaTxMap.get(entry.sourceId) || vaTxMap.get(entry.transferId);
    const ngnTx = ngnTxMap.get(entry.sourceId) || ngnTxMap.get(entry.transferId);
    const classified = classifyLedgerEntry(entry, vaTx, ngnTx);

    if (entry.kind === 'credit_available' || entry.kind === 'adjustment') {
      acc.available += val;
      if (val >= 0) {
        acc.totalInflowNgn += val;
        acc.inflowCount += 1;
        if (classified.flowCategory === 'bank_deposit') {
          acc.inflowBreakdown.bankDepositsNgn += val;
        } else if (classified.flowCategory === 'p2p_receive') {
          acc.inflowBreakdown.p2pReceivedNgn += val;
        } else if (classified.flowCategory === 'service_agreement_release') {
          acc.inflowBreakdown.serviceAgreementPayoutsNgn += val;
        } else if (classified.flowCategory === 'reversal_refund') {
          acc.inflowBreakdown.reversalRefundsNgn += val;
        } else {
          acc.inflowBreakdown.otherInflowNgn += val;
        }
        if (vaTx) {
          const srcAmt = Number(vaTx.sourceAmount ?? 0);
          const dstAmt = Number(vaTx.destinationAmount ?? 0);
          if (srcAmt > dstAmt && dstAmt > 0) {
            acc.dvaInflowFeesNgn += round2(srcAmt - dstAmt);
          }
        }
      } else {
        const absVal = Math.abs(val);
        acc.totalOutflowNgn += absVal;
        acc.outflowCount += 1;
        acc.outflowBreakdown.otherOutflowNgn += absVal;
      }
    } else if (entry.kind === 'hold') {
      acc.available -= val;
      acc.held += val;
      acc.heldBySource.set(sourceKey, (acc.heldBySource.get(sourceKey) || 0) + val);
    } else if (entry.kind === 'hold_release') {
      acc.available += val;
      const releaseFromHeld = Math.min(Math.max(0, acc.held), val);
      const releaseFromSpent = val - releaseFromHeld;
      acc.held -= releaseFromHeld;
      acc.spent = Math.max(0, acc.spent - releaseFromSpent);
      const tracked = acc.heldBySource.get(sourceKey) || 0;
      if (tracked > 0) acc.heldBySource.set(sourceKey, Math.max(0, tracked - val));
    } else if (entry.kind === 'debit_transfer' || entry.kind === 'fee') {
      const tracked = Math.max(0, acc.heldBySource.get(sourceKey) || 0);
      const debitFromHeld = Math.min(tracked, Math.max(0, acc.held), val);
      if (debitFromHeld > 0) acc.heldBySource.set(sourceKey, tracked - debitFromHeld);
      acc.held -= debitFromHeld;
      const unheldDebit = val - debitFromHeld;
      acc.available -= unheldDebit;
      acc.spent += val;
      acc.totalOutflowNgn += val;
      if (entry.kind === 'debit_transfer') {
        acc.outflowCount += 1;
        if (classified.flowCategory === 'utility_purchase') {
          acc.outflowBreakdown.utilityBillsNgn += val;
        } else if (classified.flowCategory === 'p2p_send') {
          acc.outflowBreakdown.p2pSentNgn += val;
        } else if (classified.flowCategory === 'service_agreement_lock') {
          acc.outflowBreakdown.serviceAgreementSettlementsNgn += val;
        } else {
          acc.outflowBreakdown.bankWithdrawalsNgn += val;
        }
      } else if (entry.kind === 'fee') {
        acc.totalFeesPaidNgn += val;
        acc.outflowBreakdown.platformFeesNgn += val;
      }
    }
  }

  // Aggregate direct Crypto-to-NGN off-ramp volume per user (where sourceCurrency !== 'ngn')
  for (const tx of ngnTransfers) {
    const srcCurr = String(tx.sourceCurrency || '').toLowerCase();
    const dstCurr = String(tx.destinationCurrency || 'ngn').toLowerCase();
    if (tx.status === 'completed' && dstCurr === 'ngn' && srcCurr && srcCurr !== 'ngn') {
      const uid = resolveCanonicalId(tx.userId);
      if (!uid) continue;
      const acc = ensureAcc(uid);
      const dstAmt = Number(tx.destinationAmount ?? 0);
      if (Number.isFinite(dstAmt) && dstAmt > 0) {
        acc.directOfframpVolumeNgn += dstAmt;
        acc.directOfframpCount += 1;
        if (!acc.lastActivityAt || tx.createdAt > acc.lastActivityAt) {
          acc.lastActivityAt = tx.createdAt;
        }
      }
    }
  }

  // Ensure every user with an NGN virtual account is included even if their balance is currently 0
  for (const uid of userVas.keys()) {
    ensureAcc(uid);
  }

  // Check PostgreSQL NGN agreement ledger if active
  const pgAgreementLedger = getNgnAgreementLedger();

  const allUserIds = Array.from(accumulators.keys());
  const userRows: AdminNgnUserRow[] = await Promise.all(
    allUserIds.map(async (uid) => {
      const acc = accumulators.get(uid)!;
      const userRecord = byId.get(uid);
      const vas = userVas.get(uid) ?? [];
      vas.sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt.localeCompare(a.updatedAt));
      const primaryVa = vas[0] ?? null;

      let availableNgn = round2(Math.max(0, acc.available));
      if (pgAgreementLedger) {
        try {
          const pgAvail = await pgAgreementLedger.available(uid);
          const pgNaira = round2(Number(BigInt(pgAvail.availableKobo || '0')) / 100);
          if (pgNaira > availableNgn) {
            availableNgn = pgNaira;
          }
        } catch {
          // Non-fatal
        }
      }

      const ledgerHeldNgn = round2(Math.max(0, acc.held));
      const agreementHeldNgn = round2(userAgreementHolds.get(uid) ?? 0);
      const heldNgn = round2(Math.max(ledgerHeldNgn, agreementHeldNgn));
      const totalEquityNgn = round2(availableNgn + heldNgn);
      const totalInflowNgn = round2(acc.totalInflowNgn);
      const totalOutflowNgn = round2(acc.totalOutflowNgn);
      const totalFeesPaidNgn = round2(acc.totalFeesPaidNgn + acc.dvaInflowFeesNgn);
      const directOfframpVolumeNgn = round2(acc.directOfframpVolumeNgn);
      const totalNgnFootprintNgn = round2(totalInflowNgn + directOfframpVolumeNgn);

      const expectedEquityNgn = round2(Math.max(0, totalInflowNgn - totalOutflowNgn));
      const actualLedgerEquityNgn = round2(Math.max(0, acc.available) + ledgerHeldNgn);
      const discrepancyNgn = round2(actualLedgerEquityNgn - expectedEquityNgn);

      const inflowBreakdown: NgnInflowBreakdown = {
        bankDepositsNgn: round2(acc.inflowBreakdown.bankDepositsNgn),
        p2pReceivedNgn: round2(acc.inflowBreakdown.p2pReceivedNgn),
        serviceAgreementPayoutsNgn: round2(acc.inflowBreakdown.serviceAgreementPayoutsNgn),
        reversalRefundsNgn: round2(acc.inflowBreakdown.reversalRefundsNgn),
        otherInflowNgn: round2(acc.inflowBreakdown.otherInflowNgn),
      };

      const outflowBreakdown: NgnOutflowBreakdown = {
        bankWithdrawalsNgn: round2(acc.outflowBreakdown.bankWithdrawalsNgn),
        utilityBillsNgn: round2(acc.outflowBreakdown.utilityBillsNgn),
        p2pSentNgn: round2(acc.outflowBreakdown.p2pSentNgn),
        serviceAgreementSettlementsNgn: round2(acc.outflowBreakdown.serviceAgreementSettlementsNgn),
        platformFeesNgn: round2(acc.outflowBreakdown.platformFeesNgn),
        otherOutflowNgn: round2(acc.outflowBreakdown.otherOutflowNgn),
      };

      const ledgerProof: NgnLedgerProof = {
        expectedEquityNgn,
        actualEquityNgn: actualLedgerEquityNgn,
        discrepancyNgn,
        balanced: Math.abs(discrepancyNgn) < 0.01,
      };

      const fullName =
        userRecord?.fullName ||
        primaryVa?.accountName ||
        (uid.startsWith('whatsapp:') ? `WhatsApp User (${uid.replace(/^whatsapp:/i, '')})` : 'Sivan User');

      const whatsappNumber =
        userRecord?.whatsappNumber ||
        (uid.startsWith('whatsapp:') ? uid.replace(/^whatsapp:/i, '') : undefined);

      const kycStatus =
        userRecord?.customer?.kycStatus ||
        (primaryVa?.active ? 'bvn_verified' : 'not_started');

      return {
        userId: uid,
        aliases: Array.from(canonicalAliases.get(uid) ?? [uid]),
        fullName,
        username: userRecord?.username,
        email: userRecord?.email,
        whatsappNumber,
        kycStatus,
        availableNgn,
        heldNgn,
        agreementHeldNgn,
        totalEquityNgn,
        totalInflowNgn,
        inflowCount: acc.inflowCount,
        totalOutflowNgn,
        outflowCount: acc.outflowCount,
        totalFeesPaidNgn,
        netFlowNgn: round2(totalInflowNgn - totalOutflowNgn),
        directOfframpVolumeNgn,
        directOfframpCount: acc.directOfframpCount,
        totalNgnFootprintNgn,
        inflowBreakdown,
        outflowBreakdown,
        ledgerProof,
        lastActivityAt: acc.lastActivityAt || primaryVa?.updatedAt || null,
        virtualAccount: primaryVa,
        virtualAccounts: vas,
      };
    })
  );

  // Compute global NGN treasury summary across all NGN users
  const totalAvailableNgn = round2(userRows.reduce((s, r) => s + r.availableNgn, 0));
  const totalHeldNgn = round2(userRows.reduce((s, r) => s + r.heldNgn, 0));
  const totalLiabilityNgn = round2(totalAvailableNgn + totalHeldNgn);
  const totalLifetimeInflowNgn = round2(userRows.reduce((s, r) => s + r.totalInflowNgn, 0));
  const totalLifetimeOutflowNgn = round2(userRows.reduce((s, r) => s + r.totalOutflowNgn, 0));
  const totalFeeRevenueNgn = round2(userRows.reduce((s, r) => s + r.totalFeesPaidNgn, 0));
  const totalDirectOfframpVolumeNgn = round2(userRows.reduce((s, r) => s + r.directOfframpVolumeNgn, 0));
  const totalDirectOfframpCount = userRows.reduce((s, r) => s + r.directOfframpCount, 0);
  const totalNgnFootprintNgn = round2(totalLifetimeInflowNgn + totalDirectOfframpVolumeNgn);
  const unbalancedUsersCount = userRows.filter((r) => !r.ledgerProof.balanced).length;
  const inflowCount = userRows.reduce((s, r) => s + r.inflowCount, 0);
  const outflowCount = userRows.reduce((s, r) => s + r.outflowCount, 0);
  const activeVirtualAccountsCount = userRows.filter((r) => r.virtualAccount?.active).length;

  const globalInflowBreakdown: NgnInflowBreakdown = {
    bankDepositsNgn: round2(userRows.reduce((s, r) => s + r.inflowBreakdown.bankDepositsNgn, 0)),
    p2pReceivedNgn: round2(userRows.reduce((s, r) => s + r.inflowBreakdown.p2pReceivedNgn, 0)),
    serviceAgreementPayoutsNgn: round2(userRows.reduce((s, r) => s + r.inflowBreakdown.serviceAgreementPayoutsNgn, 0)),
    reversalRefundsNgn: round2(userRows.reduce((s, r) => s + r.inflowBreakdown.reversalRefundsNgn, 0)),
    otherInflowNgn: round2(userRows.reduce((s, r) => s + r.inflowBreakdown.otherInflowNgn, 0)),
  };

  const globalOutflowBreakdown: NgnOutflowBreakdown = {
    bankWithdrawalsNgn: round2(userRows.reduce((s, r) => s + r.outflowBreakdown.bankWithdrawalsNgn, 0)),
    utilityBillsNgn: round2(userRows.reduce((s, r) => s + r.outflowBreakdown.utilityBillsNgn, 0)),
    p2pSentNgn: round2(userRows.reduce((s, r) => s + r.outflowBreakdown.p2pSentNgn, 0)),
    serviceAgreementSettlementsNgn: round2(userRows.reduce((s, r) => s + r.outflowBreakdown.serviceAgreementSettlementsNgn, 0)),
    platformFeesNgn: round2(userRows.reduce((s, r) => s + r.outflowBreakdown.platformFeesNgn, 0)),
    otherOutflowNgn: round2(userRows.reduce((s, r) => s + r.outflowBreakdown.otherOutflowNgn, 0)),
  };

  // Match NGN provider float telemetry
  const ngnFloatMonitors = (floatTelemetry?.floats ?? []).filter(
    (f) => String(f.currency || '').toUpperCase() === 'NGN'
  );
  const primaryPayoutFloat =
    ngnFloatMonitors.find((f) => f.providerId.includes(activeRail) || f.providerId === 'paystack_payout') ||
    ngnFloatMonitors[0] ||
    null;

  const providerFloatAvailableNgn =
    primaryPayoutFloat && primaryPayoutFloat.status !== 'unreachable'
      ? round2(Number(primaryPayoutFloat.availableBalance ?? 0))
      : null;

  const surplusOrDeficitNgn =
    providerFloatAvailableNgn !== null
      ? round2(providerFloatAvailableNgn - totalLiabilityNgn)
      : null;

  const reconciliationStatus: 'reconciled' | 'surplus' | 'deficit' | 'float_unavailable' =
    providerFloatAvailableNgn === null
      ? 'float_unavailable'
      : Math.abs(surplusOrDeficitNgn!) < 1
        ? 'reconciled'
        : surplusOrDeficitNgn! >= 0
          ? 'surplus'
          : 'deficit';

  // Filter and sort rows for the table
  let filtered = userRows;
  if (options.filter === 'with_balance') {
    filtered = filtered.filter((r) => r.availableNgn > 0 || r.heldNgn > 0);
  } else if (options.filter === 'with_dva') {
    filtered = filtered.filter((r) => Boolean(r.virtualAccount?.accountNumber));
  } else if (options.filter === 'active_holds') {
    filtered = filtered.filter((r) => r.heldNgn > 0);
  }

  if (options.search && options.search.trim()) {
    const q = options.search.trim().toLowerCase();
    filtered = filtered.filter(
      (r) =>
        r.userId.toLowerCase().includes(q) ||
        r.fullName.toLowerCase().includes(q) ||
        (r.username && r.username.toLowerCase().includes(q)) ||
        (r.email && r.email.toLowerCase().includes(q)) ||
        (r.whatsappNumber && r.whatsappNumber.toLowerCase().includes(q)) ||
        (r.virtualAccount?.accountNumber && r.virtualAccount.accountNumber.toLowerCase().includes(q)) ||
        (r.virtualAccount?.accountName && r.virtualAccount.accountName.toLowerCase().includes(q)) ||
        r.aliases.some((a) => a.toLowerCase().includes(q))
    );
  }

  const sortMode = options.sort || 'available_desc';
  filtered.sort((a, b) => {
    if (sortMode === 'inflow_desc') return b.totalInflowNgn - a.totalInflowNgn || b.availableNgn - a.availableNgn;
    if (sortMode === 'outflow_desc') return b.totalOutflowNgn - a.totalOutflowNgn || b.availableNgn - a.availableNgn;
    if (sortMode === 'recent_desc') return String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || ''));
    return b.totalEquityNgn - a.totalEquityNgn || b.totalInflowNgn - a.totalInflowNgn;
  });

  return {
    activeRail,
    registeredRails,
    providerFloats: ngnFloatMonitors,
    summary: {
      totalAvailableNgn,
      totalHeldNgn,
      totalLiabilityNgn,
      totalLifetimeInflowNgn,
      totalLifetimeOutflowNgn,
      totalFeeRevenueNgn,
      totalDirectOfframpVolumeNgn,
      totalDirectOfframpCount,
      totalNgnFootprintNgn,
      unbalancedUsersCount,
      inflowBreakdown: globalInflowBreakdown,
      outflowBreakdown: globalOutflowBreakdown,
      totalNgnUsers: userRows.length,
      usersWithPositiveBalance: userRows.filter((r) => r.totalEquityNgn > 0).length,
      activeVirtualAccountsCount,
      inflowCount,
      outflowCount,
      reconciliation: {
        activeProvider: activeRail,
        providerFloatName: primaryPayoutFloat?.providerName || `${activeRail.toUpperCase()} NGN Settlement Pool`,
        providerFloatAvailableNgn,
        ledgerLiabilityNgn: totalLiabilityNgn,
        surplusOrDeficitNgn,
        status: reconciliationStatus,
        checkedAt: primaryPayoutFloat?.lastCheckedAt || new Date().toISOString(),
      },
    },
    users: filtered,
  };
}

export async function getAdminUserNgnStatement(userIdInput: string) {
  const activeRail = getActiveBankingRailName();
  const resolver = await loadCanonicalUserResolver();
  const { byId, canonicalAliases, resolveCanonicalId, virtualAccounts, vaTransactions, ngnTransfers, ledgerLogs } = resolver;

  const canonicalId = resolveCanonicalId(userIdInput);
  const aliasSet = canonicalAliases.get(canonicalId) ?? new Set<string>([canonicalId, userIdInput]);
  aliasSet.add(canonicalId);
  aliasSet.add(userIdInput);

  const matchesUser = (candidateId?: string): boolean => {
    if (!candidateId) return false;
    const c = String(candidateId).trim();
    if (aliasSet.has(c)) return true;
    return resolveCanonicalId(c) === canonicalId;
  };

  const userRecord = byId.get(canonicalId) ?? null;

  // Virtual accounts for this user across all providers
  const userVas = virtualAccounts
    .filter((acc) => matchesUser(acc.userId))
    .map(extractNormalizedVirtualAccount)
    .filter((v): v is NormalizedNgnVirtualAccount => Boolean(v));
  userVas.sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt.localeCompare(a.updatedAt));

  // VA transactions and NGN transfers for this user
  const vaTxMap = new Map<string, VirtualAccountTransactionRecord>();
  const userVaTransactions: VirtualAccountTransactionRecord[] = [];
  for (const tx of vaTransactions) {
    vaTxMap.set(tx.id, tx);
    if (tx.depositId) vaTxMap.set(tx.depositId, tx);
    if (tx.depositReference) vaTxMap.set(tx.depositReference, tx);
    if (matchesUser(tx.userId)) {
      userVaTransactions.push(tx);
    }
  }

  const ngnTxMap = new Map<string, NgnTransferRecord>();
  const userNgnTransfers: NgnTransferRecord[] = [];
  for (const tx of ngnTransfers) {
    ngnTxMap.set(tx.id, tx);
    if (tx.settlementReference) ngnTxMap.set(tx.settlementReference, tx);
    if (tx.providerTransferId) ngnTxMap.set(tx.providerTransferId, tx);
    if (matchesUser(tx.userId)) {
      userNgnTransfers.push(tx);
    }
  }

  // Chronological NGN ledger entries for this user
  const seenEntryIds = new Set<string>();
  const userNgnLogs = ledgerLogs.filter((log) => {
    const entry = (log.metadata ?? {}) as Record<string, any>;
    if (!entry.entryId || String(entry.asset || '').toLowerCase() !== 'ngn') return false;
    if (!matchesUser(entry.userId)) return false;
    if (seenEntryIds.has(entry.entryId)) return false;
    seenEntryIds.add(entry.entryId);
    return true;
  });

  let available = 0;
  let held = 0;
  let spent = 0;
  let totalInflowNgn = 0;
  let inflowCount = 0;
  let totalOutflowNgn = 0;
  let outflowCount = 0;
  let totalFeesPaidNgn = 0;
  const inflowBreakdown: NgnInflowBreakdown = {
    bankDepositsNgn: 0,
    p2pReceivedNgn: 0,
    serviceAgreementPayoutsNgn: 0,
    reversalRefundsNgn: 0,
    otherInflowNgn: 0,
  };
  const outflowBreakdown: NgnOutflowBreakdown = {
    bankWithdrawalsNgn: 0,
    utilityBillsNgn: 0,
    p2pSentNgn: 0,
    serviceAgreementSettlementsNgn: 0,
    platformFeesNgn: 0,
    otherOutflowNgn: 0,
  };
  const heldBySource = new Map<string, number>();

  const statementEntries: AdminNgnStatementEntry[] = [];

  for (const log of userNgnLogs) {
    const entry = (log.metadata ?? {}) as Record<string, any>;
    const val = Number(entry.amount ?? 0);
    if (!Number.isFinite(val)) continue;

    const availableBefore = round2(Math.max(0, available));
    const heldBefore = round2(Math.max(0, held));
    const sourceKey = `ngn::${entry.sourceId || entry.transferId || entry.entryId}`;

    const vaTx = vaTxMap.get(entry.sourceId) || vaTxMap.get(entry.transferId);
    const ngnTx = ngnTxMap.get(entry.sourceId) || ngnTxMap.get(entry.transferId);
    const classified = classifyLedgerEntry(entry, vaTx, ngnTx);

    if (entry.kind === 'credit_available' || entry.kind === 'adjustment') {
      available += val;
      if (val >= 0) {
        totalInflowNgn += val;
        inflowCount += 1;
        if (classified.flowCategory === 'bank_deposit') {
          inflowBreakdown.bankDepositsNgn += val;
        } else if (classified.flowCategory === 'p2p_receive') {
          inflowBreakdown.p2pReceivedNgn += val;
        } else if (classified.flowCategory === 'service_agreement_release') {
          inflowBreakdown.serviceAgreementPayoutsNgn += val;
        } else if (classified.flowCategory === 'reversal_refund') {
          inflowBreakdown.reversalRefundsNgn += val;
        } else {
          inflowBreakdown.otherInflowNgn += val;
        }
      } else {
        const absVal = Math.abs(val);
        totalOutflowNgn += absVal;
        outflowCount += 1;
        outflowBreakdown.otherOutflowNgn += absVal;
      }
    } else if (entry.kind === 'hold') {
      available -= val;
      held += val;
      heldBySource.set(sourceKey, (heldBySource.get(sourceKey) || 0) + val);
    } else if (entry.kind === 'hold_release') {
      available += val;
      const releaseFromHeld = Math.min(Math.max(0, held), val);
      const releaseFromSpent = val - releaseFromHeld;
      held -= releaseFromHeld;
      spent = Math.max(0, spent - releaseFromSpent);
      const tracked = heldBySource.get(sourceKey) || 0;
      if (tracked > 0) heldBySource.set(sourceKey, Math.max(0, tracked - val));
    } else if (entry.kind === 'debit_transfer' || entry.kind === 'fee') {
      const tracked = Math.max(0, heldBySource.get(sourceKey) || 0);
      const debitFromHeld = Math.min(tracked, Math.max(0, held), val);
      if (debitFromHeld > 0) heldBySource.set(sourceKey, tracked - debitFromHeld);
      held -= debitFromHeld;
      const unheldDebit = val - debitFromHeld;
      available -= unheldDebit;
      spent += val;
      totalOutflowNgn += val;
      if (entry.kind === 'debit_transfer') {
        outflowCount += 1;
        if (classified.flowCategory === 'utility_purchase') {
          outflowBreakdown.utilityBillsNgn += val;
        } else if (classified.flowCategory === 'p2p_send') {
          outflowBreakdown.p2pSentNgn += val;
        } else if (classified.flowCategory === 'service_agreement_lock') {
          outflowBreakdown.serviceAgreementSettlementsNgn += val;
        } else {
          outflowBreakdown.bankWithdrawalsNgn += val;
        }
      } else if (entry.kind === 'fee') {
        totalFeesPaidNgn += val;
        outflowBreakdown.platformFeesNgn += val;
      }
    }

    const availableAfter = round2(Math.max(0, available));
    const heldAfter = round2(Math.max(0, held));

    if (classified.direction === 'INFLOW' && classified.feeNgn > 0) {
      totalFeesPaidNgn += classified.feeNgn;
    }

    const provider = resolveEntryProvider(entry, log.actorId, vaTx, ngnTx, activeRail);
    const reference = String(
      vaTx?.depositReference ||
      vaTx?.depositId ||
      ngnTx?.settlementReference ||
      ngnTx?.providerTransferId ||
      entry.sourceId ||
      entry.transferId ||
      entry.entryId
    );

    statementEntries.push({
      entryId: entry.entryId,
      createdAt: log.createdAt,
      direction: classified.direction,
      flowCategory: classified.flowCategory,
      categoryLabel: classified.categoryLabel,
      kind: entry.kind,
      amountNgn: round2(Math.abs(val)),
      grossAmountNgn: classified.grossAmountNgn,
      feeNgn: classified.feeNgn,
      availableBeforeNgn: availableBefore,
      availableAfterNgn: availableAfter,
      heldBeforeNgn: heldBefore,
      heldAfterNgn: heldAfter,
      provider,
      reference,
      counterparty: classified.counterparty,
      status: String(entry.status || 'completed'),
      description: cleanText(entry.description || classified.categoryLabel),
    });
  }

  // Reverse so newest entries appear first in the statement table
  statementEntries.reverse();

  const primaryVa = userVas[0] ?? null;
  const availableNgn = round2(Math.max(0, available));
  const heldNgn = round2(Math.max(0, held));
  const roundedInflow = round2(totalInflowNgn);
  const roundedOutflow = round2(totalOutflowNgn);
  const expectedEquityNgn = round2(Math.max(0, roundedInflow - roundedOutflow));
  const actualEquityNgn = round2(availableNgn + heldNgn);
  const discrepancyNgn = round2(actualEquityNgn - expectedEquityNgn);

  let directOfframpVolumeNgn = 0;
  let directOfframpCount = 0;
  for (const tx of userNgnTransfers) {
    const srcCurr = String(tx.sourceCurrency || '').toLowerCase();
    const dstCurr = String(tx.destinationCurrency || 'ngn').toLowerCase();
    if (tx.status === 'completed' && dstCurr === 'ngn' && srcCurr && srcCurr !== 'ngn') {
      const dstAmt = Number(tx.destinationAmount ?? 0);
      if (Number.isFinite(dstAmt) && dstAmt > 0) {
        directOfframpVolumeNgn += dstAmt;
        directOfframpCount += 1;
      }
    }
  }
  directOfframpVolumeNgn = round2(directOfframpVolumeNgn);

  return {
    activeRail,
    user: {
      userId: canonicalId,
      aliases: Array.from(aliasSet),
      fullName:
        userRecord?.fullName ||
        primaryVa?.accountName ||
        (canonicalId.startsWith('whatsapp:') ? `WhatsApp User (${canonicalId.replace(/^whatsapp:/i, '')})` : 'Sivan User'),
      username: userRecord?.username,
      email: userRecord?.email,
      whatsappNumber:
        userRecord?.whatsappNumber ||
        (canonicalId.startsWith('whatsapp:') ? canonicalId.replace(/^whatsapp:/i, '') : undefined),
      kycStatus: userRecord?.customer?.kycStatus || (primaryVa?.active ? 'bvn_verified' : 'not_started'),
    },
    summary: {
      availableNgn,
      heldNgn,
      totalEquityNgn: actualEquityNgn,
      totalInflowNgn: roundedInflow,
      inflowCount,
      totalOutflowNgn: roundedOutflow,
      outflowCount,
      totalFeesPaidNgn: round2(totalFeesPaidNgn),
      netFlowNgn: round2(roundedInflow - roundedOutflow),
      directOfframpVolumeNgn,
      directOfframpCount,
      totalNgnFootprintNgn: round2(roundedInflow + directOfframpVolumeNgn),
      inflowBreakdown: {
        bankDepositsNgn: round2(inflowBreakdown.bankDepositsNgn),
        p2pReceivedNgn: round2(inflowBreakdown.p2pReceivedNgn),
        serviceAgreementPayoutsNgn: round2(inflowBreakdown.serviceAgreementPayoutsNgn),
        reversalRefundsNgn: round2(inflowBreakdown.reversalRefundsNgn),
        otherInflowNgn: round2(inflowBreakdown.otherInflowNgn),
      },
      outflowBreakdown: {
        bankWithdrawalsNgn: round2(outflowBreakdown.bankWithdrawalsNgn),
        utilityBillsNgn: round2(outflowBreakdown.utilityBillsNgn),
        p2pSentNgn: round2(outflowBreakdown.p2pSentNgn),
        serviceAgreementSettlementsNgn: round2(outflowBreakdown.serviceAgreementSettlementsNgn),
        platformFeesNgn: round2(outflowBreakdown.platformFeesNgn),
        otherOutflowNgn: round2(outflowBreakdown.otherOutflowNgn),
      },
      ledgerProof: {
        expectedEquityNgn,
        actualEquityNgn,
        discrepancyNgn,
        balanced: Math.abs(discrepancyNgn) < 0.01,
      },
      firstActivityAt: userNgnLogs[0]?.createdAt ?? null,
      lastActivityAt: userNgnLogs[userNgnLogs.length - 1]?.createdAt ?? null,
    },
    virtualAccount: primaryVa,
    virtualAccounts: userVas,
    entries: statementEntries,
    recentBankDeposits: userVaTransactions
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 25)
      .map((tx) => ({
        id: tx.id,
        provider: tx.provider,
        reference: tx.depositReference || tx.depositId,
        grossAmountNgn: round2(Number(tx.sourceAmount ?? 0)),
        netAmountNgn: round2(Number(tx.destinationAmount ?? 0)),
        paymentRail: tx.paymentRail,
        status: tx.status,
        createdAt: tx.createdAt,
      })),
    recentBankWithdrawals: userNgnTransfers
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 25)
      .map((tx) => {
        const rawTx = tx as Record<string, any>;
        const meta = (tx.metadata ?? {}) as Record<string, any>;
        return {
          id: tx.id,
          provider: tx.provider,
          reference: tx.settlementReference || tx.providerTransferId || tx.id,
          amountNgn: round2(Number(tx.destinationAmount ?? tx.sourceAmount ?? 0)),
          bankName: rawTx.bankName || meta.bankName,
          accountNumber: rawTx.accountNumber || meta.accountNumber,
          accountName: rawTx.accountName || meta.accountName,
          status: tx.status,
          createdAt: tx.createdAt,
        };
      }),
  };
}

export async function syncAdminUserNgnVirtualAccount(userIdInput: string) {
  const activeRail = getActiveBankingRailName();
  let syncResult: unknown = null;

  if (activeRail === 'paystack') {
    try {
      syncResult = await adminSyncUserDva(userIdInput);
    } catch (err: any) {
      syncResult = { synced: false, provider: activeRail, message: err?.message || String(err) };
    }
  } else {
    try {
      const adapter = getBankingRailAdapter(activeRail);
      const accounts = await adapter.listVirtualAccounts(userIdInput);
      syncResult = { synced: true, provider: activeRail, accountsFound: accounts.length, accounts };
    } catch (err: any) {
      syncResult = { synced: false, provider: activeRail, message: err?.message || String(err) };
    }
  }

  const statement = await getAdminUserNgnStatement(userIdInput);
  return {
    syncResult,
    statement,
  };
}
