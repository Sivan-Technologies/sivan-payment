/**
 * 9PSB CHECKOUT PROVIDER ADAPTER
 *
 * Implements ICheckoutProvider for 9PSB (9 Payment Service Bank) Inflow Gateway.
 * Enables direct Dynamic Virtual Account and checkout order generation.
 */

import type {
  ICheckoutProvider,
  CheckoutProviderName,
  CreateCheckoutInput,
  CheckoutOrderResult,
  CheckoutVerificationResult,
} from './checkout-provider.interface.js';

export class NinePsbCheckoutProvider implements ICheckoutProvider {
  public readonly name: CheckoutProviderName = '9psb';

  private clientId(): string {
    return (
      process.env.NINEPSB_CLIENT_ID ||
      process.env.NINEPSB_MERCHANT_ID ||
      process.env.NINEPSB_TEST_CLIENT_ID ||
      ''
    ).trim();
  }

  private clientSecret(): string {
    return (
      process.env.NINEPSB_CLIENT_SECRET ||
      process.env.NINEPSB_TEST_CLIENT_SECRET ||
      ''
    ).trim();
  }

  private publicKey(): string {
    return (
      process.env.NINEPSB_PUBLIC_KEY ||
      process.env.NINEPSB_API_KEY ||
      ''
    ).trim();
  }

  private baseUrl(): string {
    const isProd = (process.env.APP_ENV || 'staging') === 'production';
    if (isProd) {
      return (process.env.NINEPSB_LIVE_BASE_URL || 'https://api.9psbng.com').replace(/\/+$/, '');
    }
    return (process.env.NINEPSB_BASE_URL || 'https://sandbox.9psbng.com').replace(/\/+$/, '');
  }

  public isConfigured(): boolean {
    return Boolean(this.clientId() && (this.clientSecret() || this.publicKey()));
  }

  public async createCheckoutOrder(input: CreateCheckoutInput): Promise<CheckoutOrderResult> {
    if (!this.isConfigured()) {
      throw new Error(
        '9PSB Checkout is selected but credentials are not configured. Set NINEPSB_CLIENT_ID and NINEPSB_CLIENT_SECRET in environment variables.'
      );
    }

    const { userId, amountNgn, customerEmail, purpose, agreementId, callbackUrl } = input;
    const prefix = purpose === 'fund_agreement' ? 'sivan_agr' : 'sivan_dep';
    const cleanUserId = userId.replace(/[^a-zA-Z0-9_]/g, '_').slice(-16);
    const orderReference = input.orderReference || `${prefix}_9psb_${cleanUserId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const url = `${this.baseUrl()}/api/v1/checkout/initialize`;
    const payload = {
      merchantId: this.clientId(),
      transactionReference: orderReference,
      amount: Number(amountNgn.toFixed(2)),
      currency: 'NGN',
      customer: {
        userId,
        email: customerEmail || `${cleanUserId}@users.sivantech.online`,
      },
      callbackUrl: callbackUrl || process.env.NINEPSB_CHECKOUT_CALLBACK_URL || 'https://app.sivantech.online/history',
      metadata: {
        purpose,
        userId,
        ...(agreementId ? { agreementId } : {}),
        platform: 'sivan_payment_ai',
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.clientSecret() || this.publicKey()}`,
      },
      body: JSON.stringify(payload),
    });

    const json: any = await res.json().catch(() => null);

    if (!res.ok || (json?.status !== 'success' && !json?.checkoutUrl && !json?.data?.checkoutUrl)) {
      const msg = json?.message || `HTTP ${res.status}`;
      throw new Error(`9PSB checkout order creation failed: ${msg}`);
    }

    const checkoutLink = json?.data?.checkoutUrl || json?.checkoutUrl || json?.data?.paymentUrl;
    if (!checkoutLink) {
      throw new Error(`9PSB order response missing checkout URL: ${JSON.stringify(json)}`);
    }

    return {
      provider: this.name,
      checkoutLink,
      orderReference,
      amountNgn,
      currency: 'NGN',
      allowedPaymentMethods: ['Transfer', 'Card'],
      purpose,
      agreementId,
    };
  }

  public async verifyCheckoutOrder(orderReference: string): Promise<CheckoutVerificationResult> {
    if (!this.isConfigured()) {
      throw new Error(
        '9PSB Checkout is selected but credentials are not configured. Set NINEPSB_CLIENT_ID and NINEPSB_CLIENT_SECRET.'
      );
    }

    const url = `${this.baseUrl()}/api/v1/transaction/verify/${encodeURIComponent(orderReference)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.clientSecret() || this.publicKey()}`,
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
    const data = json?.data || json;
    const statusStr = String(data?.status || json?.status || 'pending').toUpperCase();
    const isSuccess = statusStr === 'SUCCESS' || statusStr === 'COMPLETED' || statusStr === '00';

    const metadata = data?.metadata || {};
    const purpose = metadata?.purpose || (orderReference.startsWith('sivan_agr_') ? 'fund_agreement' : 'deposit');
    const userId = metadata?.userId || data?.customer?.userId;
    const agreementId = metadata?.agreementId;
    const amountNgn = Number(data?.amount || 0);

    return {
      provider: this.name,
      verified: isSuccess,
      status: isSuccess ? 'SUCCESS' : (statusStr === 'FAILED' ? 'FAILED' : 'PENDING'),
      amountNgn,
      orderReference,
      transactionId: data?.transactionId || data?.id,
      customerEmail: data?.customer?.email,
      paymentMethod: data?.channel || '9PSB',
      purpose,
      userId,
      agreementId,
      raw: json,
    };
  }
}
