/**
 * MONO BANKING RAIL ADAPTER — Phase B
 *
 * Implements IBankingRailAdapter for Mono Connect's virtual account issuance
 * and payment rails. Mono issues dedicated Nigerian virtual account numbers
 * (NUBAN) backed by Providus Bank and handles real-time NIBSS NIP deposits.
 *
 * API Reference: https://docs.mono.co/docs
 * Env vars required:
 *   MONO_SECRET_KEY        — your Mono secret key (mono_sk_live_* or mono_sk_test_*)
 *   MONO_WEBHOOK_SECRET    — separate HMAC secret from Mono dashboard
 *   MONO_BASE_URL          — defaults to https://api.withmono.com (override for sandbox)
 *
 * INTEGRATION NOTES (verified against Mono docs):
 *
 * 1. CUSTOMER CREATION: POST /v2/accounts/virtual
 *    Mono issues a virtual account directly — no separate customer registration step.
 *    The account is tied to a reference (Sivan userId) you supply.
 *
 * 2. IDENTITY VERIFICATION: Mono performs BVN validation internally during
 *    account creation and returns the result synchronously OR via webhook.
 *    Webhook event: mono.virtual_account.funded (deposit)
 *                   mono.virtual_account.created (ready)
 *
 * 3. WEBHOOK SIGNATURE: Mono signs with HMAC-SHA512 using MONO_WEBHOOK_SECRET,
 *    header: mono-webhook-signature (NOT x-paystack-signature).
 *
 * 4. OUTBOUND TRANSFERS: POST /v2/payments/transfer
 *    Uses Mono's payout API — requires MONO_SECRET_KEY with payout permissions.
 *
 * 5. TRANSFERS QUERY: GET /v2/payments/transfer/:id
 */

import crypto from 'node:crypto';
import type {
  IBankingRailAdapter,
  BankingRailEvent,
  BankingRailName,
  CreateCustomerInput,
  CustomerRecord,
  IdentityInput,
  VirtualAccountRecord,
  CreateTransferInput,
  TransferRecord,
} from '../banking-rail.adapter.js';

// ─── Mono API helpers ─────────────────────────────────────────────────────────

function monoSecretKey(): string {
  const key = (process.env.MONO_SECRET_KEY ?? '').trim();
  if (!key) throw new Error('MONO_SECRET_KEY is required for the Mono banking rail adapter.');
  return key;
}

function monoBaseUrl(): string {
  return ((process.env.MONO_BASE_URL ?? '').trim() || 'https://api.withmono.com').replace(/\/+$/, '');
}

function monoWebhookSecret(): string {
  return (process.env.MONO_WEBHOOK_SECRET ?? '').trim();
}

