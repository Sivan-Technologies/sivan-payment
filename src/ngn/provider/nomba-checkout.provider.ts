/**
 * NOMBA CHECKOUT PROVIDER ADAPTER
 *
 * Implements ICheckoutProvider for Nomba Hosted Checkout API (v1).
 * Supports Cards, Dynamic NIP Bank Transfer, USSD, and Apple Pay.
 */

import type {
  ICheckoutProvider,
  CheckoutProviderName,
  CreateCheckoutInput,
  CheckoutOrderResult,
  CheckoutVerificationResult,
} from './checkout-provider.interface.js';

interface NombaTokenCache {
  accessToken: string;
  expiresAt: number;
}

export class NombaCheckoutProvider implements ICheckoutProvider {
  public readonly name: CheckoutProviderName = 'nomba';
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
    return (process.env.NOMBA_BASE_URL || 'https://sandbox.nomba.com').replace(/\/v[12]\/?$/, '').replace(/\/+$/, '');
  }

  public isConfigured(): boolean {
    return Boolean(this.accountId() && this.clientId() && this.clientSecret());
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60000) {
      return this.tokenCache.accessToken;
    }

    const clientId = this.clientId();
    const clientSecret = this.clientSecret();
    const accountId = this.accountId();

    if (!clientId || !clientSecret || !accountId) {
      throw new Error('Nomba checkout credentials missing. Set NOMBA_CLIENT_ID, NOMBA_CLIENT_SECRET, and NOMBA_ACCOUNT_ID.');
    }

    const url = `${this.baseUrl()}/v1/auth/token/issue`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accountId: accountId,
      },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Nomba token issuance failed with HTTP ${res.status}: ${text}`);
    }

    const payload: any = await res.json();
    const accessToken = payload?.data?.access_token || payload?.access_token;
    const expiresIn = Number(payload?.data?.expires_in || payload?.expires_in || 3600);

    if (!accessToken) {
      throw new Error(`Nomba token response missing access_token: ${JSON.stringify(payload)}`);
    }

    this.tokenCache = {
      accessToken,
      expiresAt: now + expiresIn * 1000,
    };

    return accessToken;
  }

  public async createCheckoutOrder(input: CreateCheckoutInput): Promise<CheckoutOrderResult> {
    const { userId, amountNgn, customerEmail, purpose, agreementId, callbackUrl } = input;

    if (!userId) throw new Error('userId is required for checkout order');
    if (!amountNgn || amountNgn <= 0) throw new Error('amountNgn must be a positive number');

    const prefix = purpose === 'fund_agreement' ? 'sivan_agr' : 'sivan_dep';
    const cleanUserId = userId.replace(/[^a-zA-Z0-9_]/g, '_').slice(-16);
    const orderReference = input.orderReference || `${prefix}_${cleanUserId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const token = await this.getAccessToken();
    const accountId = this.accountId();
    const url = `${this.baseUrl()}/v1/checkout/order`;

    const allowedMethods = input.allowedPaymentMethods || ['Card', 'Transfer', 'USSD', 'Apple Pay'];
    const email = customerEmail || `${cleanUserId}@users.sivantech.online`;

    const body: Record<string, any> = {
      order: {
        orderReference,
        customerId: userId,
        customerEmail: email,
        amount: Number(amountNgn.toFixed(2)),
        currency: 'NGN',
        allowedPaymentMethods: allowedMethods,
        callbackUrl: callbackUrl || process.env.NOMBA_CHECKOUT_CALLBACK_URL || 'https://app.sivantech.online/history',
        orderMetaData: {
          purpose,
          userId,
          ...(agreementId ? { agreementId } : {}),
          platform: 'sivan_payment_ai',
        },
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        accountId: accountId,
      },
      body: JSON.stringify(body),
    });

    const json: any = await res.json().catch(() => null);

    if (!res.ok || (json?.code !== '00' && json?.code !== 'SUCCESS' && !json?.data?.checkoutLink)) {
      const msg = json?.message || json?.description || `HTTP ${res.status}`;
      throw new Error(`Nomba checkout order creation failed: ${msg}`);
    }

    const checkoutLink = json?.data?.checkoutLink;
    if (!checkoutLink) {
      throw new Error(`Nomba order response missing checkoutLink: ${JSON.stringify(json)}`);
    }

    return {
      provider: this.name,
      checkoutLink,
      orderReference,
      amountNgn,
      currency: 'NGN',
      allowedPaymentMethods: allowedMethods,
      purpose,
      agreementId,
    };
  }

  public async verifyCheckoutOrder(orderReference: string): Promise<CheckoutVerificationResult> {
    if (!orderReference) throw new Error('orderReference is required');

    const token = await this.getAccessToken();
    const accountId = this.accountId();
    const url = `${this.baseUrl()}/v1/transactions/accounts/single?orderReference=${encodeURIComponent(orderReference)}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        accountId: accountId,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        provider: this.name,
        verified: false,
        status: 'FAILED',
        amountNgn: 0,
        orderReference,
        raw: { status: res.status, errorText: text },
      };
    }

    const json: any = await res.json().catch(() => null);
    const data = json?.data;
    const status = (data?.status || json?.status || 'PENDING').toUpperCase();
    const isSuccess = status === 'SUCCESS' || status === 'COMPLETED';

    const orderMeta = data?.orderMetaData || data?.metadata || {};
    const purpose = orderMeta?.purpose || (orderReference.startsWith('sivan_agr_') ? 'fund_agreement' : 'deposit');
    const userId = orderMeta?.userId || data?.customerId;
    const agreementId = orderMeta?.agreementId;
    const amountNgn = Number(data?.amount || 0);

    return {
      provider: this.name,
      verified: isSuccess,
      status: isSuccess ? 'SUCCESS' : (status === 'FAILED' ? 'FAILED' : 'PENDING'),
      amountNgn,
      orderReference,
      transactionId: data?.transactionId || data?.id,
      customerEmail: data?.customerEmail,
      paymentMethod: data?.paymentMethod,
      purpose,
      userId,
      agreementId,
      raw: json,
    };
  }
}
