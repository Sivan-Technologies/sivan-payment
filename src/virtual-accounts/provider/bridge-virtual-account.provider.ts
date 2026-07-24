import { env } from '../../config/env.js';
import { BridgeClient } from '../../providers/bridge/bridge.client.js';
import { idempotencyKey } from '../../shared/id.js';
import { getVirtualAccountProviderSettings } from '../service/virtual-account-provider-settings.service.js';
import type { CreateVirtualAccountInput, ProviderVirtualAccount, VirtualAccountCurrency, VirtualAccountStatus } from '../types/virtual-account.types.js';
import type { VirtualAccountProvider } from './virtual-account-provider.js';

function mask(value: unknown) {
  const digits = String(value ?? '').replace(/\s+/g, '');
  if (!digits) return undefined;
  return `••••${digits.slice(-4)}`;
}

function bridgeStatusToInternal(status: unknown): VirtualAccountStatus {
  if (status === 'activated' || status === 'active') return 'active';
  if (status === 'deactivated' || status === 'inactive') return 'closed';
  return 'provisioning';
}

function sourceCurrency(raw: any, fallback: VirtualAccountCurrency): VirtualAccountCurrency {
  const value = String(raw?.source_deposit_instructions?.currency ?? raw?.source?.currency ?? fallback).toLowerCase();
  if (value === 'usd' || value === 'gbp' || value === 'eur' || value === 'ngn') return value;
  return fallback;
}

async function destinationPayload() {
  const settings = await getVirtualAccountProviderSettings({ includeSecrets: true });
  const destination: Record<string, string> = {
    currency: settings.defaultSettlementAsset,
    payment_rail: settings.defaultSettlementNetwork,
  };

  if (settings.bridgeWalletId) {
    destination.bridge_wallet_id = settings.bridgeWalletId;
  } else if (settings.destinationAddress) {
    destination.address = settings.destinationAddress;
  } else {
    throw new Error('Bridge virtual account destination is not configured. Set Bridge wallet ID or destination address in Virtual Account Settlement controls.');
  }

  return destination;
}

export function mapBridgeVirtualAccount(raw: any, fallbackCurrency: VirtualAccountCurrency): ProviderVirtualAccount {
  const instructions = raw?.source_deposit_instructions ?? {};
  const currency = sourceCurrency(raw, fallbackCurrency);
  const accountNumber = instructions.bank_account_number ?? instructions.account_number ?? instructions.clabe ?? instructions.account?.account_number;
  const routingNumber = instructions.bank_routing_number ?? instructions.routing_number ?? instructions.sort_code ?? instructions.bic;
  const iban = instructions.iban ?? instructions.iban_number ?? (currency === 'eur' ? instructions.account_number : undefined);

  return {
    provider: 'bridge',
    providerAccountId: raw.id,
    currency,
    country: currency === 'usd' ? 'US' : currency === 'gbp' ? 'GB' : currency === 'eur' ? 'EU' : undefined,
    bankName: instructions.bank_name,
    accountName: instructions.bank_beneficiary_name ?? instructions.account_name ?? instructions.beneficiary_name,
    accountNumberMasked: mask(accountNumber),
    routingNumberMasked: mask(routingNumber),
    ibanMasked: mask(iban),
    status: bridgeStatusToInternal(raw.status),
    rawProviderPayload: raw,
  };
}

export class BridgeVirtualAccountProvider implements VirtualAccountProvider {
  readonly name = 'bridge' as const;

  constructor(private client = new BridgeClient()) {}

  async createVirtualAccount(input: CreateVirtualAccountInput): Promise<ProviderVirtualAccount> {
    if (!env.BRIDGE_VIRTUAL_ACCOUNTS_ENABLED) {
      throw new Error('Bridge virtual accounts are disabled. Set BRIDGE_VIRTUAL_ACCOUNTS_ENABLED=true only after Bridge/compliance approval.');
    }
    if (!input.providerCustomerId) {
      throw new Error('Bridge virtual account creation requires providerCustomerId from the approved Bridge customer.');
    }

    const raw: any = await this.client.request(`/customers/${input.providerCustomerId}/virtual_accounts`, {
      method: 'POST',
      idempotencyKey: idempotencyKey(`bridge-va-${input.userId}-${input.currency}`),
      body: {
        developer_fee_percent: env.BRIDGE_VIRTUAL_ACCOUNT_DEVELOPER_FEE_PERCENT,
        source: {
          currency: input.currency,
        },
        destination: await destinationPayload(),
      },
    });

    return mapBridgeVirtualAccount(raw, input.currency);
  }

  async getVirtualAccount(providerAccountId: string): Promise<ProviderVirtualAccount> {
    throw new Error(`Bridge virtual account lookup requires customer context for ${providerAccountId}. Use stored raw provider payload or add customer-scoped lookup when needed.`);
  }

  async suspendVirtualAccount(_providerAccountId: string, _reason: string): Promise<void> {
    throw new Error('Bridge virtual account suspend is not enabled. Confirm Bridge-supported lifecycle endpoint before enabling.');
  }

  async closeVirtualAccount(_providerAccountId: string, _reason: string): Promise<void> {
    throw new Error('Bridge virtual account close is not enabled. Confirm Bridge-supported lifecycle endpoint before enabling.');
  }
}
