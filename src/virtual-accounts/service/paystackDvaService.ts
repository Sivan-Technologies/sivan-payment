/**
 * PAYSTACK DVA SERVICE.
 *
 * Orchestrates the three provider calls into one re-enterable flow, and owns
 * everything the provider deliberately does not: identity lookup, persistence,
 * idempotency, and deciding what the caller should say to the user.
 *
 * WHY THIS RETURNS A STATE RATHER THAN AN ACCOUNT
 *
 * Step B is asynchronous. POST /identification returns 202 with no verdict;
 * the outcome arrives later as customeridentification.success or .failed. So
 * "give me my deposit account" has three honest answers, not one:
 *
 *   ready              an active account exists, here it is
 *   awaiting_identity  we need the user's name and BVN
 *   verifying          NIBSS is checking, we will push the result
 *   failed             NIBSS rejected, here is why
 *
 * Returning a discriminated union rather than throwing lets the chat layer
 * choose whether to hold the conversation open or reply and notify later,
 * WITHOUT that UX decision being baked into the service. Both designs are
 * legitimate and they differ per channel: Telegram can push a follow-up
 * message cheaply, a web request cannot.
 *
 * NDPR: the raw BVN enters resolveOrCreateDva(), is forwarded to Paystack,
 * and is never returned, persisted, or logged. Persistence reuses the
 * existing VirtualAccountRecord store, which has no field that can hold one.
 *
 * IDEMPOTENCY. Paystack keys customers on email, so the email is derived
 * deterministically from the user id. Re-running this flow after a dropped
 * connection returns the SAME customer instead of creating a duplicate with a
 * second bank account.
 */

import crypto from 'node:crypto';
import { db } from '../../database/json-database.js';
import { paystackMode } from '../../config/paystackConfig.js';
import {
  createCustomer,
  validateCustomerBvnNin,
  assignDedicatedAccount,
  preferredBankForMode,
  PaystackApiError,
} from '../provider/paystackDvaProvider.js';
import type { CustomerData, DvaAssignedAccount, IdentificationType } from '../types/paystackDvaTypes.js';
import type { VirtualAccountRecord } from '../types/virtual-account.types.js';

/**
 * The email domain Paystack customers are keyed under.
 *
 * Env driven, because it must resolve to a domain Sivan controls and the
 * staging and production integrations must not collide in Paystack's customer
 * namespace.
 */
function customerEmailDomain(): string {
  return (process.env.PAYSTACK_CUSTOMER_EMAIL_DOMAIN || 'user.sivantech.online').trim();
}

/**
 * Deterministic Paystack customer email for a Sivan user.
 *
 * Paystack treats email as the unique customer key, so this must be stable
 * for the life of the user and unique across them. Derived from the user id
 * rather than a real address: users onboard by chat and many have no email,
 * and a user-supplied address could collide or change.
 *
 * Test and live are namespaced apart so a staging run cannot bind a customer
 * record that production would later resolve to.
 */
export function paystackCustomerEmail(userId: string): string {
  const safe = String(userId).trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!safe) throw new Error('Cannot derive a Paystack customer email from an empty user id.');
  const prefix = paystackMode() === 'live' ? 'u' : 'test-u';
  return `${prefix}_${safe}@${customerEmailDomain()}`;
}

/** Split a single legal name into the first/last pair Paystack requires. */
export function splitLegalName(fullName: string): { first_name: string; last_name: string } {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    throw new Error('A legal name is required. Paystack uses it to name the bank account.');
  }
  if (parts.length === 1) {
    /**
     * Paystack rejects a customer with no last name, and NIBSS matches on
     * both. Refusing here produces a useful prompt instead of an opaque
     * upstream validation error.
     */
    throw new Error(
      'Please provide both first and last name exactly as registered with your bank. ' +
        'NIBSS matches the BVN against both names.'
    );
  }
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

export type DvaState =
  | { state: 'ready'; account: PublicDvaView }
  | { state: 'awaiting_identity'; reason: 'no_account' | 'not_verified' }
  | { state: 'verifying'; customerCode: string }
  | { state: 'failed'; reason: string; customerCode?: string };

/** What a chat or API surface may show. Never contains an identifier. */
export interface PublicDvaView {
  bankName: string;
  accountNumber: string;
  accountName: string;
  currency: 'NGN';
  /** false means the account exists but cannot receive money yet. */
  active: boolean;
  mode: 'live' | 'test';
}

const PROVIDER = 'paystack' as const;

function recordId(userId: string): string {
  // Deterministic, so re-running the flow updates one row instead of
  // accumulating a row per attempt.
  return `va_paystack_${crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 24)}`;
}

