import crypto from 'node:crypto';
import { z } from 'zod';
import { badRequest } from '../../shared/errors.js';
import { db } from '../../database/json-database.js';
import { env } from '../../config/env.js';
import { paystackBaseUrl, paystackHeaders, paystackMode } from '../../config/paystackConfig.js';
import { getUnifiedBalance } from '../../balances/unified-balance.service.js';
import { createBalanceLedgerEntry } from '../../balances/balance.service.js';
import { assertWithdrawalAuthorised } from '../../identity/withdrawal-pin.guard.js';
import { hasWithdrawalPin } from '../../identity/withdrawal-pin.service.js';
import { getBankingRailAdapter } from '../../banking-rail/banking-rail-registry.js';
import type { NgnTransferRecord, NgnQuoteRecord } from '../types/ngn.types.js';
import type { TransferRecord } from '../../banking-rail/banking-rail.adapter.js';

export interface PaystackBank {
  id: number;
  name: string;
  slug: string;
  code: string;
  longcode?: string;
  gateway?: string;
  payWithBank?: boolean;
  active?: boolean;
  country?: string;
  currency?: string;
  type?: string;
}

export interface ResolvedPaystackAccount {
  accountNumber: string;
  accountName: string;
  bankCode: string;
  bankName?: string;
}

export const executePaystackTransferSchema = z.object({
  accountNumber: z.string().regex(/^\d{10}$/, 'Account number must be 10 digits'),
  bankCode: z.string().min(1, 'Bank code is required'),
  bankName: z.string().optional(),
  accountName: z.string().optional(),
  amount: z.number().positive().min(100, 'Minimum transfer amount is 100 NGN'),
  pin: z.string().min(4).max(12).optional(),
  stepUpToken: z.string().optional(),
  narration: z.string().max(100).optional(),
});

export type ExecutePaystackTransferInput = z.infer<typeof executePaystackTransferSchema>;

// In-memory cache for bank list to avoid hitting Paystack API repeatedly
let cachedBanks: PaystackBank[] | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const POPULAR_BANK_CODES = [
  '999992', // OPay
  '999991', // PalmPay
  '50211',  // Kuda
  '50515',  // Moniepoint
  '058',    // GTBank
  '044',    // Access Bank
  '057',    // Zenith Bank
  '033',    // UBA
  '011',    // First Bank
];

const FALLBACK_BANKS: PaystackBank[] = [
  { id: 999992, name: 'OPay', slug: 'opay', code: '999992', active: true },
  { id: 999991, name: 'PalmPay', slug: 'palmpay', code: '999991', active: true },
  { id: 50211, name: 'Kuda Bank', slug: 'kuda-bank', code: '50211', active: true },
  { id: 50515, name: 'Moniepoint MFB', slug: 'moniepoint-mfb', code: '50515', active: true },
  { id: 58, name: 'Guaranty Trust Bank', slug: 'guaranty-trust-bank', code: '058', active: true },
  { id: 44, name: 'Access Bank', slug: 'access-bank', code: '044', active: true },
  { id: 57, name: 'Zenith Bank', slug: 'zenith-bank', code: '057', active: true },
  { id: 33, name: 'United Bank For Africa', slug: 'united-bank-for-africa', code: '033', active: true },
  { id: 11, name: 'First Bank of Nigeria', slug: 'first-bank-of-nigeria', code: '011', active: true },
];

/**
 * Lists banks supported by Paystack for NGN transfers.
 * Results are cached in memory for 1 hour.
 */
