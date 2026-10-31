import type { IProviderFloatAdapter, AdminFloatSettings } from './float-adapter.interface.js';
import { PaystackFloatAdapter } from './adapters/paystack-float.adapter.js';
import { VtuFloatAdapter } from './adapters/vtu-ng-float.adapter.js';
import { OnChainGasFloatAdapter } from './adapters/onchain-gas-float.adapter.js';
import { OfframpProvisionFloatAdapter } from './adapters/offramp-provision-float.adapter.js';

export class ProviderFloatRegistry {
  private adapters = new Map<string, IProviderFloatAdapter>();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    this.register(new PaystackFloatAdapter());
    this.register(new VtuFloatAdapter());
    this.register(new OnChainGasFloatAdapter());
    this.register(new OfframpProvisionFloatAdapter());
  }

  register(adapter: IProviderFloatAdapter): void {
    this.adapters.set(adapter.providerId, adapter);
  }

  get(providerId: string): IProviderFloatAdapter | undefined {
    return this.adapters.get(providerId);
  }

  getAll(): IProviderFloatAdapter[] {
    return Array.from(this.adapters.values());
  }

  getEnabled(settings?: AdminFloatSettings): IProviderFloatAdapter[] {
    const all = this.getAll();
    if (!settings || !settings.monitors) return all;

    return all.filter((adapter) => {
      const monitor = settings.monitors[adapter.providerId];
      if (monitor !== undefined) {
        return monitor.enabled;
      }
      // If unconfigured in settings, default enabled except for future proprietary pool
      return adapter.providerId !== 'sivan_offramp_pool';
    });
  }
}

export const providerFloatRegistry = new ProviderFloatRegistry();

