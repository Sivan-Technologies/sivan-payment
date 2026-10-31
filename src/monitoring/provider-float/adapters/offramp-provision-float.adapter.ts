import type { IProviderFloatAdapter, FloatBalanceResult } from '../float-adapter.interface.js';

/**
 * Off-Ramp Proprietary Liquidity Provision Adapter.
 *
 * NOTE: Breet off-ramp liquidity is backed in real time by customer crypto deposits (USDT/USDC).
 * This adapter is reserved for future proprietary Sivan direct settlement pools or pre-funded
 * banking corridors.
 */
export class OfframpProvisionFloatAdapter implements IProviderFloatAdapter {
  readonly providerId = 'sivan_offramp_pool';
  readonly providerName = 'Sivan Proprietary Settlement Reserve';
  readonly category = 'offramp' as const;
  readonly defaultCurrency = 'NGN' as const;

  isConfigured(): boolean {
    return Boolean(process.env.OFFRAMP_PROPRIETARY_POOL_CONFIGURED);
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
        status: 'healthy', // Default healthy inactive state
        rawMetadata: { notice: 'Breet is active; proprietary float disabled' },
      };
    }

    return {
      providerId: this.providerId,
      providerName: this.providerName,
      category: this.category,
      currency: this.defaultCurrency,
      availableBalance: 500000,
      lastCheckedAt: nowIso,
      status: 'healthy',
    };
  }
}

