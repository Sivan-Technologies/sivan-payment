/**
 * PAYSTACK BANKING RAIL ADAPTER
 *
 * Wraps the existing paystackDvaProvider and paystackDvaService behind the
 * IBankingRailAdapter contract. All inbound (DVA) logic delegates to the
 * existing provider/service files with zero behaviour changes.
 *
 * Gate 6 (cashout) — Phase C:
 * createTransfer() and getTransfer() are fully implemented using the
 * Paystack Transfers API (POST /transfer, GET /transfer/:reference).
 *
 * FINANCIAL INTEGRITY (AGENTS.md highest priority):
 * - createTransfer() uses a stable providerRef that survives retries
 * - Unknown transfer status must be resolved via getTransfer() before retry
 * - transfer.success/failed/reversed all handled explicitly in the webhook handler
 */

import crypto from 'node:crypto';
import {
  paystackWebhookSecret,
  paystackBaseUrl,
  paystackHeaders,
  paystackMode,
} from '../../config/paystackConfig.js';
import {
  createCustomer as paystackCreateCustomer,
  validateCustomerBvnNin,
  assignDedicatedAccount,
  preferredBankForMode,
  pingPaystack,
  PaystackApiError,
} from '../../virtual-accounts/provider/paystackDvaProvider.js';
import {
  paystackCustomerEmail,
  splitLegalName,
  findDvaRecord,
} from '../../virtual-accounts/service/paystackDvaService.js';
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

export class PaystackBankingRailAdapter implements IBankingRailAdapter {
  readonly name: BankingRailName = 'paystack';

  // ── Inbound: customer + virtual account ────────────────────────────────────

  async createCustomer(input: CreateCustomerInput): Promise<CustomerRecord> {
    const { first_name, last_name } = splitLegalName(input.legalName);
    const email = input.email ?? paystackCustomerEmail(input.userId);

    const customer = await paystackCreateCustomer({
      email,
      first_name,
      last_name,
      phone: input.phone ?? '',
      metadata: { sivanUserId: input.userId, ...input.metadata },
    });

    return {
      providerCustomerId: customer.customer_code,
      email: customer.email,
      legalName: `${customer.first_name ?? ''} ${customer.last_name ?? ''}`.trim(),
      kycStatus: customer.identified ? 'verified' : 'pending',
    };
  }

  async verifyIdentity(
    providerCustomerId: string,
    input: IdentityInput
  ): Promise<{ accepted: true; message: string }> {
    return validateCustomerBvnNin(providerCustomerId, {
      country: (input.country ?? 'NG') as 'NG',
      type: input.type,
      value: input.value,
      first_name: input.firstName,
      last_name: input.lastName,
    });
  }

  async assignVirtualAccount(providerCustomerId: string): Promise<VirtualAccountRecord> {
    const account = await assignDedicatedAccount({
      customer: providerCustomerId,
      preferred_bank: preferredBankForMode(),
    });

    return {
      providerAccountId: String(account.id),
      accountNumber: account.account_number,
      accountName: account.account_name,
      bankName: account.bank?.name ?? 'Bank',
      currency: 'NGN',
      active: account.active,
      mode: paystackMode(),
    };
  }

  async listVirtualAccounts(userId: string): Promise<VirtualAccountRecord[]> {
    const record = await findDvaRecord(userId);
    if (!record) return [];

    const raw = record.rawProviderPayload as any;
    if (!raw?.account_number) return [];

    return [
      {
        providerAccountId: record.providerAccountId ?? '',
        accountNumber: raw.account_number,
        accountName: record.accountName ?? raw.account_name ?? '',
        bankName: record.bankName ?? raw?.bank?.name ?? 'Bank',
        currency: 'NGN',
        active: record.status === 'active',
        mode: (raw?.__mode as 'live' | 'test') ?? paystackMode(),
      },
    ];
  }

