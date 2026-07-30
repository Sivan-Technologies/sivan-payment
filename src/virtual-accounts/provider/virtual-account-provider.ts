import type { CreateVirtualAccountInput, ProviderVirtualAccount, VirtualAccountProviderName } from '../types/virtual-account.types.js';

export interface VirtualAccountProvider {
  readonly name: VirtualAccountProviderName;

  createVirtualAccount(input: CreateVirtualAccountInput): Promise<ProviderVirtualAccount>;

  getVirtualAccount(providerAccountId: string): Promise<ProviderVirtualAccount>;

  /**
   * `customerId` is the PROVIDER's customer id. Bridge scopes every virtual
   * account endpoint to /customers/{customerID}, so without it the account
   * cannot be addressed at all.
   */
  suspendVirtualAccount(providerAccountId: string, reason: string, customerId?: string): Promise<void>;

  closeVirtualAccount(providerAccountId: string, reason: string, customerId?: string): Promise<void>;
}
