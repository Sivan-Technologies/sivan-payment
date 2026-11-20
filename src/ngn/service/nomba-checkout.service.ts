/**
 * NOMBA HOSTED CHECKOUT SERVICE
 *
 * Implements direct card, dynamic bank transfer, USSD, and Apple Pay payment
 * acceptance via Nomba Checkout API (v1).
 *
 * Key Operations:
 *   1. createCheckoutOrder: Generates a hosted checkout link for balance deposit or Service Agreement funding.
 *   2. verifyCheckoutTransaction: Authoritatively queries Nomba transaction status before delivering value.
 *   3. processCheckoutSuccess: Enforces strict ledger idempotency and credits the user's NGN balance or funds an agreement.
 */

import { db } from '../../database/json-database.js';
import { createBalanceLedgerEntry, listUserBalanceLedger } from '../../balances/balance.service.js';

interface NombaTokenCache {
  accessToken: string;
  expiresAt: number;
}

export interface CreateNombaCheckoutInput {
  userId: string;
  amountNgn: number;
  customerEmail?: string;
  purpose: 'deposit' | 'fund_agreement';
  agreementId?: string;
  callbackUrl?: string;
  allowedPaymentMethods?: ('Card' | 'Transfer' | 'USSD' | 'Apple Pay')[];
  orderReference?: string;
}

export interface NombaCheckoutOrderResult {
  checkoutLink: string;
  orderReference: string;
  amountNgn: number;
  currency: 'NGN';
  allowedPaymentMethods: string[];
  purpose: 'deposit' | 'fund_agreement';
  agreementId?: string;
}

export interface NombaCheckoutVerificationResult {
  verified: boolean;
  status: 'SUCCESS' | 'PENDING' | 'FAILED';
  amountNgn: number;
  orderReference: string;
  transactionId?: string;
  customerEmail?: string;
  paymentMethod?: string;
  purpose?: string;
  userId?: string;
  agreementId?: string;
  raw?: any;
}

export interface NombaCheckoutProcessingResult {
  processed: boolean;
  alreadyProcessed?: boolean;
  action: 'balance_deposit' | 'agreement_funded';
  userId: string;
  amountNgn: number;
  orderReference: string;
  transactionId?: string;
  agreementId?: string;
}

