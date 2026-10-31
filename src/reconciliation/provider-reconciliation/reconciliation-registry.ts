import type { IProviderReconciliationAdapter } from './reconciliation-adapter.interface.js';
import { PaystackReconciliationAdapter } from './adapters/paystack-reconciliation.adapter.js';
import { NombaReconciliationAdapter } from './adapters/nomba-reconciliation.adapter.js';
import { FlutterwaveReconciliationAdapter } from './adapters/flutterwave-reconciliation.adapter.js';
import { BreetReconciliationAdapter } from './adapters/breet-reconciliation.adapter.js';

export class ProviderReconciliationRegistry {
  private adapters = new Map<string, IProviderReconciliationAdapter>();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    this.register(new PaystackReconciliationAdapter());
    this.register(new NombaReconciliationAdapter());
    this.register(new FlutterwaveReconciliationAdapter());
    this.register(new BreetReconciliationAdapter());
  }

  register(adapter: IProviderReconciliationAdapter): void {
    this.adapters.set(adapter.providerId.toLowerCase(), adapter);
  }

  get(providerId: string): IProviderReconciliationAdapter | undefined {
    return this.adapters.get(providerId.toLowerCase());
  }

  getAll(): IProviderReconciliationAdapter[] {
    return Array.from(this.adapters.values());
  }
}

export const providerReconciliationRegistry = new ProviderReconciliationRegistry();
