/**
 * SIVAN UTILITY SERVICE (MULTI-PROVIDER ORCHESTRATOR)
 *
 * Coordinates daily digital service fulfillment across pluggable providers:
 * - Telco Airtime Top-Up (MTN, Airtel, Glo, 9mobile)
 * - Mobile Data Bundles
 * - Electricity DisCo Inquiry & Token Generation (IKEDC, EKEDC, AEDC, etc.)
 * - Atomic Debit & Human-Readable Receipt Formatting for WhatsApp & Telegram
 *
 * Pluggable transport: not hardcoded to any single aggregator.
 * Routes dynamically through UtilityProviderRegistry.
 */

import crypto from 'node:crypto';
import { db } from '../../database/json-database.js';
import { badRequest, conflict, forbidden, serviceUnavailable } from '../../shared/errors.js';
import { getUnifiedBalance } from '../../balances/unified-balance.service.js';
import { createBalanceLedgerEntry } from '../../balances/balance.service.js';
import {
  type TelcoOperator,
  type DiscoCode,
  type MeterType,
  type AirtimePurchaseRequest,
  type DataBundlePurchaseRequest,
  type ElectricityInquiryRequest,
  type ElectricityInquiryResponse,
  type ElectricityPaymentRequest,
  type UtilityReceipt,
  type DataPlanOption,
  detectTelcoOperator,
  normalizeDomesticPhone,
  DISCO_DISPLAY_NAMES,
} from '../types/paystackUtilityTypes.js';
import {
  getUtilityProvider,
  registerUtilityProvider,
  listUtilityProviders,
  getActiveUtilityProviderName,
  executeUtilityWithFailover,
  getUtilityProviderChain,
  executeForService,
  getProviderChainForService,
} from '../provider/utility-registry.js';
import type { IUtilityProvider } from '../provider/utility-provider.interface.js';
import { ensureUtilityRoutingLoaded } from './utility-routing.service.js';

/**
 * One key per purchase, reused for every attempt in a failover chain.
 *
 * Without it a provider that vended successfully but answered too slowly gets
 * retried on the next provider and the customer receives the value twice
 * while being debited once.
 */
function newIdempotencyKey(service: string, userId: string): string {
  return `sivan_${service}_${crypto.randomUUID()}_${crypto.createHash('sha256').update(userId).digest('hex').slice(0, 8)}`;
}

import { createSystemIncident } from '../../incidents/system-incidents.service.js';

/**
 * Asynchronous per-user mutex to serialize balance checks and reservations.
 * Eliminates race windows where concurrent requests both read unreserved balances.
 */
class UserMutex {
  private queue: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void = () => {};
    const wait = this.queue;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await wait;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

const userMutexMap = new Map<string, UserMutex>();

function getUserMutex(userId: string): UserMutex {
  let mutex = userMutexMap.get(userId);
  if (!mutex) {
    mutex = new UserMutex();
    userMutexMap.set(userId, mutex);
  }
  return mutex;
}

/**
 * Canonical purchase fingerprinting to bind idempotency keys to their specific parameters.
 */
export function computePurchaseFingerprint(input: {
  serviceType: string;
  userId: string;
  recipient: string;
  amountNgn: number;
  operatorOrDisco: string;
  planCode?: string;
}): string {
  const parts = [
    input.serviceType.toLowerCase().trim(),
    input.userId.toLowerCase().trim(),
    input.recipient.toLowerCase().trim(),
    Math.round(input.amountNgn).toString(),
    input.operatorOrDisco.toLowerCase().trim(),
    (input.planCode || '').toLowerCase().trim(),
  ];
  return crypto.createHash('sha256').update(parts.join(':')).digest('hex');
}

/**
 * Distinguishes explicit provider rejections from network timeouts or unknown states.
 */
export function isTimeoutOrNetworkError(err: any): boolean {
  if (!err) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const msg = String(err.message || '').toLowerCase();
  const code = String(err.code || err.details?.code || err.reason || '').toLowerCase();
  if (
    code === 'etimedout' ||
    code === 'econnreset' ||
    code === 'econnrefused' ||
    code === 'enotfound' ||
    code === 'timeout' ||
    code === 'provider_timeout'
  ) {
    return true;
  }
  if (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('network error') ||
    msg.includes('gateway timeout') ||
    msg.includes('service unavailable')
  ) {
    return true;
  }
  const status = Number(err.status || err.statusCode || err.details?.status || 0);
  if (status === 502 || status === 504 || status === 503) {
    return true;
  }
  return false;
}

/**
 * Authoritative rejections are explicit client errors or business refusal codes
 * confirming that the upstream provider did not and will not fulfill the purchase.
 * Any other error (unhandled exceptions, 5xx server errors, socket crashes) is unknown
 * and MUST retain the balance hold pending authoritative reconciliation.
 */
export function isAuthoritativeRejection(err: any): boolean {
  if (!err) return false;
  if (isTimeoutOrNetworkError(err)) return false;

  const status = Number(err.statusCode || err.status || err.details?.status || 0);
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return true;
  }

  const code = String(err.code || err.details?.code || err.reason || '').toLowerCase();
  const knownRejectionCodes = [
    'invalid_recipient',
    'invalid_meter',
    'invalid_account',
    'meter_not_found',
    'operator_rejected',
    'insufficient_balance',
    'insufficient_provider_float',
    'bad_request',
    'pin_not_set',
    'pin_required',
    'pin_invalid',
  ];
  if (knownRejectionCodes.includes(code)) return true;

  const msg = String(err.message || '').toLowerCase();
  const knownRejectionPhrases = [
    'invalid mobile number',
    'invalid recipient',
    'invalid meter',
    'meter number is invalid',
    'unsupported operator',
    'unknown electricity distribution',
    'no data plan',
    'insufficient balance',
    'insufficient float',
    'pin',
  ];
  if (knownRejectionPhrases.some((phrase) => msg.includes(phrase))) {
    return true;
  }

  return false;
}

/**
 * Distributed user lock runner.
 * In PostgreSQL, uses pg_advisory_xact_lock to synchronize across all server instances.
 * In memory/JSON tests, uses the local UserMutex.
 */
export async function runWithUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  if (typeof (db as any).withUserLock === 'function') {
    return (db as any).withUserLock(userId, fn);
  }
  const userMutex = getUserMutex(userId);
  return userMutex.runExclusive(fn);
}

/**
 * In-flight reservation tracker per user to serialize concurrent balance checks.
 */
const userInFlightSpend = new Map<string, number>();

/**
 * Idempotency receipt cache (keyed by caller idempotencyKey or reference) to ensure
 * network retries return the exact authoritative receipt without re-executing or double-debiting.
 */
interface CachedIdempotencyEntry {
  receipt: UtilityReceipt;
  expiresAt: number;
  userId?: string;
  fingerprint?: string;
}
const idempotencyReceiptCache = new Map<string, CachedIdempotencyEntry>();