export async function listPaystackBanks(currency = 'NGN'): Promise<PaystackBank[]> {
  const now = Date.now();
  if (cachedBanks && now < cacheExpiresAt) {
    return cachedBanks;
  }

  try {
    const res = await fetch(`${paystackBaseUrl()}/bank?currency=${encodeURIComponent(currency)}`, {
      method: 'GET',
      headers: paystackHeaders(),
      signal: AbortSignal.timeout(15_000),
    });

    const body: any = await res.json();
    if (body?.status && Array.isArray(body?.data)) {
      const rawBanks: any[] = body.data;
      const parsed: PaystackBank[] = rawBanks
        .filter((b) => b && b.active !== false && b.is_deleted !== true)
        .map((b) => ({
          id: Number(b.id || 0),
          name: String(b.name || '').trim(),
          slug: String(b.slug || '').trim(),
          code: String(b.code || '').trim(),
          longcode: b.longcode ? String(b.longcode).trim() : undefined,
          gateway: b.gateway ? String(b.gateway).trim() : undefined,
          payWithBank: Boolean(b.pay_with_bank),
          active: Boolean(b.active),
          country: b.country ? String(b.country).trim() : 'Nigeria',
          currency: b.currency ? String(b.currency).trim() : 'NGN',
          type: b.type ? String(b.type).trim() : 'nuban',
        }));

      // Sort popular banks to top, followed by alphabetical
      parsed.sort((a, b) => {
        const aPop = POPULAR_BANK_CODES.indexOf(a.code);
        const bPop = POPULAR_BANK_CODES.indexOf(b.code);
        if (aPop !== -1 && bPop !== -1) return aPop - bPop;
        if (aPop !== -1) return -1;
        if (bPop !== -1) return 1;
        return a.name.localeCompare(b.name);
      });

      cachedBanks = parsed;
      cacheExpiresAt = now + CACHE_TTL_MS;
      return parsed;
    }
  } catch (error) {
    console.warn('[paystack-outbound] Failed to fetch bank list from Paystack:', error);
  }

  // Graceful fallback to common banks
  return cachedBanks || FALLBACK_BANKS;
}

/**
 * Resolves an account number against a destination bank code via Paystack.
 */
