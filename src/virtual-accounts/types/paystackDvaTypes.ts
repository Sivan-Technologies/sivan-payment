/**
 * PAYSTACK DEDICATED VIRTUAL ACCOUNT TYPES.
 *
 * Wire shapes for the three-step DVA provisioning flow:
 *
 *   A. POST /customer                              -> customer_code
 *   B. POST /customer/{code}/identification        -> async NIBSS check
 *   C. POST /dedicated_account                     -> permanent NUBAN
 *
 * NDPR: BVN AND NIN ARE EPHEMERAL AND MUST NEVER BE PERSISTED.
 *
 * The rule is enforced by shape, not only by comment. The raw identifier
 * lives on IdentificationPayload, which is a REQUEST type and is never part
 * of any response, record, or return value in this module. Anything Sivan
 * stores is modelled by PersistedDvaRecord, which has no field capable of
 * holding one.
 *
 * Step B IS ASYNCHRONOUS, and this is the detail most integrations get wrong.
 * POST /identification returns 202 Accepted with no verdict. The result
 * arrives later as a webhook, customeridentification.success or
 * customeridentification.failed. Treating the 202 as success means assigning
 * an account to an unverified customer.
 */

/** Every Paystack REST response uses this envelope. */
export interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

/** Paystack error responses carry the same envelope with data absent. */
export interface PaystackErrorEnvelope {
  status: false;
  message: string;
  data?: never;
  /** Present on validation failures. */
  errors?: Record<string, string[]>;
}

// ─────────────────────────────────────────────────────────────
// STEP A: customer record
// ─────────────────────────────────────────────────────────────

/**
 * POST /customer
 *
 * `email` is the primary key on Paystack's side and must be unique and
 * stable. Sivan derives it deterministically from the user's phone number
 * (user_2348012345678@user.sivantech.online) so that a returning user on a
 * new device resolves to the SAME Paystack customer rather than a duplicate
 * with a second bank account.
 */
export interface CustomerPayload {
  email: string;
  first_name: string;
  last_name: string;
  /** E.164, for example +2348012345678. */
  phone: string;
  metadata?: Record<string, unknown>;
}