export async function getCachedReceipt(key?: string): Promise<UtilityReceipt | null> {
  if (!key) return null;
  const clean = key.trim();
  const entry = idempotencyReceiptCache.get(clean);
  if (entry) {
    if (Date.now() > entry.expiresAt) {
      idempotencyReceiptCache.delete(clean);
    } else {
      return entry.receipt;
    }
  }

  // Check persistent storage across restarts (FAIL CLOSED on database error)
  let allTx: VirtualAccountTransactionRecord[];
  try {
    allTx = await db.listVirtualAccountTransactions();
  } catch (err) {
    console.error('[sivanUtilityService] Could not check persistent idempotency cache:', err);
    throw serviceUnavailable('Database error while checking idempotency cache. Purchase halted for safety.');
  }

  const match = allTx.find((tx) => {
    if (tx.status !== 'completed') return false;
    if (tx.depositReference === clean || tx.depositId === clean) return true;
    const raw = (tx.rawPayload || {}) as any;
    return raw.idempotencyKey === clean || raw.reference === clean;
  });

  if (match) {
    const raw = (match.rawPayload || {}) as any;
    if (raw.cachedReceipt) {
      cacheReceipt(clean, raw.cachedReceipt, match.userId, raw.fingerprint);
      return raw.cachedReceipt;
    }
  }

  return null;
}

export function cacheReceipt(
  key: string | undefined,
  receipt: UtilityReceipt,
  userId?: string,
  fingerprint?: string
): void {
  if (!key) return;
  const clean = key.trim();
  idempotencyReceiptCache.set(clean, {
    receipt,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    userId,
    fingerprint,
  });
}

/**
 * Validates idempotency key ownership and payload fingerprint consistency.
 * FAILS CLOSED on database lookup errors.
 */
export async function validateAndResolveIdempotency(input: {
  idempotencyKey?: string;
  userId: string;
  serviceType: string;
  recipient: string;
  amountNgn: number;
  operatorOrDisco: string;
  planCode?: string;
}): Promise<{
  cachedReceipt: UtilityReceipt | null;
  fingerprint: string;
}> {
  const fingerprint = computePurchaseFingerprint(input);
  if (!input.idempotencyKey) {
    return { cachedReceipt: null, fingerprint };
  }

  const cleanKey = input.idempotencyKey.trim();

  // 1. In-memory fast cache check with ownership and fingerprint validation
  const entry = idempotencyReceiptCache.get(cleanKey);
  if (entry) {
    if (Date.now() <= entry.expiresAt) {
      // Cross-user reuse check
      if (entry.userId && entry.userId.toLowerCase() !== input.userId.toLowerCase()) {
        throw forbidden('Idempotency key belongs to another user.');
      }
      // Conflicting purchase parameters check
      if (entry.fingerprint && entry.fingerprint !== fingerprint) {
        throw conflict('Idempotency key reused with conflicting purchase parameters.');
      }
      return { cachedReceipt: entry.receipt, fingerprint };
    } else {
      idempotencyReceiptCache.delete(cleanKey);
    }
  }

  // 2. Persistent storage validation (FAIL CLOSED on database error)
  let allTx: VirtualAccountTransactionRecord[];
  try {
    allTx = await db.listVirtualAccountTransactions();
  } catch (dbErr) {
    console.error('[sivanUtilityService] Could not check persistent idempotency records:', dbErr);
    throw serviceUnavailable('Database error while verifying idempotency records. Purchase halted for safety.');
  }

  const match = allTx.find(
    (tx) => tx.depositReference === cleanKey || tx.depositId === cleanKey || ((tx.rawPayload as any)?.idempotencyKey === cleanKey)
  );

  if (match) {
    const raw = (match.rawPayload || {}) as any;

    // Cross-user reuse check
    if (match.userId && match.userId.toLowerCase() !== input.userId.toLowerCase()) {
      throw forbidden('Idempotency key belongs to another user.');
    }

    // Conflicting purchase parameters check
    const storedFingerprint = raw.fingerprint || (raw.cachedReceipt as any)?.fingerprint;
    if (storedFingerprint && storedFingerprint !== fingerprint) {
      throw conflict('Idempotency key reused with conflicting purchase parameters.');
    }

    // Status check
    if (match.status === 'completed') {
      if (raw.cachedReceipt) {
        cacheReceipt(cleanKey, raw.cachedReceipt, match.userId, storedFingerprint);
        return { cachedReceipt: raw.cachedReceipt, fingerprint };
      }
    } else if (
      match.status === 'submitted' ||
      match.status === ('pending_reconciliation' as any) ||
      match.status === ('delivery_confirmed_unsettled' as any)
    ) {
      throw conflict(`A purchase with this idempotency key is already in flight or pending settlement (status: ${match.status}).`);
    }
  }

  return { cachedReceipt: null, fingerprint };
}

/**
 * Atomic and durable balance reservation:
 * 1. Checks available balance against ledger and active reservations.
 * 2. Persists durable pending reservation record in database (fail-closed if DB write fails).
 * 3. Persists durable ledger hold entry (fail-closed if write fails, rolling back reservation).
 * 4. Preserves unknown outcomes: timeouts retain the hold and transition to pending_reconciliation.
 * 5. Rejection releases hold atomically.
 */
