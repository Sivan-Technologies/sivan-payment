/**
 * PAYSTACK BANKING RAIL ADAPTER
 *
 * Wraps the existing paystackDvaProvider and paystackDvaService behind the
 * IBankingRailAdapter contract. Zero behaviour changes — this is a pure
 * extraction. All real logic stays in the existing provider/service files.
 *
 * Gate 6 (cashout): createTransfer() and getTransfer() are stubbed with a
 * clear NOT_IMPLEMENTED error. When Gate 6 is built, implement them here.
 * See FUTURE_BUILD_BANKING_RAIL_ADAPTER.md Phase C.
 */

import crypto from 'node:crypto';
import { paystackWebhookSecret, paystackMode } from '../../config/paystackConfig.js';
import {
  createCustomer as paystackCreateCustomer,
  validateCustomerBvnNin,
  assignDedicatedAccount,
  preferredBankForMode,
  pingPaystack,
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
          data?.customer?.customer_code ??
          '';
        const providerCustomerId: string = data?.customer?.customer_code ?? '';
        return { type: 'identity.success', userId, providerCustomerId };
      }

      case 'customeridentification.failed': {
        const userId: string =
          data?.customer?.metadata?.sivanUserId ??
          data?.customer?.customer_code ??
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

  // ── Outbound: cashout payout (Gate 6 — not yet implemented) ───────────────

  async createTransfer(_input: CreateTransferInput): Promise<TransferRecord> {
    throw new Error(
      '[PaystackBankingRailAdapter] createTransfer() is not yet implemented. ' +
        'See FUTURE_BUILD_BANKING_RAIL_ADAPTER.md Phase C — Gate 6 cashout payout. ' +
        'Do NOT call this in production until Gate 6 is complete.'
    );
  }

  async getTransfer(_providerRef: string): Promise<TransferRecord> {
    throw new Error(
      '[PaystackBankingRailAdapter] getTransfer() is not yet implemented. ' +
        'See FUTURE_BUILD_BANKING_RAIL_ADAPTER.md Phase C — Gate 6 cashout payout.'
    );
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