export interface CustomerData {
  id: number;
  /** CUS_xxxxxxxxxxxx. The handle for every later call. */
  customer_code: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  /**
   * Paystack's own view of KYC state. Only 'success' means NIBSS validated
   * this customer; a fresh customer is typically 'default'.
   */
  identified?: boolean;
  identifications?: unknown;
  risk_action?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type CustomerResponse = PaystackEnvelope<CustomerData>;

// ─────────────────────────────────────────────────────────────
// STEP B: NIBSS identity validation
// ─────────────────────────────────────────────────────────────

export type IdentificationType = 'bvn' | 'bank_account';

/**
 * POST /customer/{customer_code}/identification
 *
 * EPHEMERAL. `value` carries the raw BVN. It is received from chat, forwarded
 * to Paystack over TLS, and dropped. It must never be written to a database,
 * a log line, an error message, or an analytics event.
 *
 * Note on NIN: Paystack's identification endpoint accepts `bvn` and
 * `bank_account`. A NIN is not a distinct type here, so a NIN-only user
 * cannot be verified through this endpoint. The conversational spec offers
 * "BVN or NIN", which is wider than the API supports, and that gap needs a
 * product decision rather than a silent coercion.
 */
export interface IdentificationPayload {
  country: 'NG';
  type: IdentificationType;
  /** EPHEMERAL, NEVER PERSISTED. 11 digit BVN. */
  value: string;
  first_name: string;
  last_name: string;
  /** Required when type is bank_account. */
  bank_code?: string;
  account_number?: string;
}

/**
 * The 202 body. Note there is NO verdict here: it acknowledges that the check
 * has STARTED. The outcome arrives by webhook.
 */
export interface IdentificationAcceptedData {
  [key: string]: unknown;
}

export type IdentificationResponse = PaystackEnvelope<IdentificationAcceptedData>;

/** Terminal states, resolved from the webhook rather than the POST. */
export type IdentificationStatus = 'pending' | 'success' | 'failed';

// ─────────────────────────────────────────────────────────────
// STEP C: dedicated account assignment
// ─────────────────────────────────────────────────────────────

/**
 * Partner banks that can issue a DVA. Titan is the usual fallback when Wema
 * is unavailable, and the pair is modelled as a union so a typo cannot reach
 * the API as a silently unsupported slug.
 */
export type PreferredBank = 'wema-bank' | 'titan-paystack' | 'test-bank';

/**
 * TEST MODE USES A DIFFERENT BANK SLUG, and this is not optional.
 *
 * Paystack's documentation is explicit: to create a DVA with a test secret
 * key you must pass preferred_bank 'test-bank'. Passing 'wema-bank' with an
 * sk_test_ key fails. The onboarding spec says wema-bank throughout, which is
 * correct for production and wrong for every staging run.
 *
 * Resolved from the key mode rather than configured separately, so the two
 * cannot drift apart.
 */
export const PREFERRED_BANK_BY_MODE: Record<'live' | 'test', PreferredBank> = {
  live: 'wema-bank',
  test: 'test-bank',
};

/** POST /dedicated_account */
export interface DvaRequest {
  /** CUS_xxxx from step A. */
  customer: string;
  preferred_bank?: PreferredBank;
  /** Required by Paystack when split settlement is in use. */
  subaccount?: string;
  split_code?: string;
}

export interface DvaBank {
  name: string;
  id: number;
  slug: string;
}

export interface DvaAssignedAccount {
  id: number;
  /** The NUBAN the user transfers to. */
  account_number: string;
  /** For example "Sivan / Samson Micheal". */
  account_name: string;
  bank: DvaBank;
  currency: 'NGN';
  /**
   * False means the account exists but cannot receive yet. Presenting an
   * inactive account to a user produces a deposit that never lands.
   */
  active: boolean;
  assigned: boolean;
  assignment?: {
    integration: number;
    assignee_id: number;
    assignee_type: string;
    account_type: string;
    assigned_at: string;
  };
  customer?: Pick<CustomerData, 'id' | 'customer_code' | 'email' | 'phone'>;
  created_at?: string;
  updated_at?: string;
}

export type DvaResponse = PaystackEnvelope<DvaAssignedAccount>;

// ─────────────────────────────────────────────────────────────
// WEBHOOK EVENTS relevant to this flow
// ─────────────────────────────────────────────────────────────

/**
 * The DVA lifecycle is webhook driven end to end. Names taken from Paystack's
 * supported events list; the identification pair is what resolves step B, and
 * the assignment pair is what confirms step C.
 */
export type PaystackDvaEvent =
  | 'customeridentification.success'
  | 'customeridentification.failed'
  | 'dedicatedaccount.assign.success'
  | 'dedicatedaccount.assign.failed'
  | 'charge.success';

export interface PaystackWebhookEnvelope<T = unknown> {
  event: PaystackDvaEvent | string;
  data: T;
}

export interface CustomerIdentificationEventData {
  customer_id: number;
  customer_code: string;
  email: string;
  identification: {
    country: string;
    type: string;
    /** Paystack masks this. Even so, it is never persisted. */
    value?: string;
    bvn?: string;
  };
  /** Present on the failed event, and the string to show the user. */
  reason?: string;
}

/**
 * A deposit into a DVA arrives as charge.success with channel
 * 'dedicated_nuban'. The channel is what distinguishes a bank transfer into a
 * virtual account from a card payment, and it is the discriminator the
 * webhook router uses to decide this is a wallet credit rather than a
 * Service Agreement funding event.
 */
export interface DvaChargeEventData {
  id: number;
  /** MINOR UNITS. Kobo, not naira. Dividing by 100 is mandatory. */
  amount: number;
  currency: 'NGN';
  /** Unique per transaction. The idempotency key for crediting a balance. */
  reference: string;
  channel: string;
  status: string;
  paid_at?: string;
  customer: Pick<CustomerData, 'id' | 'customer_code' | 'email' | 'phone'>;
  authorization?: {
    channel: string;
    bank?: string;
    account_name?: string;
    sender_bank?: string;
    sender_name?: string;
    receiver_bank_account_number?: string;
  };
  metadata?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────
// WHAT SIVAN PERSISTS
// ─────────────────────────────────────────────────────────────

/**
 * The only DVA shape that reaches a database.
 *
 * Deliberately has NO field that can hold a BVN or NIN. If a future change
 * needs to store one, it has to add a field here, which makes the NDPR
 * decision explicit and reviewable instead of accidental.
 */
export interface PersistedDvaRecord {
  userId: string;
  /** CUS_xxxx. */
  paystackCustomerCode: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
  bankSlug: string;
  currency: 'NGN';
  active: boolean;
  /** Verdict only. Never the identifier that produced it. */
  identificationStatus: IdentificationStatus;
  identificationFailureReason?: string;
  /** 'live' or 'test', so a test account can never be shown as spendable. */
  mode: 'live' | 'test';
  createdAt: string;
  updatedAt: string;
}

/** Narrowing helper for the envelope, since Paystack returns 200 on failures. */
export function isPaystackSuccess<T>(
  body: PaystackEnvelope<T> | PaystackErrorEnvelope
): body is PaystackEnvelope<T> {
  return body?.status === true;
}
