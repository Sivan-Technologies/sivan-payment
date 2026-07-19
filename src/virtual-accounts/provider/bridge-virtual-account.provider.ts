import type { CreateVirtualAccountInput, ProviderVirtualAccount } from '../types/virtual-account.types.js';
import type { VirtualAccountProvider } from './virtual-account-provider.js';

export class BridgeVirtualAccountProvider implements VirtualAccountProvider {
  readonly name = 'bridge' as const;

  async createVirtualAccount(_input: CreateVirtualAccountInput): Promise<ProviderVirtualAccount> {
    // Bridge virtual account provisioning is intentionally not wired yet.
    // Keep this adapter shell so the business layer does not depend on Bridge directly.
    throw new Error('Bridge virtual account adapter is not enabled. Confirm Bridge endpoint, compliance scope, and env before provisioning.');
  }

  async getVirtualAccount(_providerAccountId: string): Promise<ProviderVirtualAccount> {
    throw new Error('Bridge virtual account lookup is not enabled.');
  }

  async suspendVirtualAccount(_providerAccountId: string, _reason: string): Promise<void> {
    throw new Error('Bridge virtual account suspend is not enabled.');
  }

  async closeVirtualAccount(_providerAccountId: string, _reason: string): Promise<void> {
    throw new Error('Bridge virtual account close is not enabled.');
  }
}
