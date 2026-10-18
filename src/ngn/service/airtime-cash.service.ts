/**
 * SIVAN AIRTIME-TO-CASH SERVICE
 *
 * Facilitates converting telco mobile airtime credit directly to NGN ledger balance
 * and cashing out to verified Nigerian bank accounts via Paystack Transfers API.
 *
 * CRITICAL ANTI-FRAUD SAFEGUARDS (Fintech Compliance Protocol):
 * 1. Strict Name Matching: Destination bank account name MUST match the customer's
 *    verified Sivan account name on file. Third-party payouts are strictly rejected
 *    to prevent laundering of stolen SIM airtime.
 * 2. 24-Hour Velocity Cap: Maximum 20,000 NGN per 24 hours per user.
 * 3. Session Expiry: Quotes expire after 10 minutes to protect against telco rate shifts.
 * 4. Multi-Aggregator Failover: Operates across registered plug-and-play utility providers.
 */

import { z } from 'zod';
import { db } from '../../database/json-database.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { createBalanceLedgerEntry } from '../../balances/balance.service.js';
import { matchAccountName } from '../../kyc/service/name-match.js';
import { resolvePaystackBankAccount, executePaystackNgnBankTransfer } from './paystack-outbound-transfer.service.js';
import { executeUtilityWithFailover, getUtilityProvider } from '../provider/utility-registry.js';
import type {
  TelcoOperator,
  AirtimeCashRate,
  AirtimeCashSession,
  UtilityReceipt,
} from '../types/paystackUtilityTypes.js';

export const initiateAirtimeCashSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  phone: z.string().min(10, 'Valid 11-digit phone number is required'),
  operator: z.enum(['mtn', 'airtel', 'glo', '9mobile']),
  amountNgn: z.number().int().min(1000, 'Minimum airtime conversion is 1,000 NGN').max(20000, 'Maximum airtime conversion is 20,000 NGN'),
  providerName: z.string().optional(),
});

export const confirmAirtimeCashSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  sessionId: z.string().min(1, 'sessionId is required'),
  otp: z.string().min(4, 'OTP is required'),
  sharePin: z.string().min(4, 'Transfer PIN is required'),
  providerName: z.string().optional(),
});

export const cashoutAirtimeCashSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  amountNgn: z.number().int().min(100, 'Minimum cashout amount is 100 NGN'),
  accountNumber: z.string().regex(/^\d{10}$/, '10-digit account number is required'),
  bankCode: z.string().min(1, 'Bank code is required'),
  bankName: z.string().optional(),
  pin: z.string().min(4).max(12).optional(),
  stepUpToken: z.string().optional(),
  narration: z.string().optional(),
});

export type InitiateAirtimeCashInput = z.infer<typeof initiateAirtimeCashSchema>;
export type ConfirmAirtimeCashInput = z.infer<typeof confirmAirtimeCashSchema>;
export type CashoutAirtimeCashInput = z.infer<typeof cashoutAirtimeCashSchema>;

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DAILY_AIRTIME_CASH_CAP_NGN = 20_000;

// In-memory session store (backed by Redis/PostgreSQL in deployment)
const activeSessions = new Map<string, AirtimeCashSession>();

/**
 * Returns current airtime conversion rates.
 */
export async function getAirtimeConversionRate(
  operator: TelcoOperator,
  preferredProviderName?: string
): Promise<AirtimeCashRate> {
  const provider = getUtilityProvider(preferredProviderName);
  if (provider.getAirtimeCashRate) {
    return provider.getAirtimeCashRate(operator);
  }
  return {
    operator,
    rate: 0.82,
    percent: '82%',
    minAmountNgn: 1000,
    maxAmountNgn: 20000,
  };
}

/**
 * Step 1: Initiates airtime conversion session and requests telco network OTP.
 */
export async function initiateAirtimeCashConversion(
  rawInput: InitiateAirtimeCashInput
): Promise<AirtimeCashSession> {
  const input = initiateAirtimeCashSchema.parse(rawInput);

  // 1. Enforce 24-hour velocity ceiling
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  let userRecentVolume = 0;
  for (const session of activeSessions.values()) {
    if (session.userId === input.userId && session.status === 'COMPLETED') {
      const createdTime = new Date(session.createdAt).getTime();
      if (createdTime >= dayAgo) {
        userRecentVolume += session.amountNgn;
      }
    }
  }

  if (userRecentVolume + input.amountNgn > DAILY_AIRTIME_CASH_CAP_NGN) {
    throw badRequest(
      `Daily airtime-to-cash limit exceeded. Your 24-hour ceiling is ${DAILY_AIRTIME_CASH_CAP_NGN.toLocaleString()} NGN. You have used ${userRecentVolume.toLocaleString()} NGN.`
    );
  }

  // 2. Multi-aggregator execution with failover
  const { result } = await executeUtilityWithFailover(async (provider) => {
    if (!provider.initiateAirtimeToCash) {
      throw new Error(`Provider ${provider.name} does not support airtime-to-cash conversion`);
    }
    return provider.initiateAirtimeToCash({
      phone: input.phone,
      operator: input.operator,
      amountNgn: input.amountNgn,
    });
  }, input.providerName);

  const session: AirtimeCashSession = {
    sessionId: result.sessionId,
    userId: input.userId,
    phone: input.phone,
    operator: input.operator,
    amountNgn: input.amountNgn,
    rate: result.rate,
    payoutAmountNgn: result.payoutAmountNgn,
    status: 'AWAITING_OTP',
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    createdAt: new Date(now).toISOString(),
  };

  activeSessions.set(session.sessionId, session);
  return session;
}

