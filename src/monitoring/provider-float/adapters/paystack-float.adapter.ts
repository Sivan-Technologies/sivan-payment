import { isPaystackConfigured, paystackBaseUrl, paystackHeaders } from '../../../config/paystackConfig.js';
import type { IProviderFloatAdapter, FloatBalanceResult } from '../float-adapter.interface.js';

export class PaystackFloatAdapter implements IProviderFloatAdapter {
  readonly providerId = 'paystack_payout';
  readonly providerName = 'Paystack NGN Payout Pool';
  readonly category = 'payout' as const;
  readonly defaultCurrency = 'NGN' as const;

  isConfigured(): boolean {
    return isPaystackConfigured();
  }

  async fetchFloatBalance(): Promise<FloatBalanceResult> {
    const nowIso = new Date().toISOString();

    if (!this.isConfigured()) {
      return {
        providerId: this.providerId,
        providerName: this.providerName,
        category: this.category,
        currency: this.defaultCurrency,
        availableBalance: 0,
        lastCheckedAt: nowIso,
        status: 'unreachable',
        error: 'Paystack is not configured in environment',
      };
    }

    try {
      const url = `${paystackBaseUrl()}/balance`;
      const response = await fetch(url, {
        method: 'GET',
        headers: paystackHeaders(),
      });

      if (!response.ok) {
        const text = await response.text();
        return {
          providerId: this.providerId,
          providerName: this.providerName,
          category: this.category,
          currency: this.defaultCurrency,
          availableBalance: 0,
          lastCheckedAt: nowIso,
          status: 'unreachable',
          error: `Paystack API returned status ${response.status}: ${text.slice(0, 200)}`,
        };
      }

      const json = await response.json() as {
        status: boolean;
        message?: string;
        data?: Array<{ currency: string; balance: number }>;
      };

      if (!json.status || !Array.isArray(json.data)) {
        return {
          providerId: this.providerId,
          providerName: this.providerName,
          category: this.category,
          currency: this.defaultCurrency,
          availableBalance: 0,
          lastCheckedAt: nowIso,
          status: 'unreachable',
          error: json.message || 'Malformed response from Paystack balance API',
        };
      }

      // Find NGN balance (in kobo: 1 NGN = 100 kobo)
      const ngnEntry = json.data.find(
        (b) => String(b.currency).toUpperCase() === 'NGN'
      );
      const rawKobo = ngnEntry ? Number(ngnEntry.balance) : 0;
      const availableNgn = rawKobo / 100;

      return {
        providerId: this.providerId,
        providerName: this.providerName,
        category: this.category,
        currency: this.defaultCurrency,
        availableBalance: availableNgn,
        lastCheckedAt: nowIso,
        status: 'healthy',
        rawMetadata: json.data,
      };
    } catch (err) {
      return {
        providerId: this.providerId,
        providerName: this.providerName,
        category: this.category,
        currency: this.defaultCurrency,
        availableBalance: 0,
        lastCheckedAt: nowIso,
        status: 'unreachable',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
