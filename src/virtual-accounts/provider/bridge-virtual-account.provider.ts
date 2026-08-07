import { BridgeClient } from '../../providers/bridge/bridge.client.js';
import { idempotencyKey } from '../../shared/id.js';
import { ensureUserWallet } from '../../wallets/user-wallet.service.js';
import { assertVirtualAccountFeeConfigured, getVirtualAccountFeeSelection } from '../../offramp/service/fees.service.js';
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
async function destinationPayload(wallet: { providerWalletId: string; chain: string; provider?: string }) {
  const settings = await getVirtualAccountProviderSettings({ includeSecrets: true });

  if (!wallet?.providerWalletId) {
    throw new Error('Virtual account settlement requires the customer\'s own Bridge wallet id.');
  }

  /**
   * THE WALLET MUST ACTUALLY BE BRIDGE'S.
   *
   * `bridge_wallet_id` is Bridge's own identifier. ensureUserWallet() returns
   * whatever the ACTIVE wallet provider issued, and on this deployment that is
   * Privy - so this field was being sent a Privy wallet id, which Bridge does
   * not recognise. Every provisioning attempt failed at the Bridge API with a
   * generic error, and the platform had zero virtual accounts to show for it.
   *
   * Checked here rather than trusted, because the failure was silent from
   * Sivan's side: the request looked well-formed and the mismatch only existed
   * across a provider boundary. A named refusal tells the operator which
   * control to change (Admin > Wallets > active provider, or issue the user a
   * Bridge wallet) instead of leaving them reading Bridge's error text.
   */
  const issuer = String(wallet.provider ?? '').toLowerCase();
  if (issuer && issuer !== 'bridge') {
    throw new Error(
      `Virtual account settlement requires a BRIDGE wallet, but this user's wallet was issued by ` +
      `"${issuer}". bridge_wallet_id only accepts Bridge's own wallet ids, so Bridge would reject ` +
      `this request. Provision a Bridge wallet for the user before issuing a virtual account.`
    );
  }

  return {
    currency: settings.defaultSettlementAsset,
    // The rail MUST be the chain the destination wallet actually lives on.
    // Taking it from defaultSettlementNetwork instead allowed a mismatch:
    // a Solana wallet told to receive over the "base" rail. Bridge would
    // reject that at best, and misroute funds at worst.
    payment_rail: wallet.chain,
    bridge_wallet_id: wallet.providerWalletId,
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
    const userWallet = await ensureUserWallet(input.userId);

    // Set the fee correctly on the first call. It IS changeable afterwards via
    // PUT /customers/{id}/virtual_accounts/{vaId} (UpdateVirtualAccount accepts
    // developer_fee_percent), but every deposit landing before that update is
    // billed at whatever was set here, and those cannot be reclaimed.
    // Previously it read a hardcoded env default of '0.0', which meant every
    // virtual account was provisioned earning Sivan nothing. It is now an
    // admin-controlled setting alongside the other fees.
    // One resolver decides between developer_fee_percent and fee_config.
    // Bridge rejects both in the same request, and each clears the other on
    // update, so the choice must be made in a single place.
    /**
     * REFUSE TO PROVISION WITHOUT A FEE. Bridge fixes developer_fee_percent at
     * creation and it cannot be reclaimed on deposits already received, so a
     * 0% account earns nothing for its entire life. Throwing is recoverable;
     * a permanently wrong fee is not.
     */
    await assertVirtualAccountFeeConfigured();
    const feeSelection = await getVirtualAccountFeeSelection();

    const raw: any = await this.client.request(`/customers/${input.providerCustomerId}/virtual_accounts`, {
      method: 'POST',
      idempotencyKey: idempotencyKey(`bridge-va-${input.userId}-${input.currency}`),
      body: {
        ...(feeSelection.developerFeePercent
          ? { developer_fee_percent: feeSelection.developerFeePercent }
          : {}),
        ...(feeSelection.feeConfig ? { fee_config: feeSelection.feeConfig } : {}),
        source: {
          currency: input.currency,
        },
        destination: await destinationPayload(userWallet),
      },
    });

    return mapBridgeVirtualAccount(raw, input.currency);
  }

  async getVirtualAccount(providerAccountId: string): Promise<ProviderVirtualAccount> {
    throw new Error(`Bridge virtual account lookup requires customer context for ${providerAccountId}. Use stored raw provider payload or add customer-scoped lookup when needed.`);
  }

  /**
   * Deactivate at Bridge so the account stops accepting deposits.
   *
   *   POST /customers/{customerID}/virtual_accounts/{virtualAccountID}/deactivate
   *
   * Both suspend and close map to the same Bridge call; Bridge has one
   * deactivate, plus a reactivate to undo it. The distinction is Sivan's, not
   * theirs.
   *
   * Until this existed, marking an account "closed" only changed a row in
   * Sivan's database. The account stayed live at Bridge, kept accepting
   * deposits into an address nothing was watching, and kept billing $2/month.
   *
   * customerId is required because every Bridge virtual account endpoint is
   * customer-scoped. It is read from the stored rawProviderPayload by the
   * caller; without it there is no way to address the account and the call
   * must fail loudly rather than silently skip the deactivation.
   */
  private async deactivate(providerAccountId: string, customerId: string, reason: string): Promise<void> {
    if (!customerId) {
      throw new Error(
        `Cannot deactivate Bridge virtual account ${providerAccountId}: the Bridge customer id is ` +
        'unknown. Every Bridge virtual account endpoint is scoped to /customers/{customerID}.'
      );
    }

    await this.client.request(
      `/customers/${customerId}/virtual_accounts/${providerAccountId}/deactivate`,
      {
        method: 'POST',
        // Deterministic so a retry cannot be mistaken for a second action.
        idempotencyKey: `sivan-va-deactivate-${providerAccountId}`,
      }
    );

    void reason;
  }

  async suspendVirtualAccount(providerAccountId: string, reason: string, customerId?: string): Promise<void> {
    await this.deactivate(providerAccountId, customerId ?? '', reason);
  }

  async closeVirtualAccount(providerAccountId: string, reason: string, customerId?: string): Promise<void> {
    await this.deactivate(providerAccountId, customerId ?? '', reason);
  }

  /** Undo a deactivation. Exposed so an accidental close is recoverable. */
  async reactivateVirtualAccount(providerAccountId: string, customerId: string): Promise<void> {
    if (!customerId) {
      throw new Error(`Cannot reactivate Bridge virtual account ${providerAccountId}: customer id is required.`);
    }
    await this.client.request(
      `/customers/${customerId}/virtual_accounts/${providerAccountId}/reactivate`,
      { method: 'POST', idempotencyKey: `sivan-va-reactivate-${providerAccountId}` }
    );
  }
}