function monoHeaders(): Record<string, string> {
  return {
    'mono-sec-key': monoSecretKey(),
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class MonoApiError extends Error {
  constructor(
    message: string,
    readonly endpoint: string,
    readonly httpStatus: number,
    readonly monoMessage?: string
  ) {
    super(message);
    this.name = 'MonoApiError';
  }
}

async function monoRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const url = `${monoBaseUrl()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: monoHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new MonoApiError(
        `Mono ${method} ${path} timed out after ${timeoutMs}ms`,
        path,
        0
      );
    }
    throw new MonoApiError(`Mono ${method} ${path} network error: ${String(error?.message ?? error)}`, path, 0);
  } finally {
    clearTimeout(timer);
  }

  let parsed: any;
  try {
    parsed = await response.json();
  } catch {
    throw new MonoApiError(
      `Mono ${method} ${path} returned non-JSON with HTTP ${response.status}`,
      path,
      response.status
    );
  }

  if (!response.ok) {
    throw new MonoApiError(
      `Mono ${method} ${path} failed HTTP ${response.status}: ${parsed?.message ?? JSON.stringify(parsed)}`,
      path,
      response.status,
      parsed?.message
    );
  }

  return parsed as T;
}

// ─── Mono virtual account record shape (POST /v2/accounts/virtual) ────────────

interface MonoVirtualAccountResponse {
  status: string;
  data: {
    id: string;
    account_name: string;
    account_number: string;
    bank: { name: string; code: string };
    currency: string;
    reference: string;
    is_permanent: boolean;
    created_at: string;
  };
}

// ─── Mono payout response shapes ─────────────────────────────────────────────

interface MonoTransferResponse {
  status: string;
  data: {
    id: string;
    reference: string;
    amount: number;
    status: 'pending' | 'successful' | 'failed' | 'reversed';
    reason?: string;
    created_at: string;
  };
}

// ─── The adapter ──────────────────────────────────────────────────────────────

export class MonoBankingRailAdapter implements IBankingRailAdapter {
  readonly name: BankingRailName = 'mono';

  // ── Inbound: customer + virtual account ────────────────────────────────────

  /**
   * Mono issues a virtual account directly in one call.
   * No separate customer registration step — the userId is the reference.
   */
  async createCustomer(input: CreateCustomerInput): Promise<CustomerRecord> {
    const [firstName, ...rest] = input.legalName.trim().split(/\s+/);
    const lastName = rest.join(' ') || firstName;

    const body = {
      name: input.legalName.trim(),
      email: input.email ?? `u_${input.userId.replace(/\W/g, '')}@user.sivantech.online`,
      phone: input.phone ?? '',
      reference: input.userId,
      bvn: undefined, // BVN submitted separately via verifyIdentity
      metadata: { sivanUserId: input.userId, ...input.metadata },
    };

    // Mono returns a virtual account on the same call when BVN is not required
    // For BVN-required flows, account creation is deferred until verifyIdentity
    // The customer record is the Mono account reference
    try {
      const res = await monoRequest<MonoVirtualAccountResponse>('POST', '/v2/accounts/virtual', body);
      return {
        providerCustomerId: res.data.id,
        email: body.email,
        legalName: res.data.account_name || input.legalName,
        kycStatus: 'pending', // BVN verification is async
      };
    } catch (error) {
      if (error instanceof MonoApiError) {
        throw new Error(`[MonoBankingRailAdapter] createCustomer failed: ${error.monoMessage ?? error.message}`);
      }
      throw error;
    }
  }

  /**
   * Submit BVN for Mono's identity verification.
   * Mono verifies asynchronously and fires a webhook on completion.
   */
  async verifyIdentity(
    providerCustomerId: string,
    input: IdentityInput
  ): Promise<{ accepted: true; message: string }> {
    await monoRequest('POST', `/v2/accounts/virtual/${encodeURIComponent(providerCustomerId)}/bvn`, {
      bvn: input.value,
      first_name: input.firstName,
      last_name: input.lastName,
    });
    return { accepted: true, message: 'BVN submitted to Mono for asynchronous verification' };
  }

  /**
   * Mono accounts are assigned at createCustomer time.
   * This returns the existing account for the given customer ID.
   */
  async assignVirtualAccount(providerCustomerId: string): Promise<VirtualAccountRecord> {
    const res = await monoRequest<MonoVirtualAccountResponse>(
      'GET',
      `/v2/accounts/virtual/${encodeURIComponent(providerCustomerId)}`
    );
    return {
      providerAccountId: res.data.id,
      accountNumber: res.data.account_number,
      accountName: res.data.account_name,
      bankName: res.data.bank?.name ?? 'Providus Bank',
      currency: 'NGN',
      active: res.data.is_permanent,
      mode: monoSecretKey().includes('live') ? 'live' : 'test',
    };
  }

  async listVirtualAccounts(userId: string): Promise<VirtualAccountRecord[]> {
    try {
      const res = await monoRequest<MonoVirtualAccountResponse>(
        'GET',
        `/v2/accounts/virtual?reference=${encodeURIComponent(userId)}`
      );
      if (!res.data?.account_number) return [];
      return [
        {
          providerAccountId: res.data.id,
          accountNumber: res.data.account_number,
          accountName: res.data.account_name,
          bankName: res.data.bank?.name ?? 'Providus Bank',
          currency: 'NGN',
          active: res.data.is_permanent,
          mode: monoSecretKey().includes('live') ? 'live' : 'test',
        },
      ];
    } catch {
      return [];
    }
  }

  // ── Webhook: signature + typed event parsing ───────────────────────────────

  /**
   * Mono signs webhooks with HMAC-SHA512 using MONO_WEBHOOK_SECRET.
   * Header: mono-webhook-signature
   */
  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string>): boolean {
    const secret = monoWebhookSecret();
    if (!secret) {
      console.error('[MonoBankingRailAdapter] MONO_WEBHOOK_SECRET is not set — rejecting all webhooks');
      return false;
    }
    const signature = headers['mono-webhook-signature'];
    if (!signature) return false;

    const computed = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
    const computedBuf = Buffer.from(computed);
    const sigBuf = Buffer.from(signature);
    if (computedBuf.length !== sigBuf.length) return false;
    return crypto.timingSafeEqual(computedBuf, sigBuf);
  }

  parseWebhookEvent(rawBody: Buffer): BankingRailEvent {
    let payload: any;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { type: 'ignored', originalType: 'parse_error' };
    }

    const event: string = payload?.event ?? '';
    const data = payload?.data ?? {};

    switch (event) {
      case 'mono.virtual_account.created': {
        const userId: string = data?.reference ?? '';
        const providerCustomerId: string = data?.id ?? '';
        return { type: 'identity.success', userId, providerCustomerId };
      }

      case 'mono.virtual_account.bvn_verified':
      case 'mono.virtual_account.identity_verified': {
        const userId: string = data?.reference ?? '';
        const providerCustomerId: string = data?.id ?? '';
        return { type: 'identity.success', userId, providerCustomerId };
      }

      case 'mono.virtual_account.bvn_failed':
      case 'mono.virtual_account.identity_failed': {
        const userId: string = data?.reference ?? '';
        const reason: string = data?.reason ?? 'Identity verification failed.';
        return { type: 'identity.failed', userId, reason };
      }

      case 'mono.virtual_account.funded': {
        const userId: string = data?.reference ?? '';
        const providerCustomerId: string = data?.id ?? '';
        const reference: string = data?.transaction?.reference ?? data?.reference ?? '';
        const amountKobo: number = typeof data?.transaction?.amount === 'number'
          ? data.transaction.amount
          : typeof data?.amount === 'number' ? data.amount : 0;
        const currency: string = (data?.currency ?? data?.transaction?.currency ?? 'NGN').toUpperCase();
        if (currency !== 'NGN') return { type: 'ignored', originalType: event };
        return {
          type: 'deposit.received',
          userId,
          amountKobo,
          reference,
          currency: 'NGN',
          providerCustomerId,
        };
      }

      case 'mono.outward_payment.successful':
      case 'mono.transfer.successful': {
        const providerRef: string = data?.reference ?? '';
        const amountKobo: number = typeof data?.amount === 'number' ? data.amount : 0;
        return { type: 'transfer.success', providerRef, amountKobo };
      }

      case 'mono.outward_payment.failed':
      case 'mono.transfer.failed': {
        const providerRef: string = data?.reference ?? '';
        const reason: string = data?.reason ?? 'Transfer failed.';
        return { type: 'transfer.failed', providerRef, reason };
      }

      case 'mono.outward_payment.reversed':
      case 'mono.transfer.reversed': {
        const providerRef: string = data?.reference ?? '';
        const amountKobo: number = typeof data?.amount === 'number' ? data.amount : 0;
        return { type: 'transfer.reversed', providerRef, amountKobo };
      }

      default:
        return { type: 'ignored', originalType: event };
    }
  }

  // ── Outbound: cashout payout ───────────────────────────────────────────────

  /**
   * Initiate payout via Mono's POST /v2/payments/transfer.
   * providerRef is the stable idempotency key — never retry without querying
   * getTransfer() first if status is unknown.
   */
  async createTransfer(input: CreateTransferInput): Promise<TransferRecord> {
    const body = {
      amount: input.amountKobo,       // Mono uses kobo (smallest unit)
      reference: input.providerRef,   // stable idempotency key
      account_number: input.accountNumber,
      bank_code: input.bankCode,
      narration: input.narration ?? `Sivan payout for user ${input.userId}`,
    };

    const res = await monoRequest<MonoTransferResponse>('POST', '/v2/payments/transfer', body);

    return {
      providerRef: res.data.reference,
      providerTransferId: res.data.id,
      status: this._mapMonoTransferStatus(res.data.status),
      amountKobo: res.data.amount,
      raw: res.data,
    };
  }

  /**
   * Query transfer status from Mono.
   * Called when a webhook is delayed, times out, or unknown status is observed.
   * Unknown status MUST be treated as potentially committed — never refund on
   * unknown status alone.
   */
  async getTransfer(providerRef: string): Promise<TransferRecord> {
    const res = await monoRequest<MonoTransferResponse>(
      'GET',
      `/v2/payments/transfer/${encodeURIComponent(providerRef)}`
    );
    return {
      providerRef: res.data.reference,
      providerTransferId: res.data.id,
      status: this._mapMonoTransferStatus(res.data.status),
      amountKobo: res.data.amount,
      failureReason: res.data.reason,
      raw: res.data,
    };
  }

  private _mapMonoTransferStatus(monoStatus: string): TransferRecord['status'] {
    switch (monoStatus) {
      case 'pending':    return 'pending';
      case 'successful': return 'success';
      case 'failed':     return 'failed';
      case 'reversed':   return 'reversed';
      default:           return 'pending'; // treat unknown as pending per AGENTS.md rule
    }
  }

  // ── Health ─────────────────────────────────────────────────────────────────

  async health(): Promise<{ status: 'ok' | 'degraded'; latencyMs: number; detail?: string }> {
    const start = Date.now();
    try {
      await monoRequest('GET', '/v2/accounts/virtual?limit=1', undefined, 5_000);
      return { status: 'ok', latencyMs: Date.now() - start };
    } catch (error) {
      return {
        status: 'degraded',
        latencyMs: Date.now() - start,
        detail: error instanceof MonoApiError
          ? (error.monoMessage ?? error.message)
          : String(error),
      };
    }
  }
}
