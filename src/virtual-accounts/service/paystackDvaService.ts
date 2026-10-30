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
import { paystackMode, isPaystackLive } from '../../config/paystackConfig.js';
import {
  createCustomer,
  validateCustomerBvnNin,
  assignDedicatedAccount,
  preferredBankForMode,
  PaystackApiError,
  fetchCustomer,
  fetchCustomerDedicatedAccounts,
} from '../provider/paystackDvaProvider.js';
import type { CustomerData, DvaAssignedAccount, IdentificationType } from '../types/paystackDvaTypes.js';
import type {
  VirtualAccountRecord,
  VirtualAccountTransactionRecord,
  VirtualAccountEventRecord,
} from '../types/virtual-account.types.js';
import type { UserRecord } from '../../database/types.js';
import { createBalanceLedgerEntry } from '../../balances/balance.service.js';
import { invalidateUnifiedBalanceCache } from '../../balances/unified-balance.service.js';
import { getNgnAgreementLedger } from '../../ngn/balance-agreements/runtime.js';

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
    bankName: record.bankName ?? raw?.bank?.name ?? (isPaystackLive() ? 'Wema Bank' : 'Test Bank'),
    accountNumber,
    accountName: record.accountName ?? raw?.account_name ?? '',
    currency: 'NGN',
    active: record.status === 'active' || (!isPaystackLive() && !!accountNumber),
    mode: (raw?.__mode as 'live' | 'test') ?? paystackMode(),
  };
}

/** The stored Paystack DVA row for a user, if any. */
export async function findDvaRecord(userId: string): Promise<VirtualAccountRecord | undefined> {
  const all = await db.listVirtualAccounts();
  const direct = all.find((r) => r.userId === userId && r.provider === PROVIDER);
  if (direct) return direct;

  // Cross-reference canonical user if userId was a phone number, channel id, or alias
  try {
    const cleanPhone = userId.replace(/^whatsapp:\+?/, '').replace(/^\+/, '');
    const withPlus = `+${cleanPhone}`;
    const withWhatsapp = `whatsapp:+${cleanPhone}`;

    // Direct phone matching against stored virtual account userId representations
    const byDirectPhone = all.find(
      (r) => (r.userId === cleanPhone || r.userId === withPlus || r.userId === withWhatsapp) && r.provider === PROVIDER
    );
    if (byDirectPhone) return byDirectPhone;

    let user = (await db.findUserById(userId)) || (await db.findUserByTarget(userId));
    if (!user && cleanPhone) {
      user = (await db.findUserByWhatsappNumber(withPlus))
        || (await db.findUserByWhatsappNumber(cleanPhone))
        || (await db.findUserByWhatsappNumber(withWhatsapp));

      if (!user) {
        const identityLinks = await db.listCustomerIdentityLinks();
        const link = identityLinks.find(
          (l) => l.status === 'linked' && (l.whatsappNumber === withPlus || l.whatsappNumber === withWhatsapp || l.whatsappNumber === cleanPhone)
        );
        if (link) user = await db.findUserById(link.paymentUserId);
      }
    }

    if (user && user.id !== userId) {
      const byCanonical = all.find(
        (r) => (r.userId === user.id || r.userId === user.whatsappNumber || (user as any).phone === r.userId) && r.provider === PROVIDER
      );
      if (byCanonical) return byCanonical;
    }
  } catch {
    // Non-fatal
  }
  return undefined;
}

/**
 * Ensures a user record exists in the central users table so foreign key
 * constraints on payments_virtual_accounts and payments_customers are always satisfied.
 */
