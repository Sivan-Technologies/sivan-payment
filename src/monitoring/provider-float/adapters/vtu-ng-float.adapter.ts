import type { IProviderFloatAdapter, FloatBalanceResult } from '../float-adapter.interface.js';
import { isPaystackConfigured, paystackBaseUrl, paystackHeaders } from '../../../config/paystackConfig.js';

export class VtuFloatAdapter implements IProviderFloatAdapter {
  readonly providerId = 'vtu_utility';
  readonly providerName = 'VTU Utilities & Bills Pool';
  readonly category = 'utility' as const;
  readonly defaultCurrency = 'NGN' as const;

  isConfigured(): boolean {
    return Boolean(
      process.env.VTU_NG_API_KEY ||
      process.env.VTU_API_KEY ||
      isPaystackConfigured()
    );
  }

  async fetchFloatBalance(): Promise<FloatBalanceResult> {
    const nowIso = new Date().toISOString();

    // 1. If a dedicated VTU.ng or aggregator API key is configured
    const vtuApiKey = process.env.VTU_NG_API_KEY || process.env.VTU_API_KEY;
    if (vtuApiKey) {
      try {
        const vtuBaseUrl = process.env.VTU_NG_BASE_URL || 'https://vtu.ng/wp-json/api/v1';
        const response = await fetch(`${vtuBaseUrl}/balance`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${vtuApiKey}`,
            'x-api-key': vtuApiKey,
          },
        });

        if (response.ok) {
          const json = await response.json() as {
            status?: string;
            balance?: number;
            data?: { balance?: number };
          };
          const bal = Number(json.data?.balance ?? json.balance ?? 0);
          return {
            providerId: this.providerId,
            providerName: this.providerName,
            category: this.category,
            currency: this.defaultCurrency,
            availableBalance: bal,
            lastCheckedAt: nowIso,
            status: 'healthy',
            rawMetadata: json,
          };
        }
      } catch (err) {
        // Fall through to secondary check if aggregator is temporarily down
        console.warn('[vtu-float.adapter] Dedicated VTU check failed, checking fallback:', err);
      }
    }

    // 2. If utility rail operates via Paystack utilities
    if (isPaystackConfigured()) {
      try {
        const url = `${paystackBaseUrl()}/balance`;
        const response = await fetch(url, {
          method: 'GET',
          headers: paystackHeaders(),
        });

        if (response.ok) {
          const json = await response.json() as {
            status: boolean;
            data?: Array<{ currency: string; balance: number }>;
          };
          const ngnEntry = json.data?.find((b) => String(b.currency).toUpperCase() === 'NGN');
          const rawKobo = ngnEntry ? Number(ngnEntry.balance) : 0;
          return {
            providerId: this.providerId,
            providerName: 'Paystack Utilities Rail',
            category: this.category,
            currency: this.defaultCurrency,
            availableBalance: rawKobo / 100,
            lastCheckedAt: nowIso,
            status: 'healthy',
            rawMetadata: { rail: 'paystack_dedicated_subaccount', rawKobo },
          };
        }
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

    return {
      providerId: this.providerId,
      providerName: this.providerName,
      category: this.category,
      currency: this.defaultCurrency,
      availableBalance: 0,
      lastCheckedAt: nowIso,
      status: 'unreachable',
      error: 'No utility billing provider configured',
    };
  }
}