export async function resolvePaystackBankAccount(
  bankCode: string,
  accountNumber: string
): Promise<ResolvedPaystackAccount> {
  const cleanAccount = String(accountNumber || '').trim();
  const cleanBank = String(bankCode || '').trim();

  if (!/^\d{10}$/.test(cleanAccount)) {
    throw badRequest('Nigerian bank account number must be exactly 10 digits.');
  }
  if (!cleanBank) {
    throw badRequest('Bank code is required.');
  }

  try {
    const url = `${paystackBaseUrl()}/bank/resolve?account_number=${encodeURIComponent(cleanAccount)}&bank_code=${encodeURIComponent(cleanBank)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: paystackHeaders(),
      signal: AbortSignal.timeout(15_000),
    });

    const data: any = await res.json();
    if (!data?.status || !data?.data?.account_name) {
      throw badRequest(data?.message || 'Could not resolve account name. Check the account number and bank code.');
    }

    return {
      accountNumber: String(data.data.account_number || cleanAccount),
      accountName: String(data.data.account_name).trim(),
      bankCode: cleanBank,
    };
  } catch (error: any) {
    if (error?.statusCode || error?.status) throw error;
    throw badRequest(`Bank resolution failed: ${String(error?.message || error)}`);
  }
}

/**
 * Executes an outbound NGN bank transfer from the user's Sivan ledger balance
 * to an external Nigerian bank account via Paystack Transfers API.
 *
 * Adheres strictly to the Financial Ledger Integrity Protocol:
 * 1. PIN / Step-Up Authorization verified before touching user balance.
 * 2. Balance verified in unified Sivan ledger.
 * 3. Ledger Hold placed atomically before provider call.
 * 4. Stable providerRef used as idempotency key.
 * 5. If provider rejects immediately, hold is atomically released and logged.
 * 6. Provider outcome recorded in NgnTransferRecord. Finalization happens on webhook
 *    or on authoritative query.
 */
export async function executePaystackNgnBankTransfer(
  userId: string,
  rawInput: ExecutePaystackTransferInput
) {
  const input = executePaystackTransferSchema.parse(rawInput);

  // 1. PIN / Authorization Check
  const configured = await hasWithdrawalPin(userId);
  if (configured || env.WITHDRAWAL_PIN_ENFORCED || input.pin || input.stepUpToken) {
    await assertWithdrawalAuthorised({
      userId,
      pin: input.pin,
      stepUpToken: input.stepUpToken,
      amount: input.amount.toFixed(2),
      currency: 'NGN',
      destinationRef: `${input.bankCode}:${input.accountNumber}`,
    });
  }

  // 2. Balance Check
  const unified = await getUnifiedBalance(userId);
  const ngnBal = (unified.balances as any[]).find((b) => String(b.asset).toLowerCase() === 'ngn');
  const availableNgn = Number(ngnBal?.availableBalance ?? ngnBal?.spendable ?? '0');
  if (!Number.isFinite(availableNgn) || availableNgn < input.amount) {
    throw badRequest(
      `Insufficient NGN balance. Available: ${availableNgn.toFixed(2)} NGN, requested: ${input.amount.toFixed(2)} NGN`
    );
  }

  // 3. Stable Identifiers
  const transferId = `ngntx_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const providerRef = `ps_out_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const now = new Date().toISOString();

  // 4. Atomic Ledger Hold
  await createBalanceLedgerEntry(
    {
      userId,
      asset: 'ngn',
      amount: input.amount.toFixed(2),
      kind: 'hold',
      status: 'held',
      sourceType: 'ngn_cashout',
      sourceId: transferId,
      description: `Hold NGN for outbound Paystack transfer to ${input.accountNumber} (${input.bankName ?? input.bankCode})`,
      transferId,
    },
    { actorType: 'user', actorId: userId }
  );

  // 5. Initial Quote & Transfer Records in Database
  const quoteId = `ngnq_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const quoteRecord: NgnQuoteRecord = {
    id: quoteId,
    userId,
    direction: 'offramp',
    provider: 'paystack',
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: input.amount.toFixed(2),
    destinationAmount: input.amount.toFixed(2),
    rate: '1.00',
    feeAmount: '0.00',
    status: 'quote_accepted',
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    createdAt: now,
    updatedAt: now,
  };
  await db.upsertNgnQuoteRecord(quoteRecord);

  const transferRecord: NgnTransferRecord = {
    id: transferId,
    quoteId,
    userId,
    direction: 'offramp',
    provider: 'paystack',
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: input.amount.toFixed(2),
    destinationAmount: input.amount.toFixed(2),
    rate: '1.00',
    feeAmount: '0.00',
    status: 'bank_processing',
    bankReference: providerRef,
    settlementReference: providerRef,
    createdAt: now,
    updatedAt: now,
    metadata: {
      accountNumber: input.accountNumber,
      bankCode: input.bankCode,
      bankName: input.bankName,
      accountName: input.accountName,
      narration: input.narration,
      providerRef,
    },
  };
  await db.upsertNgnTransferRecord(transferRecord);

  // 6. Dispatch to Paystack via BankingRailAdapter
  const adapter = getBankingRailAdapter('paystack');
  let result: TransferRecord;
  try {
    result = await adapter.createTransfer({
      userId,
      accountNumber: input.accountNumber,
      bankCode: input.bankCode,
      amountKobo: Math.round(input.amount * 100),
      providerRef,
      narration: input.narration || `Sivan transfer for ${userId}`,
    });
  } catch (err: any) {
    // Immediate Rejection by Paystack -> Release Hold Atomically
    await createBalanceLedgerEntry(
      {
        userId,
        asset: 'ngn',
        amount: input.amount.toFixed(2),
        kind: 'hold_release',
        status: 'available',
        sourceType: 'ngn_cashout',
        sourceId: transferId,
        description: `Release hold for rejected Paystack bank transfer: ${err?.message ?? 'Rejected'}`,
        transferId,
      },
      { actorType: 'system', actorId: 'sivan-payment' }
    );

    await db.upsertNgnTransferRecord({
      ...transferRecord,
      status: 'failed',
      updatedAt: new Date().toISOString(),
      metadata: {
        ...(transferRecord.metadata as any),
        failureReason: err?.message ?? 'Rejected by Paystack',
      },
    });

    throw badRequest(`Bank transfer failed: ${err?.message ?? 'Rejected by Paystack'}`);
  }

  // 7. Update Transfer Record with Provider Response
  const updatedRecord: NgnTransferRecord = {
    ...transferRecord,
    providerTransferId: result.providerTransferId,
    updatedAt: new Date().toISOString(),
    metadata: {
      ...(transferRecord.metadata as any),
      paystackTransferCode: result.providerTransferId,
      providerStatus: result.status,
      raw: result.raw,
    },
  };

  // If already confirmed (e.g., synchronous test bank success)
  if (result.status === 'success') {
    updatedRecord.status = 'completed';
    updatedRecord.completedAt = new Date().toISOString();
    await createBalanceLedgerEntry(
      {
        userId,
        asset: 'ngn',
        amount: input.amount.toFixed(2),
        kind: 'debit_transfer',
        status: 'completed',
        sourceType: 'ngn_cashout',
        sourceId: transferId,
        description: `Debit held NGN after Paystack transfer completion (${providerRef})`,
        transferId,
      },
      { actorType: 'provider', actorId: 'paystack' }
    );
  }

  await db.upsertNgnTransferRecord(updatedRecord);

  return {
    success: true,
    transferId,
    providerRef,
    providerTransferId: result.providerTransferId,
    status: updatedRecord.status,
    amount: input.amount,
    currency: 'NGN',
    recipient: {
      accountNumber: input.accountNumber,
      bankCode: input.bankCode,
      bankName: input.bankName,
      accountName: input.accountName,
    },
  };
}
