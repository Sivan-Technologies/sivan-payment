import { env } from '../../config/env.js';
import { BridgeClient } from '../../providers/bridge/bridge.client.js';
import { idempotencyKey } from '../../shared/id.js';
import { resolveSettlementWalletId } from '../../wallets/user-wallet.service.js';
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

/**
 * Where a virtual account's converted stablecoin is delivered.
 *
 * Per Bridge's documented pattern this must be THAT customer's own wallet:
 *
 *   POST /customers/{id}/virtual_accounts
 *        destination.bridge_wallet_id = that customer's wallet
 *
 * Previously this returned a single pooled Sivan wallet for every user, which
 * made Sivan the custodian of user funds and moved ownership tracking into
 * Sivan's database. Bridge ToS 2.1(m) prohibits holding funds on behalf of
 * users, so settlement is now per customer and Bridge stays the custodian.
 *
 * `userWalletId` is required. There is intentionally no pooled fallback: a
 * misconfiguration must fail loudly rather than silently route a user's money
 * into a shared treasury wallet.
 */
async function destinationPayload(userWalletId: string) {
  const settings = await getVirtualAccountProviderSettings({ includeSecrets: true });

  if (!userWalletId) {
    throw new Error('Virtual account settlement requires the customer\'s own Bridge wallet id.');
  }

  return {
    currency: settings.defaultSettlementAsset,
    payment_rail: settings.defaultSettlementNetwork,
    bridge_wallet_id: userWalletId,
  } as Record<string, string>;
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
    // Runtime Admin Hub provider settings are the production control plane for
    // Bridge virtual account provisioning. The service-level env flag is no
    // longer a hard blocker because ops can enable/disable Bridge VA safely from
    // Virtual Account Settlement controls without a Render redeploy.
    if (!input.providerCustomerId) {
      throw new Error('Bridge virtual account creation requires providerCustomerId from the approved Bridge customer.');
    }

    // Ensure this customer has their own wallet, then settle into it.
    // ensureUserWallet is idempotent, so re-requesting a virtual account does
    // not create a second wallet.
    const userWalletId = await resolveSettlementWalletId(input.userId);

    const raw: any = await this.client.request(`/customers/${input.providerCustomerId}/virtual_accounts`, {
      method: 'POST',
      idempotencyKey: idempotencyKey(`bridge-va-${input.userId}-${input.currency}`),
      body: {
        developer_fee_percent: env.BRIDGE_VIRTUAL_ACCOUNT_DEVELOPER_FEE_PERCENT,
        source: {
          currency: input.currency,
        },
        destination: await destinationPayload(userWalletId),
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
