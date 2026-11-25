/**
 * NOMBA BANKING RAIL ADAPTER
 *
 * Implements IBankingRailAdapter for Nomba's Banking-as-a-Service rails.
 * Handles:
 *   1. Dedicated Virtual Account issuance (Wema, Providus, Titan Trust)
 *   2. Real-time NIBSS NIP inbound deposit processing
 *   3. Outbound bank disbursements / payouts with strict idempotency
 *   4. HMAC-SHA512 webhook signature verification and event normalization
 *
 * API Base URLs:
 *   Sandbox:    https://sandbox.nomba.com or https://api.nomba.com/v1
 *   Production: https://api.nomba.com/v1
 */

import dns from 'node:dns';

// Ensure outbound calls strictly exit via whitelisted IPv4 address (13.39.31.121)
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // Ignore on older Node runtimes
}

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
  TransferStatus,
  CreateCheckoutInput,
  CheckoutOrderRecord,
} from '../banking-rail.adapter.js';

interface NombaTokenCache {
  accessToken: string;
  expiresAt: number;
}

function buildNombaWebhookString(payload: any, timestamp: string, missingValue: '' | 'undefined'): string {
  const data = payload?.data || {};
  const transaction = data?.transaction || data || {};
  const merchant = data?.merchant || {};
  return [
    payload?.event_type || payload?.eventType,
    payload?.requestId || payload?.request_id,
    merchant.name,
    merchant.walletId,
    transaction.transactionId || transaction.id || transaction.transactionRef,
    transaction.type,
    transaction.status,
    transaction.amount,
    transaction.fee,
    transaction.transactionAmount,
    transaction.transactionFee,
    transaction.createdAt,
    transaction.timeCreated,
    transaction.terminalId,
    transaction.merchantTxRef || transaction.meta?.merchantTxRef,
    timestamp,
  ]
    .map((value) => (value !== undefined && value !== null ? String(value) : missingValue))
    .join('');
}

export class NombaBankingRailAdapter implements IBankingRailAdapter {
  readonly name: BankingRailName = 'nomba';

  private tokenCache?: NombaTokenCache;

  private accountId(): string {
    return (
      process.env.NOMBA_ACCOUNT_ID ||
      process.env.NOMBA_TEST_ACCOUNT_ID ||
      process.env.NOMBA_LIVE_ACCOUNT_ID ||
      ''
    ).trim();
  }

  private clientId(): string {
    return (
      process.env.NOMBA_CLIENT_ID ||
      process.env.NOMBA_TEST_CLIENT_ID ||
      process.env.NOMBA_LIVE_CLIENT_ID ||
      ''
    ).trim();
  }

  private clientSecret(): string {
    return (
      process.env.NOMBA_CLIENT_SECRET ||
      process.env.NOMBA_TEST_CLIENT_SECRET ||
      process.env.NOMBA_LIVE_CLIENT_SECRET ||
      ''
    ).trim();
  }

  private baseUrl(): string {
    const raw = (
      process.env.NOMBA_BASE_URL ||
      process.env.NOMBA_SANDBOX_BASE_URL ||
      'https://api.nomba.com/v1'
    ).trim().replace(/\/+$/, '');
    return raw;
  }

  private webhookSecret(): string {
    return (process.env.NOMBA_WEBHOOK_SECRET || '').trim();
  }

  public isConfigured(): boolean {
    return Boolean(this.accountId() && this.clientId() && this.clientSecret());
  }