function toPublicView(record: VirtualAccountRecord): PublicDvaView | undefined {
  const raw = record.rawProviderPayload as any;
  const accountNumber = raw?.account_number;
  if (!accountNumber) return undefined;
  return {
    bankName: record.bankName ?? raw?.bank?.name ?? 'Bank',
    accountNumber,
    accountName: record.accountName ?? raw?.account_name ?? '',
    currency: 'NGN',
    active: record.status === 'active',
    mode: (raw?.__mode as 'live' | 'test') ?? paystackMode(),
  };
}

/** The stored Paystack DVA row for a user, if any. */
export async function findDvaRecord(userId: string): Promise<VirtualAccountRecord | undefined> {
  const all = await db.listVirtualAccounts();
  return all.find((r) => r.userId === userId && r.provider === PROVIDER);
}

/**
 * Read-only lookup. Safe to call on every "my account" message.
 *
 * Returns the stored row without touching Paystack, so the common path (a
 * returning user) costs one database read and no network call.
 */
export async function getDvaState(userId: string): Promise<DvaState> {
  const record = await findDvaRecord(userId);
  if (!record) return { state: 'awaiting_identity', reason: 'no_account' };

  const raw = record.rawProviderPayload as any;

  if (record.status === 'active') {
    const view = toPublicView(record);
    if (view) return { state: 'ready', account: view };
  }
  if (record.status === 'rejected') {
    return {
      state: 'failed',
      reason: raw?.__identificationFailureReason ?? 'Identity verification was not successful.',
      customerCode: record.customerId,
    };
  }
  if (record.status === 'provisioning' || record.status === 'under_review') {
    return { state: 'verifying', customerCode: record.customerId ?? '' };
  }
  return { state: 'awaiting_identity', reason: 'not_verified' };
}

async function persist(
  userId: string,
  patch: Partial<VirtualAccountRecord> & { rawExtra?: Record<string, unknown> }
): Promise<VirtualAccountRecord> {
  const existing = await findDvaRecord(userId);
  const now = new Date().toISOString();
  const merged: VirtualAccountRecord = {
    id: existing?.id ?? recordId(userId),
    userId,
    provider: PROVIDER,
    providerAccountId: patch.providerAccountId ?? existing?.providerAccountId ?? '',
    currency: 'ngn',
    country: 'NG',
    status: patch.status ?? existing?.status ?? 'requested',
    customerId: patch.customerId ?? existing?.customerId,
    bankName: patch.bankName ?? existing?.bankName,
    accountName: patch.accountName ?? existing?.accountName,
    accountNumberMasked: patch.accountNumberMasked ?? existing?.accountNumberMasked,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    rawProviderPayload: {
      ...((existing?.rawProviderPayload as object) ?? {}),
      ...((patch.rawProviderPayload as object) ?? {}),
      ...(patch.rawExtra ?? {}),
      __mode: paystackMode(),
    },
  };
  await db.upsertVirtualAccountRecord(merged);
  return merged;
}

export interface ResolveDvaInput {
  userId: string;
  /** Required only when no verified customer exists yet. */
  legalName?: string;
  /** EPHEMERAL. Forwarded to Paystack, never stored. */
  identifier?: string;
  identifierType?: IdentificationType;
  phone?: string;
}

/**
 * The single entry point: return the account, or advance the flow one step.
 *
 * Safe to call repeatedly. Each call does the least work that moves the user
 * forward, and never repeats a step that already succeeded.
 */
