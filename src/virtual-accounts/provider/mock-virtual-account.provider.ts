import crypto from 'node:crypto';
import type { CreateVirtualAccountInput, ProviderVirtualAccount } from '../types/virtual-account.types.js';
import type { VirtualAccountProvider } from './virtual-account-provider.js';

function mask(value: string) {
  return `••••${value.slice(-4)}`;
}

export class MockVirtualAccountProvider implements VirtualAccountProvider {
  readonly name = 'mock' as const;

  async createVirtualAccount(input: CreateVirtualAccountInput): Promise<ProviderVirtualAccount> {
    const suffix = String(crypto.randomInt(1000000000, 9999999999));
    return {
      provider: this.name,
      providerAccountId: `mock_va_${crypto.randomUUID()}`,
      currency: input.currency,
      country: input.country,
      bankName: 'Sivan Mock Bank',
      accountName: input.fullName || 'Sivan User',
      accountNumberMasked: mask(suffix),
      routingNumberMasked: input.currency === 'usd' ? mask('021000021') : undefined,
      ibanMasked: input.currency === 'eur' ? mask('DE89370400440532013000') : undefined,
      status: 'active',
      rawProviderPayload: { mode: 'mock', generatedAt: new Date().toISOString() },
    };
  }

  async getVirtualAccount(providerAccountId: string): Promise<ProviderVirtualAccount> {
    return {
      provider: this.name,
      providerAccountId,
      currency: 'usd',
      bankName: 'Sivan Mock Bank',
      accountNumberMasked: '••••0000',
      status: 'active',
      rawProviderPayload: { mode: 'mock_lookup' },
    };
  }

  async suspendVirtualAccount(): Promise<void> {
    return;
  }

  async closeVirtualAccount(): Promise<void> {
    return;
  }
}