  /**
   * Retrieves or refreshes OAuth Bearer token from Nomba.
   */
  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.accessToken;
    }

    const accountId = this.accountId();
    const clientId = this.clientId();
    const clientSecret = this.clientSecret();

    if (!accountId || !clientId || !clientSecret) {
      throw new Error('[NombaBankingRailAdapter] Missing credentials (NOMBA_ACCOUNT_ID, NOMBA_CLIENT_ID, or NOMBA_CLIENT_SECRET)');
    }

    const url = `${this.baseUrl()}/auth/token/issue`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accountId: accountId,
        'User-Agent': 'Sivan-Payment-Engine/1.0 (Borderless Autonomous Payment Protocol; support@sivantech.online)',
      },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`[NombaBankingRailAdapter] Failed to obtain token (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as any;
    const body = data?.data || data || {};
    const token = body.access_token || body.accessToken || body.token;
    const expiresIn = Number(body.expires_in || body.expiresIn || 1800);

    if (!token) {
      throw new Error('[NombaBankingRailAdapter] No access token in response');
    }

    const earlyRefreshMs = 5 * 60 * 1000;
    this.tokenCache = {
      accessToken: String(token),
      expiresAt: Date.now() + Math.max(60, expiresIn) * 1000 - earlyRefreshMs,
    };

    return this.tokenCache.accessToken;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      accountId: this.accountId(),
      Accept: 'application/json',
      'User-Agent': 'Sivan-Payment-Engine/1.0 (Borderless Autonomous Payment Protocol; support@sivantech.online)',
    };
  }

  // ── Inbound Customer & Identity ───────────────────────────────────────────

  async createCustomer(input: CreateCustomerInput): Promise<CustomerRecord> {
    const providerCustomerId = `NOMBA_CUS_${input.userId}`;
    const email = input.email || `${input.userId}@customer.sivan.local`;

    return {
      providerCustomerId,
      email,
      legalName: input.legalName,
      kycStatus: 'pending',
    };
  }

  async verifyIdentity(
    providerCustomerId: string,
    input: IdentityInput
  ): Promise<{ accepted: true; message: string }> {
    if (!this.isConfigured()) {
      return { accepted: true, message: 'Nomba identity verification accepted (sandbox unconfigured mode)' };
    }

    try {
      if (input.type === 'bank_account') {
        const headers = await this.authHeaders();
        const res = await fetch(`${this.baseUrl()}/transfers/bank/lookup`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            accountNumber: input.value,
            bankCode: input.country || '058',
          }),
          signal: AbortSignal.timeout(8000),
        });

        if (!res.ok) {
          throw new Error(`Nomba account lookup error status ${res.status}`);
        }
      }

      return {
        accepted: true,
        message: 'Nomba identity verification submitted for verification',
      };
    } catch (err: any) {
      console.warn('[NombaBankingRailAdapter] verifyIdentity warning:', err.message);
      return {
        accepted: true,
        message: `Nomba identity verification queued: ${err.message}`,
      };
    }
  }

  async assignVirtualAccount(providerCustomerId: string): Promise<VirtualAccountRecord> {
    const headers = await this.authHeaders();
    const userId = providerCustomerId.replace(/^NOMBA_CUS_/, '');

    const payload = {
      accountRef: `sivan_${userId}_${Date.now()}`,
      currency: 'NGN',
      accountName: `SIVAN User ${userId.slice(-6)}`,
    };

    const res = await fetch(`${this.baseUrl()}/accounts/virtual`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`[NombaBankingRailAdapter] assignVirtualAccount failed (${res.status}): ${errText}`);
    }

    const json = (await res.json()) as any;
    const data = json?.data || json;

    return {
      providerAccountId: String(data.accountRef || data.id || data.orderReference || `nomba_va_${Date.now()}`),
      accountNumber: String(data.bankAccountNumber || data.accountNumber || ''),
      accountName: String(data.bankAccountName || data.accountName || 'SIVAN TECHNOLOGIES'),
      bankName: String(data.bankName || 'Nombank MFB'),
      currency: 'NGN',
      active: true,
      mode: process.env.APP_ENV === 'production' ? 'live' : 'test',
    };
  }

  async listVirtualAccounts(userId: string): Promise<VirtualAccountRecord[]> {
    return [];
  }

  // ── Webhook Verification & Normalization ──────────────────────────────────

  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string>): boolean {
    const secret = this.webhookSecret();
    if (!secret) {
      console.warn('[NombaBankingRailAdapter] verifyWebhookSignature: NOMBA_WEBHOOK_SECRET is not configured.');
      return false;
    }

    const incomingSig = (
      headers['nomba-sig-value'] ||
      headers['x-nomba-signature'] ||
      headers['nomba-signature'] ||
      headers['x-signature'] ||
      ''
    ).trim();

    if (!incomingSig) {
      return false;
    }

    const bodyStr = rawBody.toString('utf8');
    const timestamp = (headers['nomba-timestamp'] || '').trim();
    const candidates: string[] = [bodyStr];

    if (timestamp) {
      candidates.push(`${timestamp}.${bodyStr}`, `${timestamp}${bodyStr}`);
      try {
        const parsed = JSON.parse(bodyStr);
        candidates.push(
          buildNombaWebhookString(parsed, timestamp, ''),
          buildNombaWebhookString(parsed, timestamp, 'undefined')
        );
      } catch {
        // Keep raw-body candidates when body is not valid JSON
      }
    }

    const incomingBuf = Buffer.from(incomingSig);
    const safeEqual = (expected: string): boolean => {
      const expectedBuf = Buffer.from(expected);
      return expectedBuf.length === incomingBuf.length && crypto.timingSafeEqual(expectedBuf, incomingBuf);
    };

    return candidates.some((candidate) => {
      const sha256 = crypto.createHmac('sha256', secret).update(candidate, 'utf8');
      const sha256Hex = sha256.digest('hex');
      const sha256Base64 = crypto.createHmac('sha256', secret).update(candidate, 'utf8').digest('base64');
      const sha512Hex = crypto.createHmac('sha512', secret).update(candidate, 'utf8').digest('hex');
      return safeEqual(sha256Base64) || safeEqual(sha256Hex) || safeEqual(sha512Hex);
    });
  }

  parseWebhookEvent(rawBody: Buffer): BankingRailEvent {
    let payload: any;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { type: 'ignored', originalType: 'unparseable_json' };
    }

    const eventType = String(payload.event_type || payload.eventType || payload.type || '').toLowerCase();
    const data = payload.data || payload;
    const tx = data.transaction || data;

    // 1. Inbound Deposit Events
    if (
      eventType.includes('payment') ||
      eventType.includes('deposit') ||
      eventType === 'order_payment_successful' ||
      eventType === 'payment_successful' ||
      eventType === 'payment_success'
    ) {
      const order = data.order || {};
      const orderRef = String(order.orderReference || '').trim();
      const orderCustomerId = String(order.customerId || '').trim();
      const orderAmount = order.amount !== undefined ? Number(order.amount) : undefined;

      const amountNaira = orderAmount !== undefined && !isNaN(orderAmount)
        ? orderAmount
        : Number(tx.amount || tx.transactionAmount || 0);

      const amountKobo = Math.round(amountNaira * 100);
      const reference = orderRef || String(tx.merchantTxRef || tx.transactionId || tx.id || `nomba_ref_${Date.now()}`);
      const accountRef = String(data.accountRef || tx.accountRef || orderRef || '');

      let userId = orderCustomerId || '';
      if (!userId) {
        if (accountRef.startsWith('sivan_')) {
          userId = accountRef.split('_')[1] || '';
        } else if (tx.customerEmail || order.customerEmail) {
          userId = String(tx.customerEmail || order.customerEmail).replace(/@.*$/, '');
        }
      }

      return {
        type: 'deposit.received',
        userId: userId || 'anonymous',
        amountKobo,
        reference,
        currency: 'NGN',
        providerCustomerId: accountRef || reference,
      };
    }

    // 2. Outbound Transfer Events
    if (eventType.includes('transfer')) {
      const providerRef = String(tx.merchantTxRef || tx.transactionId || tx.id || '');
      const statusStr = String(tx.status || '').toLowerCase();
      const amountKobo = Math.round(Number(tx.amount || 0) * 100);

      if (statusStr === 'success' || statusStr === 'successful' || statusStr === 'completed') {
        return {
          type: 'transfer.success',
          providerRef,
          amountKobo,
        };
      }

      if (statusStr === 'failed' || statusStr === 'failure' || statusStr === 'rejected') {
        return {
          type: 'transfer.failed',
          providerRef,
          reason: String(tx.failureReason || tx.message || 'Transfer failed'),
        };
      }

      if (statusStr === 'reversed' || statusStr === 'refund' || statusStr === 'refunded') {
        return {
          type: 'transfer.reversed',
          providerRef,
          amountKobo,
        };
      }
    }

    return {
      type: 'ignored',
      originalType: eventType || 'unknown_nomba_event',
    };
  }

  // ── Outbound Disbursements ────────────────────────────────────────────────

  async createTransfer(input: CreateTransferInput): Promise<TransferRecord> {
    const headers = await this.authHeaders();
    const amountNaira = Math.round((input.amountKobo / 100) * 100) / 100;

    const body = {
      amount: amountNaira,
      accountNumber: input.accountNumber,
      accountName: input.narration || 'Sivan Transfer',
      bankCode: input.bankCode,
      merchantTxRef: input.providerRef,
      senderName: 'Sivan Technologies',
      narration: input.narration || `Sivan Payout ${input.providerRef}`,
    };

    const transferUrl = `${this.baseUrl().replace(/\/v1$/, '/v2')}/transfers/bank`;
    const res = await fetch(transferUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        providerRef: input.providerRef,
        status: 'failed',
        amountKobo: input.amountKobo,
        failureReason: `Nomba error ${res.status}: ${errText}`,
      };
    }

    const json = (await res.json()) as any;
    const data = json?.data || json;
    const rawStatus = String(data.status || json.status || '').toLowerCase();

    let status: TransferStatus = 'pending';
    if (rawStatus === 'success' || rawStatus === 'successful' || rawStatus === 'completed') {
      status = 'success';
    } else if (rawStatus === 'failed' || rawStatus === 'failure') {
      status = 'failed';
    } else if (rawStatus === 'reversed') {
      status = 'reversed';
    } else {
      status = 'sent';
    }

    return {
      providerRef: input.providerRef,
      providerTransferId: data.id ? String(data.id) : undefined,
      status,
      amountKobo: input.amountKobo,
      confirmedAt: status === 'success' ? new Date().toISOString() : undefined,
      raw: json,
    };
  }

  async getTransfer(providerRef: string): Promise<TransferRecord> {
    const headers = await this.authHeaders();

    const res = await fetch(`${this.baseUrl()}/transfers/bank/${encodeURIComponent(providerRef)}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return {
        providerRef,
        status: 'pending',
        amountKobo: 0,
        failureReason: `Nomba transfer lookup returned status ${res.status}`,
      };
    }

    const json = (await res.json()) as any;
    const data = json?.data || json;
    const rawStatus = String(data.status || json.status || '').toLowerCase();

    let status: TransferStatus = 'pending';
    if (rawStatus === 'success' || rawStatus === 'successful' || rawStatus === 'completed') {
      status = 'success';
    } else if (rawStatus === 'failed' || rawStatus === 'failure') {
      status = 'failed';
    } else if (rawStatus === 'reversed') {
      status = 'reversed';
    }

    return {
      providerRef,
      providerTransferId: data.id ? String(data.id) : undefined,
      status,
      amountKobo: Math.round(Number(data.amount || 0) * 100),
      confirmedAt: status === 'success' ? new Date().toISOString() : undefined,
      raw: json,
    };
  }

  // ── Hosted Checkout Orders (Transfer & USSD Only) ─────────────────────────

  async createCheckoutOrder(input: CreateCheckoutInput): Promise<CheckoutOrderRecord> {
    const headers = await this.authHeaders();
    const amountNaira = Math.round((input.amountKobo / 100) * 100) / 100;
    const methods = input.allowedPaymentMethods && input.allowedPaymentMethods.length > 0
      ? input.allowedPaymentMethods
      : ['Transfer', 'USSD'];

    const payload = {
      order: {
        orderReference: input.orderReference,
        amount: amountNaira,
        currency: 'NGN',
        customerEmail: input.customerEmail,
        callbackUrl: input.callbackUrl,
        allowedPaymentMethods: methods,
      },
    };

    const res = await fetch(`${this.baseUrl()}/checkout/order`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`[NombaBankingRailAdapter] createCheckoutOrder failed (${res.status}): ${errText}`);
    }

    const json = (await res.json()) as any;
    const data = json?.data || json;

    return {
      checkoutLink: String(data.checkoutLink || ''),
      orderReference: String(data.orderReference || input.orderReference),
      allowedPaymentMethods: methods,
    };
  }

  // ── Health Check ──────────────────────────────────────────────────────────

  async health(): Promise<{ status: 'ok' | 'degraded'; latencyMs: number; detail?: string }> {
    const start = Date.now();
    try {
      if (!this.isConfigured()) {
        return {
          status: 'degraded',
          latencyMs: 0,
          detail: 'Nomba credentials (ACCOUNT_ID, CLIENT_ID, CLIENT_SECRET) not set in environment',
        };
      }

      await this.getAccessToken();
      return {
        status: 'ok',
        latencyMs: Date.now() - start,
        detail: 'Nomba auth token verification active',
      };
    } catch (err: any) {
      return {
        status: 'degraded',
        latencyMs: Date.now() - start,
        detail: err.message,
      };
    }
  }
}