export async function resolveOrCreateDva(input: ResolveDvaInput): Promise<DvaState> {
  const { userId } = input;
  if (!userId) throw new Error('resolveOrCreateDva requires a userId.');

  // 1. Already have it? Cheapest path, no network.
  const current = await getDvaState(userId);
  if (current.state === 'ready' || current.state === 'verifying') return current;

  // 2. Need identity details before anything can be created.
  if (!input.legalName || !input.identifier) {
    return { state: 'awaiting_identity', reason: current.state === 'failed' ? 'not_verified' : 'no_account' };
  }

  const { first_name, last_name } = splitLegalName(input.legalName);
  const email = paystackCustomerEmail(userId);

  // 3. Customer record. Paystack returns the existing one for a known email,
  //    so this is safe to re-run.
  let customer: CustomerData;
  try {
    customer = await createCustomer({
      email,
      first_name,
      last_name,
      phone: input.phone ?? '',
      metadata: { sivanUserId: userId },
    });
  } catch (error) {
    return {
      state: 'failed',
      reason: error instanceof PaystackApiError
        ? (error.paystackMessage ?? 'Could not create your customer record.')
        : 'Could not create your customer record.',
    };
  }

  try {
    const now = new Date().toISOString();
    await db.insertCustomerRecord({
      id: customer.customer_code,
      userId,
      provider: PROVIDER,
      providerCustomerId: customer.customer_code,
      customerType: 'individual',
      kycStatus: 'pending',
      tosStatus: 'approved',
      createdAt: now,
      updatedAt: now,
    });
  } catch (_ignored) {
    // Already created on prior step or idempotent re-entry
  }

  await persist(userId, {
    customerId: customer.customer_code,
    status: 'under_review',
    rawExtra: { customer_code: customer.customer_code },
  });

  // 4. Submit identity to NIBSS. Returns ACCEPTANCE, not a verdict.
  try {
    await validateCustomerBvnNin(customer.customer_code, {
      country: 'NG',
      type: input.identifierType ?? 'bvn',
      value: input.identifier,
      first_name,
      last_name,
    });
  } catch (error) {
    const reason = error instanceof PaystackApiError
      ? (error.paystackMessage ?? error.message)
      : String((error as Error)?.message ?? error);

    /**
     * A customer already validated on a previous attempt is NOT a failure.
     * Paystack rejects a repeat identification, and treating that as fatal
     * would strand a user who dropped connection after step B.
     */
    if (/already|has been verified|identified/i.test(reason)) {
      return assignAndPersist(userId, customer.customer_code);
    }
    await persist(userId, { status: 'rejected', rawExtra: { __identificationFailureReason: reason } });
    return { state: 'failed', reason, customerCode: customer.customer_code };
  }

  await persist(userId, { status: 'provisioning' });

  /**
   * Deliberately NOT assigning the account here.
   *
   * The 202 means NIBSS has started, not finished. Assigning now would issue
   * a bank account to an unverified customer, which is exactly the CBN
   * requirement step B exists to satisfy. The webhook handler calls
   * completeAfterIdentification() when customeridentification.success lands.
   */
  return { state: 'verifying', customerCode: customer.customer_code };
}

/**
 * Called by the webhook handler on customeridentification.success.
 *
 * Separated so the assignment happens only after a real verdict, and so it
 * can be retried independently if Paystack is briefly unavailable at the
 * moment the webhook arrives.
 */
export async function completeAfterIdentification(
  userId: string,
  customerCode: string
): Promise<DvaState> {
  return assignAndPersist(userId, customerCode);
}

/** Called by the webhook handler on customeridentification.failed. */
export async function recordIdentificationFailure(
  userId: string,
  reason: string
): Promise<DvaState> {
  await persist(userId, { status: 'rejected', rawExtra: { __identificationFailureReason: reason } });
  return { state: 'failed', reason };
}

async function assignAndPersist(userId: string, customerCode: string): Promise<DvaState> {
  // An account may already exist from a previous attempt or a retried webhook.
  const existing = await findDvaRecord(userId);
  if (existing?.status === 'active') {
    const view = toPublicView(existing);
    if (view) return { state: 'ready', account: view };
  }

  let account: DvaAssignedAccount;
  try {
    account = await assignDedicatedAccount({
      customer: customerCode,
      preferred_bank: preferredBankForMode(),
    });
  } catch (error) {
    const reason = error instanceof PaystackApiError
      ? (error.paystackMessage ?? error.message)
      : String((error as Error)?.message ?? error);

    /** Paystack refuses a second account for one customer. That is success. */
    if (/already has a dedicated/i.test(reason)) {
      const again = await findDvaRecord(userId);
      const view = again ? toPublicView(again) : undefined;
      if (view) return { state: 'ready', account: view };
    }
    await persist(userId, { status: 'rejected', rawExtra: { __identificationFailureReason: reason } });
    return { state: 'failed', reason, customerCode };
  }

  /**
   * assigned-but-inactive is a real Paystack state and it must not be shown
   * as usable: a deposit to an inactive account goes nowhere.
   */
  const record = await persist(userId, {
    customerId: customerCode,
    providerAccountId: String(account.id),
    status: account.active ? 'active' : 'provisioning',
    bankName: account.bank?.name,
    accountName: account.account_name,
    accountNumberMasked: `****${account.account_number.slice(-4)}`,
    rawProviderPayload: account as unknown as Record<string, unknown>,
  });

  if (!account.active) {
    return { state: 'verifying', customerCode };
  }
  const view = toPublicView(record);
  return view ? { state: 'ready', account: view } : { state: 'verifying', customerCode };
}