  // ── Webhook: signature + typed event parsing ───────────────────────────────

  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string>): boolean {
    const signature = headers['x-paystack-signature'];
    if (!signature) return false;

    const secret = paystackWebhookSecret();
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
      case 'customeridentification.success': {
        // Resolve sivanUserId from metadata, fall back to customer_code
        const userId: string =
          data?.customer?.metadata?.sivanUserId ??
          data?.metadata?.sivanUserId ??
          data?.customer?.customer_code ??
          data?.customer_code ??
          '';
        const providerCustomerId: string =
          data?.customer?.customer_code ??
          data?.customer_code ??
          '';
        return { type: 'identity.success', userId, providerCustomerId };
      }

      case 'customeridentification.failed': {
        const userId: string =
          data?.customer?.metadata?.sivanUserId ??
          data?.metadata?.sivanUserId ??
          data?.customer?.customer_code ??
          data?.customer_code ??
          '';
        const providerCustomerId: string =
          data?.customer?.customer_code ??
          data?.customer_code ??
          '';
        const reason: string = data?.reason ?? 'Identity verification failed.';
        return { type: 'identity.failed', userId, reason };
      }

      case 'charge.success': {
        // Only actionable for dedicated_nuban channel in NGN
        const channel: string = data?.channel ?? '';
        const currency: string = (data?.currency ?? '').toUpperCase();
        if (channel !== 'dedicated_nuban' || currency !== 'NGN') {
          return { type: 'ignored', originalType: event };
        }

        const providerCustomerId: string =
          data?.customer?.customer_code ?? '';
        const reference: string = data?.reference ?? '';
        const grossNgn: number = typeof data?.amount === 'number' ? data.amount / 100 : 0;
        const amountKobo: number = Math.round(grossNgn * 100);

        // userId resolved by the webhook handler via DVA record lookup —
        // not from caller-supplied metadata (financial integrity rule)
        return {
          type: 'deposit.received',
          userId: '', // populated by handler after DVA ownership lookup
          amountKobo,
          reference,
          currency: 'NGN',
          providerCustomerId,
        };
      }

      case 'transfer.success': {
        const providerRef: string = data?.reference ?? '';
        const amountKobo: number = typeof data?.amount === 'number' ? data.amount : 0;
        return { type: 'transfer.success', providerRef, amountKobo };
      }

      case 'transfer.failed': {
        const providerRef: string = data?.reference ?? '';
        const reason: string = data?.reason ?? 'Transfer failed.';
        return { type: 'transfer.failed', providerRef, reason };
      }

      case 'transfer.reversed': {
        const providerRef: string = data?.reference ?? '';
        const amountKobo: number = typeof data?.amount === 'number' ? data.amount : 0;
        return { type: 'transfer.reversed', providerRef, amountKobo };
      }

      default:
        return { type: 'ignored', originalType: event };
    }
  }

  // ── Outbound: cashout payout (Gate 6 — Phase C) ───────────────────────────

  /**
   * Initiate a payout to a Nigerian bank account via Paystack Transfers API.
   *
   * FINANCIAL INTEGRITY RULES (AGENTS.md — highest priority):
   * - providerRef is the stable idempotency key submitted as `reference`
   * - If network error or timeout occurs, call getTransfer(providerRef) FIRST
   *   before retrying — never retry blind. Paystack may have committed it.
   * - Unknown status must be treated as potentially committed
   *
   * Paystack requires a recipient_code before initiating a transfer.
   * Step 1: POST /transferrecipient — create or retrieve recipient
   * Step 2: POST /transfer — initiate the transfer
   */
  async createTransfer(input: CreateTransferInput): Promise<TransferRecord> {
    const DEFAULT_TIMEOUT_MS = 20_000;

    // Step 1: Create transfer recipient (Paystack requires this before transfer)
    const recipientBody = {
      type: 'nuban',
      currency: 'NGN',
      account_number: input.accountNumber,
      bank_code: input.bankCode,
      name: `Sivan user ${input.userId}`,
      metadata: { sivanUserId: input.userId },
    };

    let recipientCode: string;
    try {
      const recipientRes = await fetch(`${paystackBaseUrl()}/transferrecipient`, {
        method: 'POST',
        headers: paystackHeaders(),
        body: JSON.stringify(recipientBody),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      const recipientJson: any = await recipientRes.json();
      if (!recipientJson?.status || !recipientJson?.data?.recipient_code) {
        throw new PaystackApiError(
          `Paystack /transferrecipient failed: ${recipientJson?.message ?? 'no recipient_code returned'}`,
          '/transferrecipient',
          recipientRes.status,
          recipientJson?.message
        );
      }
      recipientCode = recipientJson.data.recipient_code;
    } catch (error) {
      if (error instanceof PaystackApiError) throw error;
      throw new PaystackApiError(
        `Paystack /transferrecipient network error: ${String((error as Error)?.message ?? error)}`,
        '/transferrecipient',
        0
      );
    }

    // Step 2: Initiate the transfer with stable providerRef as idempotency key
    const transferBody = {
      source: 'balance',
      amount: input.amountKobo,          // Paystack transfers in kobo
      recipient: recipientCode,
      reference: input.providerRef,       // stable idempotency key — survives retries
      reason: input.narration ?? `Sivan payout for user ${input.userId}`,
    };

    let transferRes: any;
    try {
      const res = await fetch(`${paystackBaseUrl()}/transfer`, {
        method: 'POST',
        headers: paystackHeaders(),
        body: JSON.stringify(transferBody),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      transferRes = await res.json();
      if (!transferRes?.status) {
        throw new PaystackApiError(
          `Paystack /transfer failed: ${transferRes?.message ?? 'no status in response'}`,
          '/transfer',
          res.status,
          transferRes?.message
        );
      }
    } catch (error) {
      if (error instanceof PaystackApiError) throw error;
      throw new PaystackApiError(
        `Paystack /transfer network error: ${String((error as Error)?.message ?? error)}`,
        '/transfer',
        0
      );
    }

    const data = transferRes.data ?? {};
    return {
      providerRef: data.reference ?? input.providerRef,
      providerTransferId: data.transfer_code ?? data.id,
      status: this._mapPaystackTransferStatus(data.status),
      amountKobo: typeof data.amount === 'number' ? data.amount : input.amountKobo,
      raw: data,
    };
  }

  /**
   * Query authoritative transfer status from Paystack.
   *
   * Called when:
   * - A webhook is delayed or not received
   * - Network error occurred during createTransfer (unknown commit status)
   * - Reconciliation sweep needs to confirm pending transfers
   *
   * NEVER refund on unknown status alone — only on explicit 'failed' or
   * 'reversed' confirmed from this call or from the webhook.
   */
  async getTransfer(providerRef: string): Promise<TransferRecord> {
    const DEFAULT_TIMEOUT_MS = 15_000;

    let res: any;
    try {
      const response = await fetch(
        `${paystackBaseUrl()}/transfer?reference=${encodeURIComponent(providerRef)}`,
        {
          method: 'GET',
          headers: paystackHeaders(),
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        }
      );
      res = await response.json();
      if (!res?.status) {
        throw new PaystackApiError(
          `Paystack GET /transfer?reference= failed: ${res?.message ?? 'no response'}`,
          '/transfer',
          response.status,
          res?.message
        );
      }
    } catch (error) {
      if (error instanceof PaystackApiError) throw error;
      throw new PaystackApiError(
        `Paystack GET /transfer network error: ${String((error as Error)?.message ?? error)}`,
        '/transfer',
        0
      );
    }

    // Paystack returns a list — find the one matching our reference
    const transfers: any[] = Array.isArray(res.data) ? res.data : [res.data];
    const match = transfers.find((t: any) => t?.reference === providerRef) ?? transfers[0];

    if (!match) {
      // Not found — treat as pending per financial integrity rule
      return { providerRef, status: 'pending', amountKobo: 0 };
    }

    return {
      providerRef: match.reference ?? providerRef,
      providerTransferId: match.transfer_code ?? match.id,
      status: this._mapPaystackTransferStatus(match.status),
      amountKobo: typeof match.amount === 'number' ? match.amount : 0,
      failureReason: match.reason,
      confirmedAt: match.updated_at,
      raw: match,
    };
  }

  private _mapPaystackTransferStatus(paystackStatus: string): TransferRecord['status'] {
    switch ((paystackStatus ?? '').toLowerCase()) {
      case 'success':
      case 'successful': return 'success';
      case 'failed':
      case 'reversed': return paystackStatus.toLowerCase() as 'failed' | 'reversed';
      case 'pending':
      case 'queued':
      case 'otp':
      default:          return 'pending'; // unknown → pending per AGENTS.md rule
    }
  }

  // ── Health ─────────────────────────────────────────────────────────────────

  async health(): Promise<{ status: 'ok' | 'degraded'; latencyMs: number; detail?: string }> {
    const start = Date.now();
    const ping = await pingPaystack({ timeoutMs: 8_000 });
    const latencyMs = Date.now() - start;

    if (ping.reachable && ping.authenticated) {
      return { status: 'ok', latencyMs };
    }
    return {
      status: 'degraded',
      latencyMs,
      detail: ping.message ?? 'Paystack unreachable or unauthenticated',
    };
  }
}