async function ensureUserForDva(
  userId: string,
  legalName?: string,
  phone?: string
): Promise<string> {
  // 1. Exact match on user_id
  const direct = await db.findUserById(userId);
  if (direct) return direct.id;

  // 2. Check if a user with this phone or WhatsApp number already exists
  const cleanPhone = phone?.trim() || (userId.startsWith('whatsapp:') ? userId.replace(/^whatsapp:\+?/, '').replace(/^\+/, '') : undefined);
  const formattedPhone = cleanPhone ? (cleanPhone.startsWith('+') ? cleanPhone : `+${cleanPhone.replace(/\D/g, '')}`) : undefined;

  if (formattedPhone) {
    const byPhone = (await db.findUserByWhatsappNumber(formattedPhone))
      || (await db.findUserByWhatsappNumber(formattedPhone.replace(/^\+/, '')))
      || (await db.findUserByWhatsappNumber(`whatsapp:${formattedPhone}`));
    if (byPhone) return byPhone.id;
  }

  // 3. Fallback check by target if available
  try {
    const byTarget = await db.findUserByTarget(userId);
    if (byTarget) return byTarget.id;
  } catch {
    // Non-fatal
  }

  // 4. Create a minimal valid user record to satisfy foreign keys
  const now = new Date().toISOString();
  const email = paystackCustomerEmail(userId);
  const fullName = legalName && legalName.trim() ? legalName.trim() : 'Sivan User';

  const newRecord: UserRecord = {
    id: userId,
    email,
    fullName,
    whatsappNumber: formattedPhone,
    country: 'NG',
    createdAt: now,
    updatedAt: now,
  };

  try {
    const inserted = await db.insertUserRecord(newRecord);
    return inserted.id;
  } catch (_err) {
    // In case of concurrent insert or key conflict, fetch the existing record
    const fallback = (await db.findUserById(userId))
      || (formattedPhone ? await db.findUserByWhatsappNumber(formattedPhone) : undefined)
      || (await db.findUserByEmail(email));
    if (fallback) return fallback.id;
    return userId;
  }
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
    if (view) {
      if (!isPaystackLive()) {
        await grantStagingDvaTestCredit(userId).catch(() => false);
      }
      return { state: 'ready', account: view };
    }
  }
  if (record.status === 'rejected') {
    return {
      state: 'failed',
      reason: raw?.__identificationFailureReason ?? 'Identity verification was not successful.',
      customerCode: record.customerId,
    };
  }

  // In test / staging mode, NIBSS verification does not exist.
  // If we already have an account number stored, mark active and return ready!
  if (!isPaystackLive() && raw?.account_number) {
    if (record.status !== 'active') {
      await persist(userId, { status: 'active' });
      record.status = 'active';
    }
    const view = toPublicView(record);
    if (view) {
      await grantStagingDvaTestCredit(userId).catch(() => false);
      return { state: 'ready', account: view };
    }
  }

  if (record.status === 'provisioning' || record.status === 'under_review') {
    // ACTIVE SYNC: Instead of leaving user stranded in "verifying", poll Paystack directly!
    // If Paystack or NIBSS completed verification or assigned the dedicated account,
    // immediately transition state to 'ready' and deliver details.
    try {
      const synced = await syncDvaWithPaystack(userId);
      if (synced.state === 'ready') return synced;
      if (!isPaystackLive() && record.customerId) {
        const assigned = await assignAndPersist(userId, record.customerId).catch(() => null);
        if (assigned && assigned.state === 'ready') return assigned;
      }
      return synced;
    } catch (_err) {
      if (!isPaystackLive() && record.customerId) {
        try {
          const direct = await assignAndPersist(userId, record.customerId);
          if (direct.state === 'ready') return direct;
        } catch (_assignErr) {
          // ignore
        }
      }
      return { state: 'verifying', customerCode: record.customerId ?? '' };
    }
  }
  return { state: 'awaiting_identity', reason: 'not_verified' };
}