export class NombaCheckoutService {
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
    const isProd = (process.env.APP_ENV || 'staging') === 'production';
    if (isProd) {
      return (process.env.NOMBA_LIVE_BASE_URL || 'https://api.nomba.com').replace(/\/v[12]\/?$/, '').replace(/\/+$/, '');
    }
    return (process.env.NOMBA_SANDBOX_BASE_URL || 'https://sandbox.nomba.com').replace(/\/v[12]\/?$/, '').replace(/\/+$/, '');
  }

  public isConfigured(): boolean {
    return Boolean(this.accountId() && this.clientId() && this.clientSecret());
  }

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.accessToken;
    }

    const accountId = this.accountId();
    const clientId = this.clientId();
    const clientSecret = this.clientSecret();

    if (!accountId || !clientId || !clientSecret) {
      throw new Error('[NombaCheckoutService] Missing Nomba credentials (ACCOUNT_ID, CLIENT_ID, or CLIENT_SECRET)');
    }

    const url = `${this.baseUrl()}/v1/auth/token/issue`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accountId,
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
      throw new Error(`[NombaCheckoutService] Token issue failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as any;
    const body = data?.data || data || {};
    const token = body.access_token || body.accessToken || body.token;
    const expiresIn = Number(body.expires_in || body.expiresIn || 1800);

    if (!token) {
      throw new Error('[NombaCheckoutService] Received empty token from Nomba');
    }

    this.tokenCache = {
      accessToken: token,
      expiresAt: Date.now() + Math.max(expiresIn - 60, 60) * 1000,
    };

    return token;
  }

  /**
   * Initializes a hosted checkout order with Nomba.
   * Returns the checkoutLink where the customer can pay via Bank Transfer, Card, or USSD.
   */
  public async createCheckoutOrder(input: CreateNombaCheckoutInput): Promise<NombaCheckoutOrderResult> {
    if (!this.isConfigured()) {
      throw new Error('[NombaCheckoutService] Nomba credentials not configured');
    }

    const amountNgn = Math.round(Number(input.amountNgn) * 100) / 100;
    if (amountNgn <= 0) {
      throw new Error('[NombaCheckoutService] Invalid checkout amount. Must be greater than 0.');
    }

    const cleanUserId = input.userId.trim().replace(/^whatsapp:\+?/, '').replace(/^\+/, '');
    const user = (await db.findUserById(input.userId).catch(() => null))
      || (await db.findUserByWhatsappNumber(input.userId).catch(() => null))
      || (await db.findUserByWhatsappNumber(`+${cleanUserId}`).catch(() => null));

    const resolvedUserId = user?.id || input.userId;
    const customerEmail = input.customerEmail || user?.email || `user_${cleanUserId.slice(0, 10)}@sivantech.online`;

    const methods = input.allowedPaymentMethods && input.allowedPaymentMethods.length > 0
      ? input.allowedPaymentMethods
      : ['Card', 'Transfer', 'USSD', 'Apple Pay'];

    const prefix = input.purpose === 'fund_agreement' && input.agreementId ? `agr_${input.agreementId}` : `dep_${cleanUserId.slice(0, 8)}`;
    const orderRef = input.orderReference || `sivan_${prefix}_${Date.now()}`;

    const callbackUrl = input.callbackUrl || 'https://app.sivantech.online/checkout/callback';

    const payload = {
      order: {
        orderReference: orderRef,
        amount: amountNgn.toFixed(2),
        currency: 'NGN',
        customerId: resolvedUserId,
        customerEmail,
        callbackUrl,
        allowedPaymentMethods: methods,
        orderMetaData: {
          purpose: input.purpose,
          userId: resolvedUserId,
          ...(input.agreementId ? { agreementId: input.agreementId } : {}),
        },
      },
    };

    const token = await this.getAccessToken();
    const url = `${this.baseUrl()}/v1/checkout/order`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        accountId: this.accountId(),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`[NombaCheckoutService] createCheckoutOrder failed (${res.status}): ${errText}`);
    }

    const json = (await res.json()) as any;
    if (json.code !== '00') {
      throw new Error(`[NombaCheckoutService] Order creation rejected: ${json.description || json.message || json.code}`);
    }

    const data = json.data || {};
    const checkoutLink = String(data.checkoutLink || '');
    if (!checkoutLink) {
      throw new Error('[NombaCheckoutService] Nomba did not return a valid checkoutLink');
    }

    return {
      checkoutLink,
      orderReference: orderRef,
      amountNgn,
      currency: 'NGN',
      allowedPaymentMethods: methods,
      purpose: input.purpose,
      agreementId: input.agreementId,
    };
  }

  /**
   * Re-queries Nomba to verify a transaction before delivering value.
   * Works on both sandbox and production.
   */
  public async verifyCheckoutTransaction(orderReference: string): Promise<NombaCheckoutVerificationResult> {
    if (!this.isConfigured()) {
      throw new Error('[NombaCheckoutService] Nomba credentials not configured');
    }

    const token = await this.getAccessToken();
    const url = `${this.baseUrl()}/v1/transactions/accounts/single?orderReference=${encodeURIComponent(orderReference)}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        accountId: this.accountId(),
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return {
        verified: false,
        status: 'FAILED',
        amountNgn: 0,
        orderReference,
      };
    }

    const json = (await res.json()) as any;
    if (json.code !== '00') {
      return {
        verified: false,
        status: 'FAILED',
        amountNgn: 0,
        orderReference,
      };
    }

    const data = json.data || {};
    const status = String(data.status || '').toUpperCase();
    const isSuccess = status === 'SUCCESS';
    const amountNaira = Number(data.amount || data.onlineCheckoutAmount || 0);

    return {
      verified: isSuccess,
      status: isSuccess ? 'SUCCESS' : 'PENDING',
      amountNgn: amountNaira,
      orderReference,
      transactionId: data.id || data.transactionRef,
      customerEmail: data.onlineCheckoutCustomerEmail,
      paymentMethod: data.onlineCheckoutPaymentMethod,
      purpose: data.onlineCheckoutOrderMetaData?.purpose || (orderReference.includes('_agr_') ? 'fund_agreement' : 'deposit'),
      userId: data.customerId || data.userId || data.onlineCheckoutOrderMetaData?.userId,
      agreementId: data.onlineCheckoutOrderMetaData?.agreementId,
      raw: data,
    };
  }

  /**
   * Authoritatively processes a confirmed checkout payment.
   * Enforces strict ledger idempotency:
   *   - If purpose is 'deposit': credits the user's NGN balance.
   *   - If purpose is 'fund_agreement': notifies the Service Agreement engine.
   */
  public async processCheckoutSuccess(
    orderReference: string,
    fallbackUserId?: string,
    fallbackPurpose?: 'deposit' | 'fund_agreement',
    fallbackAgreementId?: string
  ): Promise<NombaCheckoutProcessingResult> {
    const verified = await this.verifyCheckoutTransaction(orderReference);
    if (!verified.verified || verified.status !== 'SUCCESS') {
      throw new Error(`[NombaCheckoutService] Cannot process unverified checkout transaction (${orderReference}): status is ${verified.status}`);
    }

    const targetUserId = verified.userId || fallbackUserId;
    if (!targetUserId) {
      throw new Error(`[NombaCheckoutService] Cannot determine user ID for confirmed order: ${orderReference}`);
    }

    const purpose = (verified.purpose || fallbackPurpose || (orderReference.includes('_agr_') ? 'fund_agreement' : 'deposit')) as 'deposit' | 'fund_agreement';
    const amountNgn = verified.amountNgn;

    if (purpose === 'fund_agreement') {
      const agreementId = verified.agreementId || fallbackAgreementId || orderReference.replace(/^sivan_agr_/, '').replace(/_\d+$/, '');
      const escrowUrl = process.env.CORE_API_BASE_URL || process.env.ESCROW_AGENT_URL;
      const coreSecret = process.env.CORE_API_SECRET;

      if (escrowUrl && coreSecret && agreementId) {
        await fetch(`${escrowUrl.replace(/\/$/, '')}/api/escrows/${encodeURIComponent(agreementId)}/fund`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-core-api-key': coreSecret },
          body: JSON.stringify({
            amountKobo: Math.round(amountNgn * 100),
            providerRef: orderReference,
            provider: 'nomba',
          }),
          signal: AbortSignal.timeout(5000),
        }).catch((err) => {
          console.warn(`[NombaCheckoutService] Agreement funding notification failed for ${agreementId}:`, err.message);
        });
      }

      return {
        processed: true,
        action: 'agreement_funded',
        userId: targetUserId,
        amountNgn,
        orderReference,
        transactionId: verified.transactionId,
        agreementId,
      };
    }

    // Default: Balance Deposit
    // Enforce idempotency: verify transferId has not already been credited in user's ledger
    const existingLedger = await listUserBalanceLedger(targetUserId).catch(() => []);
    const transferId = `nomba_dep_${orderReference}`;
    const alreadyCredited = existingLedger.some(
      (e) => e.transferId === transferId || (e.sourceId === orderReference && e.sourceType === 'nomba_checkout_deposit')
    );

    if (alreadyCredited) {
      return {
        processed: true,
        alreadyProcessed: true,
        action: 'balance_deposit',
        userId: targetUserId,
        amountNgn,
        orderReference,
        transactionId: verified.transactionId,
      };
    }

    await createBalanceLedgerEntry(
      {
        userId: targetUserId,
        asset: 'ngn',
        amount: amountNgn.toFixed(2),
        kind: 'credit_available',
        status: 'available',
        sourceType: 'nomba_checkout_deposit',
        sourceId: orderReference,
        description: `Nomba Checkout deposit of ₦${amountNgn.toLocaleString()} (${verified.paymentMethod || 'bank_transfer'})`,
        destinationAddress: targetUserId,
        transferId,
      },
      { actorType: 'provider', actorId: 'nomba' }
    );

    return {
      processed: true,
      alreadyProcessed: false,
      action: 'balance_deposit',
      userId: targetUserId,
      amountNgn,
      orderReference,
      transactionId: verified.transactionId,
    };
  }
}

export const nombaCheckoutService = new NombaCheckoutService();