async function withBalanceReservation<T>(
  resolvedUserId: string,
  amountNgn: number,
  reservationId: string,
  serviceType: string,
  fingerprint: string,
  idempotencyKey: string | undefined,
  input: {
    recipient: string;
    operatorOrDisco: string;
    planCode?: string;
  },
  work: (availableBalance: number) => Promise<T>
): Promise<T> {
  let available = 0;
  const reservationRecordId = `vatx_res_${crypto.createHash('sha256').update(reservationId).digest('hex').slice(0, 24)}`;
  const now = new Date().toISOString();

  // 1. Critical section under distributed lock (PostgreSQL pg_advisory_xact_lock in production, mutex in tests)
  const cached = await runWithUserLock(resolvedUserId, async () => {
    // A. Validate idempotency INSIDE the lock to close any TOCTOU race window
    const idCheck = await validateAndResolveIdempotency({
      idempotencyKey,
      userId: resolvedUserId,
      serviceType,
      recipient: input.recipient,
      amountNgn,
      operatorOrDisco: input.operatorOrDisco,
      planCode: input.planCode,
    });
    if (idCheck.cachedReceipt) {
      return idCheck.cachedReceipt;
    }

    // B. Calculate current spendable balance
    available = await getUserNgnBalance(resolvedUserId);

    if (available < amountNgn) {
      throw badRequest(
        `Insufficient balance (${available.toLocaleString()} NGN). You need ${amountNgn.toLocaleString()} NGN for this purchase. Please deposit NGN into your Sivan account.`
      );
    }

    // C. Persist durable DB reservation record (fail-closed)
    try {
      await db.upsertVirtualAccountTransactionRecord({
        id: reservationRecordId,
        provider: 'paystack',
        depositId: reservationId,
        userId: resolvedUserId,
        sourceCurrency: 'ngn',
        destinationCurrency: 'ngn',
        sourceAmount: amountNgn.toFixed(2),
        destinationAmount: (-amountNgn).toFixed(2),
        paymentRail: 'utility_reservation',
        status: 'submitted',
        depositReference: idempotencyKey || reservationId,
        rawPayload: {
          service: serviceType,
          amountNgn,
          expiresAt: Date.now() + 5 * 60 * 1000,
          idempotencyKey,
          fingerprint,
        },
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      console.error('[sivanUtilityService] Could not persist durable reservation record to DB:', err);
      throw new Error(`Failed to persist balance reservation to database: ${err instanceof Error ? err.message : String(err)}. Purchase halted.`);
    }

    // D. Persist durable ledger hold entry (fail-closed)
    try {
      await createBalanceLedgerEntry(
        {
          userId: resolvedUserId,
          asset: 'ngn',
          amount: amountNgn.toFixed(2),
          kind: 'hold',
          status: 'completed',
          sourceType: 'utility_reservation',
          sourceId: reservationId,
          description: `In-flight utility reservation: ${amountNgn} NGN`,
          transferId: reservationId,
        },
        { actorType: 'system', actorId: resolvedUserId }
      );
    } catch (err) {
      console.error('[sivanUtilityService] Could not persist balance ledger hold:', err);
      try {
        await db.upsertVirtualAccountTransactionRecord({
          id: reservationRecordId,
          provider: 'paystack',
          depositId: reservationId,
          userId: resolvedUserId,
          sourceCurrency: 'ngn',
          destinationCurrency: 'ngn',
          sourceAmount: amountNgn.toFixed(2),
          destinationAmount: '0.00',
          paymentRail: 'utility_reservation',
          status: 'failed',
          depositReference: idempotencyKey || reservationId,
          createdAt: now,
          updatedAt: new Date().toISOString(),
        });
      } catch {}
      throw new Error(`Failed to persist balance ledger hold: ${err instanceof Error ? err.message : String(err)}. Purchase halted.`);
    }

    return null;
  });

  if (cached) {
    return cached as unknown as T;
  }

  // 2. Dispatch work outside the reservation lock and preserve three-way outcome
  let workResult: T;
  try {
    workResult = await work(available);
  } catch (err: any) {
    if (isAuthoritativeRejection(err)) {
      // Branch A: Confirmed Rejection
      // Release reservation record and atomically release ledger hold
      try {
        await db.upsertVirtualAccountTransactionRecord({
          id: reservationRecordId,
          provider: 'paystack',
          depositId: reservationId,
          userId: resolvedUserId,
          sourceCurrency: 'ngn',
          destinationCurrency: 'ngn',
          sourceAmount: amountNgn.toFixed(2),
          destinationAmount: '0.00',
          paymentRail: 'utility_reservation',
          status: 'failed',
          depositReference: idempotencyKey || reservationId,
          rawPayload: {
            service: serviceType,
            amountNgn,
            idempotencyKey,
            fingerprint,
            error: err?.message || String(err),
          },
          createdAt: now,
          updatedAt: new Date().toISOString(),
        });
      } catch {}

      try {
        await createBalanceLedgerEntry(
          {
            userId: resolvedUserId,
            asset: 'ngn',
            amount: amountNgn.toFixed(2),
            kind: 'hold_release',
            status: 'completed',
            sourceType: 'utility_reservation',
            sourceId: reservationId,
            description: `Release rejected utility reservation: ${amountNgn} NGN`,
            transferId: `rel_${reservationId}`,
          },
          { actorType: 'system', actorId: resolvedUserId }
        );
      } catch (relErr) {
        console.error('[sivanUtilityService] Failed to release hold on rejected utility purchase:', relErr);
      }

      throw err;
    } else {
      // Branch B: Unknown outcome (timeouts, 5xx server errors, unhandled exceptions, socket drops)
      // DEFAULT TO SAFE UNKNOWN: Retain the hold! Mark as pending_reconciliation
      try {
        await db.upsertVirtualAccountTransactionRecord({
          id: reservationRecordId,
          provider: 'paystack',
          depositId: reservationId,
          userId: resolvedUserId,
          sourceCurrency: 'ngn',
          destinationCurrency: 'ngn',
          sourceAmount: amountNgn.toFixed(2),
          destinationAmount: (-amountNgn).toFixed(2), // Hold is preserved!
          paymentRail: 'utility_reservation',
          status: 'pending_reconciliation' as any,
          depositReference: idempotencyKey || reservationId,
          rawPayload: {
            service: serviceType,
            amountNgn,
            idempotencyKey,
            fingerprint,
            error: err?.message || String(err),
            heldAt: new Date().toISOString(),
          },
          createdAt: now,
          updatedAt: new Date().toISOString(),
        });
      } catch (recErr) {
        console.error('[sivanUtilityService] Failed to mark reservation pending_reconciliation:', recErr);
      }

      await createSystemIncident({
        provider: 'utility_aggregator',
        affectedService: 'virtual_accounts',
        severity: 'critical',
        message: `Utility purchase outcome unknown for user ${resolvedUserId} (${amountNgn} NGN). Balance held pending reconciliation. Error: ${err?.message || String(err)}`,
        createdBy: 'utility_outcome_guard',
        metadata: {
          reservationId,
          userId: resolvedUserId,
          amountNgn,
          service: serviceType,
          error: err?.message || String(err),
        },
      }).catch(() => null);

      throw badRequest(
        `Purchase outcome unconfirmed with network. Your balance of ${amountNgn.toLocaleString()} NGN is held safely while we verify fulfillment. Ref: ${reservationId}`
      );
    }
  }

  // Branch C: Confirmed Fulfilled
  // Mark reservation completed in DB
  try {
    await db.upsertVirtualAccountTransactionRecord({
      id: reservationRecordId,
      provider: 'paystack',
      depositId: reservationId,
      userId: resolvedUserId,
      sourceCurrency: 'ngn',
      destinationCurrency: 'ngn',
      sourceAmount: amountNgn.toFixed(2),
      destinationAmount: '0.00',
      paymentRail: 'utility_reservation',
      status: 'completed',
      depositReference: idempotencyKey || reservationId,
      rawPayload: {
        service: serviceType,
        amountNgn,
        idempotencyKey,
        fingerprint,
      },
      createdAt: now,
      updatedAt: new Date().toISOString(),
    });
  } catch {}

  return workResult;
}
import type { VirtualAccountTransactionRecord } from '../../virtual-accounts/types/virtual-account.types.js';
import { getUtilityDataPlanBySize, resolveProviderPlanCode } from './utility-data-plans.service.js';
import { getUtilitiesControls, recordUtilityTransaction } from '../../admin/feature-controls.service.js';

export {
  getUtilityProvider,
  registerUtilityProvider,
  listUtilityProviders,
  getActiveUtilityProviderName,
  executeUtilityWithFailover,
  getUtilityProviderChain,
  IUtilityProvider,
};

const MIN_AIRTIME_NGN = 100;
const MAX_AIRTIME_NGN = 50_000;
const MIN_ELECTRICITY_NGN = 1_000;
const MAX_ELECTRICITY_NGN = 100_000;

function formatTimestamp(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' });
}

async function resolvePaymentUserId(target: string): Promise<string> {
  if (!target) return target;
  const rawClean = target.trim().replace(/^whatsapp:\+?/, '').replace(/^\+/, '');
  const withPlus = `+${rawClean}`;
  const withWhatsapp = `whatsapp:+${rawClean}`;

  const directUser = await db.findUserById(target).catch(() => null);
  if (directUser) return directUser.id;

  const phoneVariants: string[] = [withPlus, withWhatsapp, rawClean];
  if (rawClean.startsWith('234') && rawClean.length === 13) {
    const local0 = `0${rawClean.slice(3)}`;
    phoneVariants.push(local0, `whatsapp:${local0}`);
  } else if (rawClean.startsWith('0') && rawClean.length === 11) {
    const intl = `234${rawClean.slice(1)}`;
    phoneVariants.push(`+${intl}`, intl, `whatsapp:+${intl}`);
  }

  for (const variant of phoneVariants) {
    const user = await db.findUserByWhatsappNumber(variant).catch(() => null);
    if (user) return user.id;
  }

  if (target.includes('@')) {
    const userByEmail = await db.findUserByEmail(target.trim().toLowerCase()).catch(() => null);
    if (userByEmail) return userByEmail.id;
  }

  if (rawClean) {
    const userByTg = await db.findUserByTelegramUserId(rawClean).catch(() => null);
    if (userByTg) return userByTg.id;
  }

  const userByTarget = await db.findUserByTarget(target).catch(() => null);
  if (userByTarget) return userByTarget.id;

  const identityLinks = await db.listCustomerIdentityLinks().catch(() => []);
  const link = identityLinks.find(
    (l) => l.status === 'linked' && (
      phoneVariants.includes(l.whatsappNumber || '') ||
      phoneVariants.includes(l.telegramUserId || '') ||
      l.telegramUserId === rawClean ||
      l.email?.toLowerCase() === target.trim().toLowerCase()
    )
  );
  if (link?.paymentUserId) return link.paymentUserId;

  return target;
}

/**
 * Calculates current spendable NGN balance for a user from their virtual account ledger.
 */
export async function getUserNgnBalance(userId: string): Promise<number> {
  const resolvedUserId = await resolvePaymentUserId(userId).catch(() => userId);
  let available = 0;
  try {
    const unified = await getUnifiedBalance(resolvedUserId, true);
    const ngnBal = (unified.balances as any[]).find((b) => String(b.asset).toLowerCase() === 'ngn');
    available = Number(ngnBal?.availableBalance ?? ngnBal?.spendable ?? 0);
  } catch (_err) {
    available = 0;
  }

  const allTx = await db.listVirtualAccountTransactions().catch(() => []);
  const userTxs = allTx.filter((tx) => (tx.userId === resolvedUserId || tx.userId === userId));

  let txBalance = 0;
  const nowMs = Date.now();
  for (const tx of userTxs) {
    if (tx.status === 'completed') {
      txBalance += Number(tx.destinationAmount || 0);
    } else if (tx.status === 'submitted' && tx.paymentRail === 'utility_reservation') {
      const createdAtMs = new Date(tx.createdAt).getTime();
      const expiresAtMs = (tx.rawPayload as any)?.expiresAt || (createdAtMs + 5 * 60 * 1000);
      if (nowMs < expiresAtMs) {
        // destinationAmount is negative (-amountNgn)
        txBalance += Number(tx.destinationAmount || 0);
      }
    } else if (tx.status === ('pending_reconciliation' as any) && tx.paymentRail === 'utility_reservation') {
      txBalance += Number(tx.destinationAmount || 0);
    } else if (tx.status === ('delivery_confirmed_unsettled' as any)) {
      txBalance += Number(tx.destinationAmount || 0);
    }
  }
  const cleanTxBalance = Math.max(0, Math.round(txBalance * 100) / 100);

  if (available > 0 && cleanTxBalance > 0) {
    return Math.min(available, cleanTxBalance);
  }
  return available > 0 ? available : cleanTxBalance;
}

/**
 * Lists available data plans for a given telco operator through the active or preferred utility provider.
 */
export async function fetchDataPlans(
  operator: TelcoOperator,
  preferredProviderName?: string
): Promise<DataPlanOption[]> {
  await ensureUtilityRoutingLoaded();
  if (preferredProviderName) {
    const provider = getUtilityProvider(preferredProviderName);
    if (!provider.listDataPlans) {
      throw badRequest(`Provider "${preferredProviderName}" does not publish a data plan catalogue.`);
    }
    return provider.listDataPlans(operator);
  }
  const { result } = await executeForService('data', 'listDataPlans', (provider) =>
    provider.listDataPlans(operator)
  );
  return result;
}

/**
 * Records an atomic debit transaction on the user's ledger and updates balance ledger.
 */
async function recordUtilityDebit(input: {
  userId: string;
  providerName: string;
  serviceType: string;
  reference: string;
  amountNgn: number;
  reservationId?: string;
  idempotencyKey?: string;
  rawPayload: unknown;
}): Promise<void> {
  const resolvedUserId = await resolvePaymentUserId(input.userId).catch(() => input.userId);
  const user = await db.findUserById(resolvedUserId).catch(() => null);
  const isPostgres = (process.env.DATABASE_PROVIDER || '').toLowerCase() === 'postgres';
  // In PostgreSQL, user_id must be a valid user ID (or undefined) to satisfy foreign key constraint
  const validUserId = user ? user.id : (isPostgres ? (resolvedUserId.startsWith('usr_') ? resolvedUserId : undefined) : resolvedUserId);

  let virtualAccountId: string | undefined = undefined;
  if (validUserId) {
    const vas = await db.listVirtualAccounts().catch(() => []);
    const userVa = vas.find((va) => va.userId === validUserId && va.status === 'active');
    if (userVa) {
      virtualAccountId = userVa.id;
    }
  }

  const now = new Date().toISOString();
  const txRecord: VirtualAccountTransactionRecord = {
    id: `vatx_debit_${crypto.createHash('sha256').update(input.reference).digest('hex').slice(0, 24)}`,
    provider: 'paystack',
    virtualAccountId,
    depositId: input.reference,
    userId: validUserId,
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: input.amountNgn.toFixed(2),
    destinationAmount: (-input.amountNgn).toFixed(2), // Debit is recorded as negative
    paymentRail: `utility_${input.providerName}_${input.serviceType}`,
    status: 'completed',
    depositReference: input.idempotencyKey || input.reference,
    rawPayload: input.rawPayload,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  };

  try {
    await db.upsertVirtualAccountTransactionRecord(txRecord);
  } catch (err) {
    console.warn('[sivanUtilityService] Failed to upsert virtual account transaction record:', err);
    // If it failed due to foreign key or constraint, retry with null userId/virtualAccountId so the transaction audit record is preserved
    if (txRecord.userId || txRecord.virtualAccountId) {
      txRecord.userId = undefined;
      txRecord.virtualAccountId = undefined;
      await db.upsertVirtualAccountTransactionRecord(txRecord).catch((retryErr) => {
        console.error('[sivanUtilityService] Critical: failed fallback virtual account transaction upsert:', retryErr);
        throw retryErr;
      });
    } else {
      throw err;
    }
  }

  // Record in unified balance ledger - consumes the hold using matching reservation sourceId
  if (validUserId) {
    await createBalanceLedgerEntry(
      {
        userId: validUserId,
        asset: 'ngn',
        amount: input.amountNgn.toFixed(2),
        kind: 'debit_transfer',
        status: 'completed',
        sourceType: 'utility_reservation',
        sourceId: input.reservationId || input.reference,
        description: `Utility purchase (${input.serviceType}) via ${input.providerName.toUpperCase()}: ${input.amountNgn} NGN`,
        transferId: input.reference,
      },
      { actorType: 'user', actorId: validUserId }
    ).catch((err) => {
      console.warn('[sivanUtilityService] Failed to record ledger entry for utility purchase:', err);
    });
  }
}

/**
 * Executes airtime purchase through active utility provider with phone normalization and telco detection.
 */
export async function executeAirtimePurchase(
  req: AirtimePurchaseRequest
): Promise<UtilityReceipt> {
  const controls = await getUtilitiesControls();
  if (!controls.enabled || controls.maintenanceMode) {
    throw badRequest(controls.maintenanceReason || 'Bill payment services are currently undergoing scheduled maintenance.');
  }
  if (!controls.airtimeEnabled) {
    throw badRequest('Airtime top-up service is currently disabled.');
  }

  const normalizedPhone = normalizeDomesticPhone(req.phone);
  const operator: TelcoOperator | undefined = req.operator || detectTelcoOperator(normalizedPhone);

  if (!operator) {
    throw badRequest(
      `Could not automatically detect the telco network for ${req.phone}. Please specify your network: MTN, Airtel, Glo, or 9mobile.`
    );
  }

  if (req.amountNgn < MIN_AIRTIME_NGN || req.amountNgn > MAX_AIRTIME_NGN) {
    throw badRequest(
      `Airtime amount must be between ${MIN_AIRTIME_NGN.toLocaleString()} NGN and ${MAX_AIRTIME_NGN.toLocaleString()} NGN.`
    );
  }

  const resolvedUserId = await resolvePaymentUserId(req.userId).catch(() => req.userId);

  const { cachedReceipt, fingerprint } = await validateAndResolveIdempotency({
    idempotencyKey: req.idempotencyKey,
    userId: resolvedUserId,
    serviceType: 'airtime',
    recipient: normalizedPhone,
    amountNgn: req.amountNgn,
    operatorOrDisco: operator,
  });
  if (cachedReceipt) return cachedReceipt;

  const reservationId = req.idempotencyKey
    ? `res_${req.idempotencyKey}`
    : `res_${crypto.randomUUID()}`;

  return withBalanceReservation(
    resolvedUserId,
    req.amountNgn,
    reservationId,
    'airtime',
    fingerprint,
    req.idempotencyKey,
    {
      recipient: normalizedPhone,
      operatorOrDisco: operator,
    },
    async (balance) => {
    // 2 & 3. Upstream fulfilment through the chain configured for airtime
    await ensureUtilityRoutingLoaded();
    const airtimeKey = req.idempotencyKey
      ? `sivan_airtime_${req.idempotencyKey}`
      : newIdempotencyKey('airtime', resolvedUserId);
    const { result, providerName } = await executeForService(
      'airtime',
      'purchaseAirtime',
      (provider) => provider.purchaseAirtime(normalizedPhone, req.amountNgn, operator, airtimeKey),
      { costNgn: req.amountNgn }
    );

    const now = new Date().toISOString();
    const remaining = balance - req.amountNgn;

    const formattedText = [
      'Sivan Payment Ai . Airtime Receipt',
      '----------------------------------------',
      `Operator: ${operator.toUpperCase()}`,
      `Recipient: ${normalizedPhone}`,
      `Amount: ${req.amountNgn.toLocaleString()} NGN`,
      'Platform Fee: 0 NGN (Free)',
      `Total Debited: ${req.amountNgn.toLocaleString()} NGN`,
      `Remaining Balance: ${remaining.toLocaleString()} NGN`,
      `Fulfillment Rail: ${providerName.toUpperCase()}`,
      `Status: Delivered Successfully`,
      `Reference: ${result.reference}`,
      `Date: ${formatTimestamp(now)}`,
      '----------------------------------------',
    ].join('\n');

    const receipt: UtilityReceipt = {
      success: true,
      serviceType: 'airtime',
      providerName,
      operatorOrDisco: operator.toUpperCase(),
      recipientOrMeter: normalizedPhone,
      amountNgn: req.amountNgn,
      feeNgn: 0,
      totalDebitedNgn: req.amountNgn,
      reference: result.reference,
      timestamp: now,
      formattedText,
    };
    cacheReceipt(req.idempotencyKey, receipt, resolvedUserId, fingerprint);

    // 4. Atomic ledger debit with recoverable incident logging
    try {
      await recordUtilityDebit({
        userId: resolvedUserId,
        providerName,
        serviceType: 'airtime',
        reference: result.reference,
        amountNgn: req.amountNgn,
        reservationId,
        idempotencyKey: req.idempotencyKey,
        rawPayload: {
          ...(typeof result.rawPayload === 'object' && result.rawPayload !== null ? result.rawPayload : {}),
          idempotencyKey: req.idempotencyKey,
          fingerprint,
          cachedReceipt: receipt,
        },
      });

      await recordUtilityTransaction({
        id: result.reference,
        category: 'airtime',
        provider: providerName,
        serviceId: operator,
        accountOrPhone: normalizedPhone,
        amountNgn: req.amountNgn,
        amountUsdc: 0,
        channel: (req.channel as any) || 'webapp',
        userAddressOrId: resolvedUserId,
        tokenOrReceipt: result.reference,
        status: 'success',
      }).catch(() => null);
    } catch (dbErr: any) {
      console.error(
        `[sivanUtilityService] CRITICAL: Airtime vended upstream (${result.reference}) but post-delivery ledger recording failed:`,
        dbErr
      );

      // Recoverable Accounting Failure:
      // Update transaction status to delivery_confirmed_unsettled and retain hold
      try {
        await db.upsertVirtualAccountTransactionRecord({
          id: `vatx_unsettled_${crypto.createHash('sha256').update(result.reference).digest('hex').slice(0, 24)}`,
          provider: providerName as any,
          depositId: result.reference,
          userId: resolvedUserId,
          sourceCurrency: 'ngn',
          destinationCurrency: 'ngn',
          sourceAmount: req.amountNgn.toFixed(2),
          destinationAmount: (-req.amountNgn).toFixed(2), // Hold remains active
          paymentRail: `utility_${providerName}_airtime`,
          status: 'delivery_confirmed_unsettled' as any,
          depositReference: req.idempotencyKey || result.reference,
          rawPayload: {
            service: 'airtime',
            operator,
            phone: normalizedPhone,
            amountNgn: req.amountNgn,
            reservationId,
            idempotencyKey: req.idempotencyKey,
            fingerprint,
            cachedReceipt: receipt,
            dbError: dbErr instanceof Error ? dbErr.message : String(dbErr),
          },
          createdAt: now,
          updatedAt: now,
        });
      } catch (txErr) {
        console.error('[sivanUtilityService] Failed to record delivery_confirmed_unsettled record:', txErr);
      }

      await createSystemIncident({
        provider: providerName,
        affectedService: 'virtual_accounts',
        severity: 'critical',
        message: `Post-delivery utility recording failed for airtime reference ${result.reference} (${req.amountNgn} NGN). Delivery succeeded upstream. Transaction marked delivery_confirmed_unsettled.`,
        createdBy: 'utility_service_recovery',
        metadata: {
          service: 'airtime',
          reference: result.reference,
          phone: normalizedPhone,
          operator,
          amountNgn: req.amountNgn,
          userId: resolvedUserId,
          error: dbErr instanceof Error ? dbErr.message : String(dbErr),
        },
      }).catch(() => null);
    }

    return receipt;
  });
}

/**
 * Executes data bundle purchase through active utility provider.
 */
export async function executeDataPurchase(
  req: DataBundlePurchaseRequest
): Promise<UtilityReceipt> {
  const controls = await getUtilitiesControls();
  if (!controls.enabled || controls.maintenanceMode) {
    throw badRequest(controls.maintenanceReason || 'Bill payment services are currently undergoing scheduled maintenance.');
  }
  if (!controls.dataEnabled) {
    throw badRequest('Mobile data service is currently disabled.');
  }

  const normalizedPhone = normalizeDomesticPhone(req.phone);
  const operator = req.operator || detectTelcoOperator(normalizedPhone);

  if (!operator) {
    throw badRequest(`Please specify a valid telco operator: MTN, Airtel, Glo, or 9mobile.`);
  }

  // The catalogue is authoritative for price. Previously an unknown planCode
  // fell through to the client-supplied amountNgn, so a caller could pay 500
  // for a 430 bundle, or name a plan that does not exist and set its own price.
  const bundlePlan = await getUtilityDataPlanBySize(req.planCode, operator);
  if (!bundlePlan) {
    throw badRequest(
      `No data plan "${req.planCode}" is configured for ${operator.toUpperCase()}. ` +
        `An admin must add it in the admin hub before it can be sold.`
    );
  }
  const amountNgn = bundlePlan.amountNgn;

  if (amountNgn <= 0) {
    throw badRequest('Invalid data bundle amount.');
  }

  const resolvedUserId = await resolvePaymentUserId(req.userId).catch(() => req.userId);

  const { cachedReceipt, fingerprint } = await validateAndResolveIdempotency({
    idempotencyKey: req.idempotencyKey,
    userId: resolvedUserId,
    serviceType: 'data',
    recipient: normalizedPhone,
    amountNgn,
    operatorOrDisco: operator,
    planCode: bundlePlan.bundleSize,
  });
  if (cachedReceipt) return cachedReceipt;

  const reservationId = req.idempotencyKey
    ? `res_${req.idempotencyKey}`
    : `res_${crypto.randomUUID()}`;

  return withBalanceReservation(
    resolvedUserId,
    amountNgn,
    reservationId,
    'data',
    fingerprint,
    req.idempotencyKey,
    {
      recipient: normalizedPhone,
      operatorOrDisco: operator,
      planCode: bundlePlan.bundleSize,
    },
    async (balance) => {
    await ensureUtilityRoutingLoaded();
    const dataKey = req.idempotencyKey
      ? `sivan_data_${req.idempotencyKey}`
      : newIdempotencyKey('data', resolvedUserId);
    let dispatchedPlanCode = '';
    const { result, providerName } = await executeForService('data', 'purchaseDataBundle', (provider) => {
      // Each provider has its own plan namespace, so translate before dispatch.
      // Refusing here is deliberate: sending Sivan's own code upstream is what
      // made SME API data purchases fail.
      const providerPlanCode = resolveProviderPlanCode(bundlePlan, provider.name);
      if (!providerPlanCode) {
        throw badRequest(
          `Data plan "${bundlePlan.bundleSize}" (${bundlePlan.network}) has no plan code mapped for ` +
            `provider "${provider.name}". Map it in the admin hub, or route data to a provider that has one.`
        );
      }
      dispatchedPlanCode = providerPlanCode;
      return provider.purchaseDataBundle(normalizedPhone, providerPlanCode, amountNgn, operator, dataKey);
    },
    typeof bundlePlan.costPriceNgn === 'number' ? { costNgn: bundlePlan.costPriceNgn } : {});

    const now = new Date().toISOString();
    const remaining = balance - amountNgn;

    const formattedText = [
      'Sivan Payment Ai . Mobile Data Receipt',
      '----------------------------------------',
      `Operator: ${operator.toUpperCase()}`,
      `Plan: ${bundlePlan.bundleSize} (${bundlePlan.network.toUpperCase()})`,
      `Provider Plan: ${dispatchedPlanCode}`,
      `Recipient: ${normalizedPhone}`,
      `Amount: ${amountNgn.toLocaleString()} NGN`,
      'Platform Fee: 0 NGN (Free)',
      `Total Debited: ${amountNgn.toLocaleString()} NGN`,
      `Remaining Balance: ${remaining.toLocaleString()} NGN`,
      `Fulfillment Rail: ${providerName.toUpperCase()}`,
      `Status: Activated Successfully`,
      `Reference: ${result.reference}`,
      `Date: ${formatTimestamp(now)}`,
      '----------------------------------------',
    ].join('\n');

    const receipt: UtilityReceipt = {
      success: true,
      serviceType: 'data',
      providerName,
      operatorOrDisco: operator.toUpperCase(),
      recipientOrMeter: normalizedPhone,
      amountNgn,
      feeNgn: 0,
      totalDebitedNgn: amountNgn,
      reference: result.reference,
      timestamp: now,
      formattedText,
    };
    cacheReceipt(req.idempotencyKey, receipt, resolvedUserId, fingerprint);

    // 4. Atomic ledger debit with recoverable incident logging
    try {
      await recordUtilityDebit({
        userId: resolvedUserId,
        providerName,
        serviceType: 'data',
        reference: result.reference,
        amountNgn,
        reservationId,
        idempotencyKey: req.idempotencyKey,
        rawPayload: {
          ...(typeof result.rawPayload === 'object' && result.rawPayload !== null ? result.rawPayload : {}),
          idempotencyKey: req.idempotencyKey,
          fingerprint,
          cachedReceipt: receipt,
        },
      });

      await recordUtilityTransaction({
        id: result.reference,
        category: 'data',
        provider: providerName,
        serviceId: bundlePlan.bundleSize,
        accountOrPhone: normalizedPhone,
        amountNgn,
        amountUsdc: 0,
        channel: (req.channel as any) || 'webapp',
        userAddressOrId: resolvedUserId,
        tokenOrReceipt: result.reference,
        status: 'success',
      }).catch(() => null);
    } catch (dbErr: any) {
      console.error(
        `[sivanUtilityService] CRITICAL: Data vended upstream (${result.reference}) but post-delivery ledger recording failed:`,
        dbErr
      );

      // Transition to delivery_confirmed_unsettled and retain hold
      try {
        await db.upsertVirtualAccountTransactionRecord({
          id: `vatx_unsettled_${crypto.createHash('sha256').update(result.reference).digest('hex').slice(0, 24)}`,
          provider: providerName as any,
          depositId: result.reference,
          userId: resolvedUserId,
          sourceCurrency: 'ngn',
          destinationCurrency: 'ngn',
          sourceAmount: amountNgn.toFixed(2),
          destinationAmount: (-amountNgn).toFixed(2), // Hold remains active
          paymentRail: `utility_${providerName}_data`,
          status: 'delivery_confirmed_unsettled' as any,
          depositReference: req.idempotencyKey || result.reference,
          rawPayload: {
            service: 'data',
            operator,
            phone: normalizedPhone,
            plan: bundlePlan.bundleSize,
            amountNgn,
            reservationId,
            idempotencyKey: req.idempotencyKey,
            fingerprint,
            cachedReceipt: receipt,
            dbError: dbErr instanceof Error ? dbErr.message : String(dbErr),
          },
          createdAt: now,
          updatedAt: now,
        });
      } catch (txErr) {
        console.error('[sivanUtilityService] Failed to record delivery_confirmed_unsettled record:', txErr);
      }

      await createSystemIncident({
        provider: providerName,
        affectedService: 'virtual_accounts',
        severity: 'critical',
        message: `Post-delivery utility recording failed for data bundle reference ${result.reference} (${amountNgn} NGN). Delivery succeeded upstream. Transaction marked delivery_confirmed_unsettled.`,
        createdBy: 'utility_service_recovery',
        metadata: {
          service: 'data',
          reference: result.reference,
          phone: normalizedPhone,
          operator,
          plan: bundlePlan.bundleSize,
          amountNgn,
          userId: resolvedUserId,
          error: dbErr instanceof Error ? dbErr.message : String(dbErr),
        },
      }).catch(() => null);
    }

    return receipt;
  });
}

/**
 * Pre-flight electricity meter inquiry (fetches registered customer name).
 */
export async function executeElectricityInquiry(
  req: ElectricityInquiryRequest
): Promise<ElectricityInquiryResponse> {
  const controls = await getUtilitiesControls();
  if (!controls.enabled || controls.maintenanceMode) {
    throw badRequest(controls.maintenanceReason || 'Bill payment services are currently undergoing scheduled maintenance.');
  }
  if (!controls.electricityEnabled) {
    throw badRequest('Electricity service is currently disabled.');
  }

  if (!req.meterNumber || req.meterNumber.trim().length < 6) {
    throw badRequest('Please provide a valid electricity meter number.');
  }

  const discoName = DISCO_DISPLAY_NAMES[req.disco];
  if (!discoName) {
    throw badRequest(`Unknown electricity distribution company: ${req.disco}`);
  }

  await ensureUtilityRoutingLoaded();
  const { result: inquiry, providerName } = await executeForService(
    'electricity',
    'inquireElectricityMeter',
    (provider) => provider.inquireElectricityMeter(req.meterNumber.trim(), req.disco, req.meterType)
  );
  return {
    ...inquiry,
    discoName,
    providerName,
  };
}

/**
 * Executes electricity bill payment and returns 20-digit token for prepaid meters.
 */
export async function executeElectricityPayment(
  req: ElectricityPaymentRequest
): Promise<UtilityReceipt> {
  const controls = await getUtilitiesControls();
  if (!controls.enabled || controls.maintenanceMode) {
    throw badRequest(controls.maintenanceReason || 'Bill payment services are currently undergoing scheduled maintenance.');
  }
  if (!controls.electricityEnabled) {
    throw badRequest('Electricity service is currently disabled.');
  }

  if (req.amountNgn < MIN_ELECTRICITY_NGN || req.amountNgn > MAX_ELECTRICITY_NGN) {
    throw badRequest(
      `Electricity payment amount must be between ${MIN_ELECTRICITY_NGN.toLocaleString()} NGN and ${MAX_ELECTRICITY_NGN.toLocaleString()} NGN.`
    );
  }

  const discoName = DISCO_DISPLAY_NAMES[req.disco] || req.disco.toUpperCase();

  const resolvedUserId = await resolvePaymentUserId(req.userId).catch(() => req.userId);

  const { cachedReceipt, fingerprint } = await validateAndResolveIdempotency({
    idempotencyKey: req.idempotencyKey,
    userId: resolvedUserId,
    serviceType: 'electricity',
    recipient: req.meterNumber.trim(),
    amountNgn: req.amountNgn,
    operatorOrDisco: req.disco,
  });
  if (cachedReceipt) return cachedReceipt;

  const reservationId = req.idempotencyKey
    ? `res_${req.idempotencyKey}`
    : `res_${crypto.randomUUID()}`;

  return withBalanceReservation(
    resolvedUserId,
    req.amountNgn,
    reservationId,
    'electricity',
    fingerprint,
    req.idempotencyKey,
    {
      recipient: req.meterNumber.trim(),
      operatorOrDisco: req.disco,
    },
    async (balance) => {
    await ensureUtilityRoutingLoaded();
    const electricityKey = req.idempotencyKey
      ? `sivan_electricity_${req.idempotencyKey}`
      : newIdempotencyKey('electricity', resolvedUserId);
    const { result, providerName } = await executeForService('electricity', 'payElectricityBill', (provider) =>
      provider.payElectricityBill(
        req.meterNumber.trim(),
        req.disco,
        req.meterType,
        req.amountNgn,
        req.customerName,
        electricityKey
      )
    );

    const now = new Date().toISOString();
    const remaining = balance - req.amountNgn;

    const lines = [
      'Sivan Payment Ai . Electricity Receipt',
      '----------------------------------------',
      `DisCo: ${discoName}`,
      `Meter Number: ${req.meterNumber}`,
      `Meter Type: ${req.meterType === 'prepaid' ? 'Prepaid' : 'Postpaid'}`,
      `Customer Name: ${result.customerName}`,
    ];

    if (result.token) {
      lines.push(`Token: ${result.token}`);
    }
    if (result.units) {
      lines.push(`Units: ${result.units}`);
    }

    lines.push(
      `Amount Paid: ${req.amountNgn.toLocaleString()} NGN`,
      'Platform Fee: 0 NGN (Free)',
      `Total Debited: ${req.amountNgn.toLocaleString()} NGN`,
      `Remaining Balance: ${remaining.toLocaleString()} NGN`,
      `Fulfillment Rail: ${providerName.toUpperCase()}`,
      'Status: Payment Confirmed',
      `Reference: ${result.reference}`,
      `Date: ${formatTimestamp(now)}`,
      '----------------------------------------'
    );

    const receipt: UtilityReceipt = {
      success: true,
      serviceType: 'electricity',
      providerName,
      operatorOrDisco: discoName,
      recipientOrMeter: req.meterNumber,
      customerName: result.customerName,
      token: result.token,
      units: result.units,
      amountNgn: req.amountNgn,
      feeNgn: 0,
      totalDebitedNgn: req.amountNgn,
      reference: result.reference,
      timestamp: now,
      formattedText: lines.join('\n'),
    };
    cacheReceipt(req.idempotencyKey, receipt, resolvedUserId, fingerprint);

    // 4. Atomic ledger debit with recoverable incident logging
    try {
      await recordUtilityDebit({
        userId: resolvedUserId,
        providerName,
        serviceType: 'electricity',
        reference: result.reference,
        amountNgn: req.amountNgn,
        reservationId,
        idempotencyKey: req.idempotencyKey,
        rawPayload: {
          ...(typeof result.rawPayload === 'object' && result.rawPayload !== null ? result.rawPayload : {}),
          idempotencyKey: req.idempotencyKey,
          fingerprint,
          cachedReceipt: receipt,
        },
      });

      await recordUtilityTransaction({
        id: result.reference,
        category: 'electricity',
        provider: providerName,
        serviceId: req.disco,
        accountOrPhone: req.meterNumber,
        amountNgn: req.amountNgn,
        amountUsdc: 0,
        channel: (req.channel as any) || 'webapp',
        userAddressOrId: resolvedUserId,
        tokenOrReceipt: result.token || result.reference,
        status: 'success',
      }).catch(() => null);
    } catch (dbErr: any) {
      console.error(
        `[sivanUtilityService] CRITICAL: Electricity token vended upstream (${result.reference}) but post-delivery ledger recording failed:`,
        dbErr
      );

      // Transition to delivery_confirmed_unsettled and retain hold
      try {
        await db.upsertVirtualAccountTransactionRecord({
          id: `vatx_unsettled_${crypto.createHash('sha256').update(result.reference).digest('hex').slice(0, 24)}`,
          provider: providerName as any,
          depositId: result.reference,
          userId: resolvedUserId,
          sourceCurrency: 'ngn',
          destinationCurrency: 'ngn',
          sourceAmount: req.amountNgn.toFixed(2),
          destinationAmount: (-req.amountNgn).toFixed(2), // Hold remains active
          paymentRail: `utility_${providerName}_electricity`,
          status: 'delivery_confirmed_unsettled' as any,
          depositReference: req.idempotencyKey || result.reference,
          rawPayload: {
            service: 'electricity',
            meterNumber: req.meterNumber,
            disco: discoName,
            token: result.token,
            amountNgn: req.amountNgn,
            reservationId,
            idempotencyKey: req.idempotencyKey,
            fingerprint,
            cachedReceipt: receipt,
            dbError: dbErr instanceof Error ? dbErr.message : String(dbErr),
          },
          createdAt: now,
          updatedAt: now,
        });
      } catch (txErr) {
        console.error('[sivanUtilityService] Failed to record delivery_confirmed_unsettled record:', txErr);
      }

      await createSystemIncident({
        provider: providerName,
        affectedService: 'virtual_accounts',
        severity: 'critical',
        message: `Post-delivery utility recording failed for electricity reference ${result.reference} (${req.amountNgn} NGN). Delivery succeeded upstream. Transaction marked delivery_confirmed_unsettled.`,
        createdBy: 'utility_service_recovery',
        metadata: {
          service: 'electricity',
          reference: result.reference,
          meterNumber: req.meterNumber,
          disco: discoName,
          token: result.token,
          amountNgn: req.amountNgn,
          userId: resolvedUserId,
          error: dbErr instanceof Error ? dbErr.message : String(dbErr),
        },
      }).catch(() => null);
    }

    return receipt;
  });
}

/**
 * Reconciles and finalizes debits for utility purchases that successfully vended upstream
 * but encountered transient database errors during initial post-delivery settlement.
 */
export async function reconcileUnsettledUtilityPurchases(): Promise<{
  settled: string[];
  failed: string[];
  pendingReconciliation: string[];
}> {
  let allTx: VirtualAccountTransactionRecord[];
  try {
    allTx = await db.listVirtualAccountTransactions();
  } catch (err) {
    console.error('[reconcileUnsettled] Could not load virtual account transactions for reconciliation:', err);
    return { settled: [], failed: [], pendingReconciliation: [] };
  }

  const unsettled = allTx.filter((tx) => tx.status === ('delivery_confirmed_unsettled' as any));
  const pending = allTx.filter((tx) => tx.status === ('pending_reconciliation' as any));
  const settled: string[] = [];
  const failed: string[] = [];
  const pendingReconciliation: string[] = [];

  // 1. Settle delivery_confirmed_unsettled (post-delivery debit finalization)
  for (const tx of unsettled) {
    try {
      const raw = (tx.rawPayload || {}) as any;
      const amountNgn = Math.abs(Number(tx.sourceAmount || tx.destinationAmount || 0));
      const resolvedUserId = tx.userId;
      if (!resolvedUserId) continue;

      await recordUtilityDebit({
        userId: resolvedUserId,
        providerName: tx.provider || 'unknown',
        serviceType: raw.service || 'airtime',
        reference: tx.depositId,
        amountNgn,
        reservationId: raw.reservationId || tx.depositId,
        idempotencyKey: tx.depositReference,
        rawPayload: tx.rawPayload,
      });

      await db.upsertVirtualAccountTransactionRecord({
        ...tx,
        status: 'completed',
        destinationAmount: '0.00',
        updatedAt: new Date().toISOString(),
      });
      settled.push(tx.depositId);
    } catch (err) {
      console.error(`[reconcileUnsettled] Could not finalize debit for ${tx.depositId}:`, err);
      failed.push(tx.depositId);
    }
  }

  // 2. Track and review pending_reconciliation (timeouts / ambiguous states)
  for (const tx of pending) {
    pendingReconciliation.push(tx.depositId);
  }

  return { settled, failed, pendingReconciliation };
}

