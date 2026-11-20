/**
 * PAYSTACK CHECKOUT PROVIDER ADAPTER
 *
 * Implements ICheckoutProvider using Paystack Standard Hosted Checkout.
 * Provides cards, bank transfers, USSD, and Apple Pay payment links.
 */

import type {
  ICheckoutProvider,
  CheckoutProviderName,
  CreateCheckoutInput,
  CheckoutOrderResult,
  CheckoutVerificationResult,
} from './checkout-provider.interface.js';

export class PaystackCheckoutProvider implements ICheckoutProvider {
  public readonly name: CheckoutProviderName = 'paystack';

  private secretKey(): string {
    return (
      process.env.PAYSTACK_SECRET_KEY ||
      process.env.PAYSTACK_LIVE_SECRET_KEY ||
      process.env.PAYSTACK_TEST_SECRET_KEY ||
      ''
    ).trim();
  }

  private baseUrl(): string {
    return 'https://api.paystack.co';
  }

  public isConfigured(): boolean {
    return Boolean(this.secretKey());
  }

  public async createCheckoutOrder(input: CreateCheckoutInput): Promise<CheckoutOrderResult> {
    if (!this.isConfigured()) {
      throw new Error(
        'Paystack Checkout is selected but PAYSTACK_SECRET_KEY is missing from environment.'
      );
    }

    const { userId, amountNgn, customerEmail, purpose, agreementId, callbackUrl } = input;
    const prefix = purpose === 'fund_agreement' ? 'sivan_agr' : 'sivan_dep';
    const cleanUserId = userId.replace(/[^a-zA-Z0-9_]/g, '_').slice(-16);
    const orderReference = input.orderReference || `${prefix}_pstk_${cleanUserId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const url = `${this.baseUrl()}/transaction/initialize`;
    const email = customerEmail || `${cleanUserId}@users.sivantech.online`;

    const payload = {
      email,
      amount: Math.round(amountNgn * 100), // Paystack accepts amounts in kobo
      reference: orderReference,
      callback_url: callbackUrl || process.env.PAYSTACK_CALLBACK_URL || 'https://app.sivantech.online/history',
      channels: ['card', 'bank', 'ussd', 'qr', 'mobile_money', 'bank_transfer'],
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
        Authorization: `Bearer ${this.secretKey()}`,
      },
      body: JSON.stringify(payload),
    });

    const json: any = await res.json().catch(() => null);

    if (!res.ok || !json?.status || !json?.data?.authorization_url) {
      const msg = json?.message || `HTTP ${res.status}`;
      throw new Error(`Paystack checkout order creation failed: ${msg}`);
    }

    const checkoutLink = json.data.authorization_url;

    return {
      provider: this.name,
      checkoutLink,
      orderReference,
      amountNgn,
      currency: 'NGN',
      allowedPaymentMethods: ['Card', 'Transfer', 'USSD', 'Apple Pay'],
      purpose,
      agreementId,
    };
  }

  public async verifyCheckoutOrder(orderReference: string): Promise<CheckoutVerificationResult> {
    if (!this.isConfigured()) {
      throw new Error(
        'Paystack Checkout is selected but PAYSTACK_SECRET_KEY is missing from environment.'
      );
    }

    const url = `${this.baseUrl()}/transaction/verify/${encodeURIComponent(orderReference)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.secretKey()}`,
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
    const isSuccess = Boolean(json?.status && data?.status === 'success');
    const metadata = data?.metadata || {};
    const purpose = metadata?.purpose || (orderReference.startsWith('sivan_agr_') ? 'fund_agreement' : 'deposit');
    const userId = metadata?.userId || data?.customer?.customer_code;
    const agreementId = metadata?.agreementId;
    const amountNgn = Number((data?.amount || 0) / 100);

    return {
      provider: this.name,
      verified: isSuccess,
      status: isSuccess ? 'SUCCESS' : (data?.status === 'failed' ? 'FAILED' : 'PENDING'),
      amountNgn,
      orderReference,
      transactionId: data?.id ? String(data.id) : undefined,
      customerEmail: data?.customer?.email,
      paymentMethod: data?.channel,
      purpose,
      userId,
      agreementId,
      raw: json,
    };
  }
}
