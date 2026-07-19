import type { CreateVirtualAccountInput, ProviderVirtualAccount } from '../types/virtual-account.types.js';
import { getVirtualAccountProvider } from '../provider/provider-registry.js';

export function virtualAccountsEnabled() {
  return process.env.VIRTUAL_ACCOUNTS_ENABLED === 'true';
}

export function virtualAccountRequestsEnabled() {
  return process.env.VIRTUAL_ACCOUNT_REQUESTS_ENABLED === 'true';
}

export async function provisionVirtualAccount(input: CreateVirtualAccountInput): Promise<ProviderVirtualAccount> {
  if (!virtualAccountsEnabled()) {
    throw new Error('Virtual accounts are disabled. Enable VIRTUAL_ACCOUNTS_ENABLED only after provider/compliance approval.');
  }

  const provider = getVirtualAccountProvider();
  return provider.createVirtualAccount(input);
}
