/**
 * SIVAN BANKING RAIL ADAPTER — CANONICAL INTERFACE
 *
 * Every banking rail that Sivan integrates for NGN virtual account issuance,
 * inbound deposits, and outbound cashout payouts must implement this contract.
 *
 * Current registered adapters:
 *   paystack  — Paystack DVA (Wema / Titan Trust NUBAN rails, NIBSS KYC)
 *   mono      — stub, ready for MonoBankingRailAdapter (see FUTURE_BUILD doc)
 *
 * Adding a new rail (e.g. Mono, Flutterwave, Nomba):
 *   1. Create src/banking-rail/adapters/<name>.adapter.ts implementing IBankingRailAdapter
 *   2. Register it in banking-rail-registry.ts
 *   3. Set BANKING_RAIL_PROVIDER=<name> in environment — zero other changes needed
 *
 * FINANCIAL LEDGER INTEGRITY RULES (from AGENTS.md — highest priority):
 *   - verifyWebhookSignature() MUST return false for any unverifiable payload.
 *     Never credit a user balance based on an unverified event.
 *   - parseWebhookEvent() MUST return a typed BankingRailEvent or throw.
 *     No silent fallthrough. No swallowed events.
 *   - createTransfer() MUST use a stable providerRef that survives retries.
 *     Unknown transfer status must be queried via getTransfer() before any retry.
 */

// ─── Shared input/output types ────────────────────────────────────────────────

export type BankingRailName = 'paystack' | 'mono' | 'flutterwave' | 'nomba';

export interface CreateCustomerInput {
  userId: string;
  legalName: string;
  /** E.164 e.g. +2348012345678 */
  phone?: string;
  /** Derived deterministically by the adapter if not supplied */
  email?: string;
  metadata?: Record<string, unknown>;
}

export interface CustomerRecord {
  /** Adapter-internal customer ID (e.g. CUS_xxxx for Paystack) */
  providerCustomerId: string;
  email: string;
  legalName: string;
  /** Adapter's current view of KYC state */
  kycStatus: 'pending' | 'under_review' | 'verified' | 'rejected';
}

export type IdentifierType = 'bvn' | 'bank_account';

export interface IdentityInput {
  type: IdentifierType;
  /** EPHEMERAL — must never be stored, logged, or echoed */
  value: string;
  firstName: string;
  lastName: string;
  country?: string;
}

export interface VirtualAccountRecord {
  providerAccountId: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
  currency: 'NGN';
  active: boolean;
  mode: 'live' | 'test';
}

export interface CreateTransferInput {
  /** Stable idempotency key — must survive retries without double-paying */
  providerRef: string;
  /** Recipient's bank account number */
  accountNumber: string;
  /** Bank sort code / slug known to the provider */
  bankCode: string;
  /** Exact amount in kobo (integer) */
  amountKobo: number;
  /** Sivan user ID for audit */
  userId: string;
  narration?: string;
}

export type TransferStatus = 'pending' | 'sent' | 'success' | 'failed' | 'reversed';

export interface TransferRecord {
  providerRef: string;
  providerTransferId?: string;
  status: TransferStatus;
  amountKobo: number;
  /** Provider-confirmed status, used for reconciliation */
  confirmedAt?: string;
  failureReason?: string;
  raw?: unknown;
}

// ─── Typed webhook event union ────────────────────────────────────────────────

/**
 * Provider-agnostic webhook event union.
 *
 * The webhook handler switches on `type` — no Paystack-specific strings
 * inside shared ledger logic. Every new adapter maps its own wire events
 * to this union inside parseWebhookEvent().
 *
 * FINANCIAL INTEGRITY: every field that affects a ledger write must be
 * present and typed. No `unknown` amounts. No optional providerRefs on
 * events that trigger debits or credits.
 */
export type BankingRailEvent =
  | {
      type: 'identity.success';
      userId: string;
      providerCustomerId: string;
    }
  | {
      type: 'identity.failed';
      userId: string;
      reason: string;
    }
  | {
      type: 'deposit.received';
      userId: string;
      /** Integer kobo — gross before platform fee */
      amountKobo: number;
      /** Stable unique reference for idempotency */
      reference: string;
      currency: 'NGN';
      /** Provider's customer code for ownership resolution */
      providerCustomerId: string;
    }
  | {
      type: 'transfer.success';
      providerRef: string;
      /** Integer kobo — must match the original debit */
      amountKobo: number;
    }
  | {
      type: 'transfer.failed';
      providerRef: string;
      reason: string;
    }
  | {
      type: 'transfer.reversed';
      providerRef: string;
      /** Integer kobo — must be credited back exactly */
      amountKobo: number;
    }
  | {
      /** Unrecognised or non-actionable event — do not credit, do not debit */
      type: 'ignored';
      originalType: string;
    };

// ─── The adapter contract ─────────────────────────────────────────────────────

export interface IBankingRailAdapter {
  readonly name: BankingRailName;

  // ── Inbound: onboard user and issue virtual account ──────────────────────

  /**
   * Create or fetch the provider-side customer record.
   * Must be idempotent: calling twice with the same userId returns the same record.
   */
  createCustomer(input: CreateCustomerInput): Promise<CustomerRecord>;

  /**
   * Submit identity document (BVN/bank_account) for async verification.
   * Returns acceptance, NOT a verdict. The outcome arrives via webhook
   * as identity.success or identity.failed.
   *
   * NDPR: `input.value` must never be stored, logged, or echoed.
   */
  verifyIdentity(providerCustomerId: string, input: IdentityInput): Promise<{ accepted: true; message: string }>;

  /**
   * Assign a dedicated virtual account number (NUBAN) to a verified customer.
   * Only call after identity.success webhook is confirmed.
   */
  assignVirtualAccount(providerCustomerId: string): Promise<VirtualAccountRecord>;

  /**
   * Look up all virtual accounts linked to a Sivan userId.
   */
  listVirtualAccounts(userId: string): Promise<VirtualAccountRecord[]>;

  // ── Webhooks: provider-agnostic event parsing ─────────────────────────────

  /**
   * Verify the HMAC or signature of an inbound webhook payload.
   *
   * FINANCIAL INTEGRITY: must return false for any unverifiable payload.
   * No ledger write may occur if this returns false.
   */
  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string>): boolean;

  /**
   * Parse a verified webhook payload into a typed BankingRailEvent.
   *
   * Must never return undefined. Unrecognised events return { type: 'ignored' }.
   * Must never throw on valid JSON with an unknown event type.
   */
  parseWebhookEvent(rawBody: Buffer): BankingRailEvent;

  // ── Outbound: cashout payout (Gate 6) ────────────────────────────────────

  /**
   * Initiate a bank transfer payout.
   *
   * FINANCIAL INTEGRITY: providerRef must be stable and unique per transfer.
   * If status is unknown after a network error, call getTransfer() before
   * retrying. Never retry blindly — a duplicate transfer is unrecoverable.
   */
  createTransfer(input: CreateTransferInput): Promise<TransferRecord>;

  /**
   * Query the authoritative status of a transfer from the provider.
   *
   * Used to resolve unknown-status transfers without relying solely on webhooks.
   * Unknown status must be treated as potentially committed until confirmed otherwise.
   */
  getTransfer(providerRef: string): Promise<TransferRecord>;

  // ── Health ────────────────────────────────────────────────────────────────

  health(): Promise<{ status: 'ok' | 'degraded'; latencyMs: number; detail?: string }>;
}
