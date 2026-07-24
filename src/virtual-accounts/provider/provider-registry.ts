import { env } from '../../config/env.js';
import { BridgeVirtualAccountProvider } from './bridge-virtual-account.provider.js';
import { MockVirtualAccountProvider } from './mock-virtual-account.provider.js';
import type { VirtualAccountProvider } from './virtual-account-provider.js';
import type { VirtualAccountProviderName } from '../types/virtual-account.types.js';

export function getVirtualAccountProvider(providerName = process.env.VIRTUAL_ACCOUNT_PROVIDER || 'mock'): VirtualAccountProvider {
  const normalized = providerName.trim().toLowerCase() as VirtualAccountProviderName;

  if (normalized === 'bridge') return new BridgeVirtualAccountProvider();

  if (normalized === 'mock') {
    if (env.APP_ENV === 'production') {
      throw new Error('Mock virtual account provisioning is disabled in production. Use Bridge provider settings only.');
    }
    return new MockVirtualAccountProvider();
  }

  // Future adapters should be added here without changing service/UI code.
  // if (normalized === 'nomba') return new NombaVirtualAccountProvider();
  // if (normalized === 'monnify') return new MonnifyVirtualAccountProvider();

  throw new Error(`Unsupported virtual account provider: ${providerName}`);
}
