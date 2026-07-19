import type { CreateVirtualAccountInput, ProviderVirtualAccount, VirtualAccountProviderName } from '../types/virtual-account.types.js';

export interface VirtualAccountProvider {
  readonly name: VirtualAccountProviderName;

  createVirtualAccount(input: CreateVirtualAccountInput): Promise<ProviderVirtualAccount>;

  getVirtualAccount(providerAccountId: string): Promise<ProviderVirtualAccount>;

  suspendVirtualAccount(providerAccountId: string, reason: string): Promise<void>;

  closeVirtualAccount(providerAccountId: string, reason: string): Promise<void>;
}