async function persist(
  userId: string,
  patch: Partial<VirtualAccountRecord> & { rawExtra?: Record<string, unknown> }
): Promise<VirtualAccountRecord> {
  const canonicalUserId = await ensureUserForDva(userId, patch.accountName);
  const existing = await findDvaRecord(canonicalUserId);
  const now = new Date().toISOString();
  const recId = existing?.id ?? recordId(canonicalUserId);
  const merged: VirtualAccountRecord = {
    id: recId,
    userId: canonicalUserId,
    provider: PROVIDER,
    providerAccountId: patch.providerAccountId ?? existing?.providerAccountId ?? (patch.customerId || recId),
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
  /** Preferred over splitting legalName — avoids Nigerian name-order errors with NIBSS */
  firstName?: string;
  lastName?: string;
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
  const { userId: rawUserId } = input;
  if (!rawUserId) throw new Error('resolveOrCreateDva requires a userId.');

  // Ensure user exists in users table and resolve canonical userId
  const userId = await ensureUserForDva(rawUserId, input.legalName, input.phone);

  // 1. Already have it? Cheapest path, no network.
  const current = await getDvaState(userId);
  if (current.state === 'ready') return current;
  if (isPaystackLive() && current.state === 'verifying') return current;


  // 2. Need identity details before anything can be created.
  if (!input.legalName && !(input.firstName && input.lastName)) {
    return { state: 'awaiting_identity', reason: current.state === 'failed' ? 'not_verified' : 'no_account' };
  }
  if (isPaystackLive() && !input.identifier) {
    return { state: 'awaiting_identity', reason: current.state === 'failed' ? 'not_verified' : 'no_account' };
  }

  // Prefer explicit firstName/lastName; fall back to splitting legalName as last resort
  let first_name: string;
  let last_name: string;
  if (input.firstName && input.lastName) {
    first_name = input.firstName.trim();
    last_name = input.lastName.trim();
  } else {
    const split = splitLegalName(input.legalName!);
    first_name = split.first_name;
    last_name = split.last_name;
  }
  // Derive a consistent legalName for storage purposes
  const resolvedLegalName = `${first_name} ${last_name}`;
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
      kycStatus: 'kyc_under_review',
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

  // 4. In test mode (Staging), bypass NIBSS BVN verification because Paystack test environment
  // does not connect to NIBSS or emit customeridentification.success webhooks.
  // Directly assign and persist the dedicated account.
  if (!isPaystackLive()) {
    return assignAndPersist(userId, customer.customer_code);
  }

  // 4b. Live mode: Submit identity to NIBSS. Returns ACCEPTANCE, not a verdict.
  try {
    await validateCustomerBvnNin(customer.customer_code, {
      country: 'NG',
      type: input.identifierType ?? 'bvn',
      value: input.identifier!,
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
   * Deliberately NOT assigning the account here in live mode.
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
    if (view) {
      if (!isPaystackLive()) {
        await grantStagingDvaTestCredit(userId).catch(() => false);
      }
      return { state: 'ready', account: view };
    }
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
      const accounts = await fetchCustomerDedicatedAccounts(customerCode).catch(() => []);
      const matched = accounts.find((a) => !!a.account_number);
      if (matched?.account_number) {
        const persisted = await persist(userId, {
          customerId: customerCode,
          providerAccountId: String(matched.id),
          status: 'active',
          bankName: matched.bank?.name || (isPaystackLive() ? 'Wema Bank' : 'Test Bank'),
          accountName: matched.account_name,
          accountNumberMasked: `****${matched.account_number.slice(-4)}`,
          rawProviderPayload: matched as unknown as Record<string, unknown>,
        });
        const view = toPublicView(persisted);
        if (view) {
          if (!isPaystackLive()) {
            await grantStagingDvaTestCredit(userId).catch(() => false);
          }
          return { state: 'ready', account: view };
        }
      }

      const again = await findDvaRecord(userId);
      if (again) {
        if (!isPaystackLive() && again.status !== 'active') {
          again.status = 'active';
          await persist(userId, { status: 'active' });
        }
        const view = toPublicView(again);
        if (view) {
          if (!isPaystackLive()) {
            await grantStagingDvaTestCredit(userId).catch(() => false);
          }
          return { state: 'ready', account: view };
        }
      }
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
    status: account.active || !isPaystackLive() ? 'active' : 'provisioning',
    bankName: account.bank?.name || (isPaystackLive() ? 'Wema Bank' : 'Test Bank'),
    accountName: account.account_name,
    accountNumberMasked: `****${account.account_number.slice(-4)}`,
    rawProviderPayload: account as unknown as Record<string, unknown>,
  });

  if (!account.active && isPaystackLive()) {
    return { state: 'verifying', customerCode };
  }
  const view = toPublicView(record);
  if (view && !isPaystackLive()) {
    await grantStagingDvaTestCredit(userId).catch(() => false);
  }
  return view ? { state: 'ready', account: view } : { state: 'verifying', customerCode };
}

/**
 * Actively syncs a user's DVA status with live Paystack data.
 * Checks whether NIBSS BVN validation has succeeded, whether Paystack assigned an account,
 * or whether the account requires immediate assignment.
 */
export async function syncDvaWithPaystack(userId: string): Promise<DvaState> {
  const canonicalUserId = await ensureUserForDva(userId);
  const record = await findDvaRecord(canonicalUserId);

  let customerCode = record?.customerId;
  const email = paystackCustomerEmail(canonicalUserId);

  if (!customerCode) {
    try {
      const fetched = await fetchCustomer(email);
      if (fetched?.customer_code) {
        customerCode = fetched.customer_code;
      }
    } catch {
      return { state: 'awaiting_identity', reason: 'no_account' };
    }
  }

  if (!customerCode) {
    return { state: 'awaiting_identity', reason: 'no_account' };
  }

  try {
    const customer = await fetchCustomer(customerCode);

    // 1. Check if Paystack already has an assigned dedicated virtual account
    let assignedAccount: DvaAssignedAccount | undefined = customer.dedicated_account;
    if (!assignedAccount?.account_number) {
      const accounts = await fetchCustomerDedicatedAccounts(customerCode).catch(() => []);
      assignedAccount = accounts.find((a) => !!a.account_number);
    }

    if (assignedAccount?.account_number) {
      // Test mode has no NIBSS step to activate the account, so an assigned
      // sandbox account is usable as soon as it exists. Live stays strict.
      const usable = assignedAccount.active || !isPaystackLive();
      const persisted = await persist(canonicalUserId, {
        customerId: customerCode,
        providerAccountId: String(assignedAccount.id),
        status: usable ? 'active' : 'provisioning',
        bankName: assignedAccount.bank?.name || (isPaystackLive() ? 'Wema Bank' : 'Test Bank'),
        accountName: assignedAccount.account_name,
        accountNumberMasked: `****${assignedAccount.account_number.slice(-4)}`,
        rawProviderPayload: assignedAccount as unknown as Record<string, unknown>,
      });

      if (usable) {
        const view = toPublicView(persisted);
        if (view) {
          if (!isPaystackLive()) {
            await grantStagingDvaTestCredit(canonicalUserId).catch(() => false);
          }
          return { state: 'ready', account: view };
        }
      }
      return { state: 'verifying', customerCode };
    }

    // 2. Check if customer identity was verified on Paystack
    const isIdentified =
      customer.identified === true ||
      (customer.identifications &&
        customer.identifications.some((i: any) => i.status === 'success'));

    if (!isPaystackLive() || isIdentified) {
      // In staging/test mode or when verified by NIBSS: assign dedicated account now!
      return assignAndPersist(canonicalUserId, customerCode);
    }

    // 3. Check if identification failed
    const failedIdentification = customer.identifications?.find((i: any) => i.status === 'failed');
    if (failedIdentification) {
      const reason = (failedIdentification as any).reason || 'Identity verification was not successful at NIBSS.';
      await persist(canonicalUserId, {
        customerId: customerCode,
        status: 'rejected',
        rawExtra: { __identificationFailureReason: reason },
      });
      return { state: 'failed', reason, customerCode };
    }

    return { state: 'verifying', customerCode };
  } catch (err: any) {
    console.warn(`[syncDvaWithPaystack] Failed to sync customer ${customerCode}:`, err?.message || err);
    if (record?.status === 'active') {
      const view = toPublicView(record);
      if (view) return { state: 'ready', account: view };
    }
    return { state: 'verifying', customerCode: customerCode || '' };
  }
}

/**
 * ADMIN: Get complete DVA diagnostics for a user.
 * Fetches database records, user profile, and live Paystack customer data.
 */
export async function adminGetDvaDetails(userId: string): Promise<Record<string, unknown>> {
  const canonicalUserId = await ensureUserForDva(userId);
  const record = await findDvaRecord(canonicalUserId);
  const user = await db.findUserById(canonicalUserId);
  const email = paystackCustomerEmail(canonicalUserId);

  let paystackCustomer: any = null;
  let paystackDedicatedAccounts: any[] = [];
  let paystackError: string | null = null;

  const customerCode = record?.customerId;
  try {
    if (customerCode) {
      paystackCustomer = await fetchCustomer(customerCode);
      paystackDedicatedAccounts = await fetchCustomerDedicatedAccounts(customerCode).catch(() => []);
    } else {
      paystackCustomer = await fetchCustomer(email).catch(() => null);
    }
  } catch (err: any) {
    paystackError = err?.paystackMessage || err?.message || String(err);
  }

  const dvaState = await getDvaState(canonicalUserId);

  return {
    userId: canonicalUserId,
    email,
    user: user
      ? { id: user.id, fullName: user.fullName, phone: user.whatsappNumber, email: user.email }
      : null,
    localRecord: record || null,
    dvaState,
    paystack: {
      mode: paystackMode(),
      customer: paystackCustomer,
      dedicatedAccounts: paystackDedicatedAccounts,
      error: paystackError,
    },
  };
}

/**
 * ADMIN: Force-sync user with Paystack and auto-activate if verified.
 */
export async function adminSyncUserDva(userId: string): Promise<{
  success: boolean;
  dvaState: DvaState;
  details: Record<string, unknown>;
}> {
  const dvaState = await syncDvaWithPaystack(userId);
  const details = await adminGetDvaDetails(userId);
  return {
    success: dvaState.state === 'ready',
    dvaState,
    details,
  };
}

/**
 * ADMIN: Force account assignment on Paystack.
 */
export async function adminAssignUserDva(userId: string): Promise<DvaState> {
  const canonicalUserId = await ensureUserForDva(userId);
  const record = await findDvaRecord(canonicalUserId);
  const customerCode = record?.customerId;
  if (!customerCode) {
    throw new Error(`User ${userId} does not have a Paystack customer code yet.`);
  }
  return assignAndPersist(canonicalUserId, customerCode);
}

/**
 * ADMIN: Reset stuck DVA state so the user can re-enter BVN/Name in chat.
 */
export async function adminResetUserDva(
  userId: string,
  reason?: string
): Promise<{ success: boolean; message: string }> {
  const canonicalUserId = await ensureUserForDva(userId);
  const existing = await findDvaRecord(canonicalUserId);
  if (!existing) {
    return { success: true, message: 'No existing virtual account record found for this user.' };
  }

  const now = new Date().toISOString();
  await db.upsertVirtualAccountRecord({
    ...existing,
    status: 'requested',
    updatedAt: now,
    rawProviderPayload: {
      ...((existing.rawProviderPayload as object) ?? {}),
      __adminResetAt: now,
      __adminResetReason: reason || 'Manual reset by admin',
      __identificationFailureReason: undefined,
    },
  });

  return {
    success: true,
    message: `Virtual account record for user ${userId} reset to requested state. User can now re-enter BVN in chat.`,
  };
}

/**
 * ADMIN: Manually override and activate virtual account details for a user.
 */
export async function adminOverrideUserDva(
  userId: string,
  override: {
    accountNumber: string;
    bankName?: string;
    accountName?: string;
    status?: 'active' | 'provisioning' | 'rejected';
  }
): Promise<DvaState> {
  const canonicalUserId = await ensureUserForDva(userId, override.accountName);
  const existing = await findDvaRecord(canonicalUserId);
  const now = new Date().toISOString();
  const rawPayload = {
    account_number: override.accountNumber,
    account_name: override.accountName || 'Sivan Verified User',
    bank: { name: override.bankName || 'Wema Bank' },
    active: override.status !== 'rejected',
    __mode: paystackMode(),
    __adminOverrideAt: now,
  };

  const customerId = existing?.customerId || `CUS_manual_${Date.now()}`;
  try {
    await db.insertCustomerRecord({
      id: customerId,
      userId: canonicalUserId,
      provider: PROVIDER,
      providerCustomerId: customerId,
      customerType: 'individual',
      kycStatus: 'kyc_approved',
      tosStatus: 'approved',
      createdAt: now,
      updatedAt: now,
    });
  } catch (_ignored) {}

  const persisted = await persist(canonicalUserId, {
    customerId,
    providerAccountId: existing?.providerAccountId || `act_manual_${Date.now()}`,
    status: override.status || 'active',
    bankName: override.bankName || 'Wema Bank',
    accountName: override.accountName || 'Sivan Verified User',
    accountNumberMasked: `****${override.accountNumber.slice(-4)}`,
    rawProviderPayload: rawPayload,
  });

  const view = toPublicView(persisted);
  if (view && persisted.status === 'active') {
    if (!isPaystackLive()) {
      await grantStagingDvaTestCredit(canonicalUserId).catch(() => false);
    }
    return { state: 'ready', account: view };
  }
  return { state: 'failed', reason: 'Admin override set to inactive or rejected' };
}

/**
 * STAGING ONLY: Welcome test credit facility.
 *
 * Automatically grants 50,000 NGN internal balance to users creating a DVA in test/staging.
 * Strict invariants:
 * 1. Hard blocked in production (process.env.APP_ENV === 'production' or isPaystackLive()).
 * 2. Idempotent: will never credit the same user twice.
 * 3. Auditable: tagged with sourceType: 'sandbox_test_credit'.
 * 4. Updates both the internal balance ledger and authoritative NGN agreement accounts.
 */
export async function grantStagingDvaTestCredit(userId: string): Promise<boolean> {
  // 1. Strict production isolation guard
  if (isPaystackLive() || process.env.APP_ENV === 'production') {
    return false;
  }

  // 2. Ensure canonical user ID
  const canonicalUserId = await ensureUserForDva(userId).catch(() => userId);

  // 3. Check idempotency: have we already granted a sandbox test credit to this user?
  const existingTxs = await db.listVirtualAccountTransactions();
  const alreadyCredited = existingTxs.some(
    (tx) =>
      (tx.userId === canonicalUserId || tx.userId === userId) &&
      ((tx.rawPayload as any)?.sourceType === 'sandbox_test_credit' ||
        tx.depositId?.startsWith(`sandbox_credit_${canonicalUserId}`) ||
        tx.depositId?.startsWith(`sandbox_credit_${userId}`))
  );

  if (alreadyCredited) {
    return false;
  }

  // 4. Correlate with DVA record
  const matchingAccount = await findDvaRecord(canonicalUserId);
  const now = new Date().toISOString();
  const ref = `sandbox_credit_${canonicalUserId}_${Date.now()}`;
  const amountNgn = '50000.00';

  // 5. Upsert Virtual Account Transaction
  const txRecord: VirtualAccountTransactionRecord = {
    id: `vatx_sandbox_${crypto.createHash('sha256').update(ref).digest('hex').slice(0, 24)}`,
    provider: PROVIDER,
    virtualAccountId: matchingAccount?.id || `dva_${canonicalUserId}`,
    providerAccountId: matchingAccount?.providerAccountId || 'sandbox_dva',
    depositId: ref,
    userId: canonicalUserId,
    customerId: matchingAccount?.customerId || `sandbox_cust_${canonicalUserId}`,
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: amountNgn,
    destinationAmount: amountNgn,
    paymentRail: 'nibss_paystack_dva',
    status: 'completed',
    depositReference: ref,
    rawPayload: {
      channel: 'dedicated_nuban',
      sourceType: 'sandbox_test_credit',
      purpose: 'Staging welcome test credit facility',
      amountKobo: 5000000,
      currency: 'NGN',
      grantedAt: now,
    },
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  };
  await db.upsertVirtualAccountTransactionRecord(txRecord);

  // 6. Upsert Virtual Account Event
  const eventRecord: VirtualAccountEventRecord = {
    id: `vaev_sandbox_${crypto.createHash('sha256').update(`${ref}_${now}`).digest('hex').slice(0, 24)}`,
    provider: PROVIDER,
    providerEventId: ref,
    virtualAccountId: matchingAccount?.id || `dva_${canonicalUserId}`,
    providerAccountId: matchingAccount?.providerAccountId || 'sandbox_dva',
    depositId: ref,
    eventType: 'funds_received',
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: amountNgn,
    destinationAmount: amountNgn,
    paymentRail: 'nibss_paystack_dva',
    status: 'completed',
    depositReference: ref,
    rawPayload: { sourceType: 'sandbox_test_credit', amountNgn: 50000 },
    createdAt: now,
    updatedAt: now,
  };
  await db.upsertVirtualAccountEventRecord(eventRecord);

  // 7. Record Unified Balance Ledger Entry
  await createBalanceLedgerEntry(
    {
      userId: canonicalUserId,
      asset: 'ngn',
      amount: amountNgn,
      kind: 'credit_available',
      status: 'available',
      sourceType: 'sandbox_test_credit',
      sourceId: txRecord.id,
      description: 'Staging welcome test credit facility (50,000 NGN)',
      transferId: txRecord.id,
    },
    { actorType: 'system', actorId: 'staging_test_credit_facility' }
  );

  // 8. Credit NGN Agreement Ledger if active
  try {
    const agreementLedger = getNgnAgreementLedger();
    if (agreementLedger) {
      await agreementLedger.creditVerifiedDeposit(ref);
    }
  } catch (_err) {
    // Non-blocking in test environment
  }

  // 9. Evict cached balance
  invalidateUnifiedBalanceCache(canonicalUserId);
  return true;
}

/**
 * Backfills test credits for all existing staging virtual accounts and wallets.
 * Strictly blocked in production.
 */
export async function backfillStagingDvaTestCredits(): Promise<{ funded: string[]; skipped: string[] }> {
  if (isPaystackLive() || process.env.APP_ENV === 'production') {
    return { funded: [], skipped: [] };
  }

  const accounts = await db.listVirtualAccounts();
  const funded: string[] = [];
  const skipped: string[] = [];

  for (const acc of accounts) {
    if (acc.userId) {
      const ok = await grantStagingDvaTestCredit(acc.userId);
      if (ok) funded.push(acc.userId);
      else skipped.push(acc.userId);
    }
  }
  return { funded, skipped };
}