/**
 * Step 2: Validates OTP and Transfer PIN, debits airtime, and credits Sivan NGN ledger.
 */
export async function confirmAirtimeCashConversion(
  rawInput: ConfirmAirtimeCashInput
): Promise<UtilityReceipt> {
  const input = confirmAirtimeCashSchema.parse(rawInput);
  const session = activeSessions.get(input.sessionId);

  if (!session) {
    throw notFound('Airtime conversion session not found or expired');
  }

  if (session.userId !== input.userId) {
    throw badRequest('Session does not belong to this user');
  }

  if (Date.now() > new Date(session.expiresAt).getTime()) {
    session.status = 'EXPIRED';
    throw badRequest('Session has expired. Telco rates shift regularly - please initiate a new quote.');
  }

  if (session.status === 'COMPLETED') {
    throw badRequest('This airtime conversion has already been processed.');
  }

  // 1. Dispatch confirmation to provider with failover
  const { result, providerName } = await executeUtilityWithFailover(async (provider) => {
    if (!provider.confirmAirtimeToCash) {
      throw new Error(`Provider ${provider.name} does not support airtime-to-cash confirmation`);
    }
    return provider.confirmAirtimeToCash({
      sessionId: input.sessionId,
      otp: input.otp,
      sharePin: input.sharePin,
    });
  }, input.providerName);

  // 2. Mark session completed
  session.status = 'COMPLETED';
  session.reference = result.reference;

  // 3. Atomically credit user NGN ledger balance
  const creditedAmountNgn = result.creditedAmountNgn || session.payoutAmountNgn;
  const nowIso = new Date().toISOString();

  await createBalanceLedgerEntry(
    {
      userId: session.userId,
      asset: 'ngn',
      amount: creditedAmountNgn.toFixed(2),
      kind: 'credit_available',
      status: 'available',
      sourceType: 'airtime_to_cash',
      sourceId: result.reference,
      description: `Airtime conversion (${session.operator.toUpperCase()} ${session.amountNgn} NGN at ${Math.round(session.rate * 100)}%): credited ${creditedAmountNgn.toFixed(2)} NGN`,
      transferId: result.reference,
    },
    { actorType: 'provider', actorId: providerName }
  );

  const formattedText = [
    'Sivan Payment Ai: Airtime Conversion Receipt',
    '----------------------------------------',
    `Operator: ${session.operator.toUpperCase()}`,
    `Phone: ${session.phone}`,
    `Airtime Submitted: ${session.amountNgn.toLocaleString()} NGN`,
    `Conversion Rate: ${Math.round(session.rate * 100)}%`,
    `Cash Credited: ${creditedAmountNgn.toLocaleString()} NGN`,
    `Status: Credited to Sivan Wallet`,
    `Reference: ${result.reference}`,
    `Date: ${nowIso}`,
    '----------------------------------------',
    'You can now withdraw these funds to your personal Nigerian bank account or spend them directly on Sivan.',
  ].join('\n');

  return {
    success: true,
    serviceType: 'airtime_cash',
    providerName,
    operatorOrDisco: session.operator.toUpperCase(),
    recipientOrMeter: session.phone,
    amountNgn: session.amountNgn,
    feeNgn: session.amountNgn - creditedAmountNgn,
    totalDebitedNgn: session.amountNgn,
    reference: result.reference,
    timestamp: nowIso,
    formattedText,
  };
}

/**
 * Step 3: Cash out converted airtime funds to user's personal bank account.
 * ENFORCES STRICT NAME MATCHING:
 * Destination bank account name MUST match the verified user name.
 * Third-party bank payouts are strictly rejected.
 */
export async function cashoutAirtimeToBank(
  rawInput: CashoutAirtimeCashInput
) {
  const input = cashoutAirtimeCashSchema.parse(rawInput);

  // 1. Retrieve user's verified identity
  const user = await db.findUserById(input.userId);
  if (!user) {
    throw notFound('User not found');
  }

  const verifiedUserName = (user.fullName || (user as any).name || '').trim();
  if (!verifiedUserName) {
    throw badRequest('Please complete your profile name verification before withdrawing airtime funds.');
  }

  // 2. Resolve destination bank account name via Paystack NIBSS lookup
  const resolved = await resolvePaystackBankAccount(input.bankCode, input.accountNumber);
  const resolvedAccountName = resolved.accountName.trim();

  // 3. Strict Name Matching Check
  const matchResult = matchAccountName(verifiedUserName, resolvedAccountName);

  if (matchResult.verdict === 'mismatch' || matchResult.score < 0.4) {
    throw badRequest(
      `Airtime-to-cash withdrawal rejected: Destination bank account name ("${resolvedAccountName}") does not match your verified Sivan account name ("${verifiedUserName}"). To prevent laundering of stolen airtime, third-party payouts are strictly prohibited.`
    );
  }

  // 4. Execute outbound transfer to verified matching bank account
  return executePaystackNgnBankTransfer(input.userId, {
    accountNumber: input.accountNumber,
    bankCode: input.bankCode,
    bankName: input.bankName,
    accountName: resolvedAccountName,
    amount: input.amountNgn,
    pin: input.pin,
    stepUpToken: input.stepUpToken,
    narration: input.narration || `Sivan airtime cashout for ${user.username || user.id}`,
  });
}
