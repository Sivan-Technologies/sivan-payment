import { BridgeClient } from '../../providers/bridge/bridge.client.js';
import type { WalletProvider } from './wallet-provider.js';
import type {
  CreateWalletInput,
  ProviderWallet,
  WalletAsset,
  WalletBalance,
  WalletChain,
  WalletTransfer,
  WalletTransferInput,
} from '../types/wallet.types.js';

/**
 * Bridge Custodial Wallets adapter.
 *
 * Verified against the Bridge OpenAPI spec (api.bridge.xyz/v0), not inferred:
 *
 *   POST /customers/{customerID}/wallets              -> CreateBridgeWalletResponse
 *   GET  /customers/{customerID}/wallets              -> BridgeWalletsList (NO balances)
 *   GET  /customers/{customerID}/wallets/{walletID}   -> BridgeWalletWithBalances
 *
 * Three details from the spec that drive this implementation:
 *
 * 1. The create/list responses carry NO balances. Only the single-wallet GET
 *    returns them. getBalances() therefore hits the single-wallet endpoint,
 *    and listWallets() honestly reports balances as undefined rather than
 *    implying an empty (zero) wallet.
 *
 * 2. Every endpoint is customer-scoped. There is no global
 *    /wallets/{id} lookup, so providerCustomerId is required, not optional.
 *    Calls that lack it fail loudly instead of guessing.
 *
 * 3. Amounts are strings in whole US cents (2dp). They are passed through as
 *    strings and never parsed to a float.
 *
 * Bridge is custodial: Bridge holds the keys and the funds. That is what keeps
 * Sivan clear of ToS 2.1(m), which forbids the developer holding crypto-assets
 * or funds on behalf of users. Balances are read through to Bridge on every
 * call rather than mirrored in a Sivan ledger, so our books can never disagree
 * with the custodian's.
 */

/** BridgeWalletChain enum from the spec. Tempo and Tron exist but Sivan does not enable them. */
const BRIDGE_CHAINS = ['base', 'ethereum', 'solana', 'tempo', 'tron'] as const;

/** Chains Sivan issues wallets on, intersected with what Bridge supports. */
const SUPPORTED_CHAINS: readonly WalletChain[] = ['solana', 'base', 'ethereum'];

/**
 * Currency enum from the spec: usdb, usdc, usdt, usd, pyusd. Sivan only
 * surfaces usdc and usdt; anything else Bridge reports is passed over rather
 * than mislabelled as one of ours.
 */
const SIVAN_ASSETS: readonly string[] = ['usdc', 'usdt'];

interface BridgeWalletResponse {
  id: string;
  chain: string;
  address: string;
  initiation_required?: boolean;
  created_at?: string;
  updated_at?: string;
  balances?: Array<{
    balance: string;
    currency: string;
    chain: string;
    contract_address?: string;
  }>;
}

interface BridgeWalletsListResponse {
  count: number;
  data: BridgeWalletResponse[];
}

function assertCustomerId(providerCustomerId: string | undefined, action: string): string {
  if (!providerCustomerId) {
    throw new Error(
      `Bridge wallet ${action} requires the customer id: every Bridge wallet endpoint is ` +
      'scoped to /customers/{customerID}/wallets.'
    );
  }
  return providerCustomerId;
}

/**
 * Bridge may add chains we do not model. Rejecting an unknown chain is safer
 * than coercing it, because the chain decides which address a user is shown.
 */
function toWalletChain(chain: string, context: string): WalletChain {
  const normalized = String(chain || '').toLowerCase();
  if (!SUPPORTED_CHAINS.includes(normalized as WalletChain)) {
    throw new Error(
      `Bridge returned chain "${chain}" for ${context}, which Sivan does not support. ` +
      `Supported: ${SUPPORTED_CHAINS.join(', ')}.`
    );
  }
  return normalized as WalletChain;
}

function mapBalances(raw: BridgeWalletResponse['balances']): WalletBalance[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => SIVAN_ASSETS.includes(String(entry.currency || '').toLowerCase()))
    .filter((entry) => SUPPORTED_CHAINS.includes(String(entry.chain || '').toLowerCase() as WalletChain))
    .map((entry) => ({
      asset: String(entry.currency).toLowerCase() as WalletAsset,
      chain: String(entry.chain).toLowerCase() as WalletChain,
      // Kept as the string Bridge sent. Parsing to a number would introduce
      // float drift into a money value for no benefit.
      amount: entry.balance,
      contractAddress: entry.contract_address,
    }));
}

export function mapBridgeWallet(raw: BridgeWalletResponse, context = 'wallet'): ProviderWallet {
  if (!raw?.id) throw new Error(`Bridge ${context} response is missing an id`);
  if (!raw?.address) throw new Error(`Bridge ${context} response is missing an address`);

  return {
    provider: 'bridge',
    providerWalletId: raw.id,
    chain: toWalletChain(raw.chain, context),
    address: raw.address,
    custodyModel: 'custodial',
    // Bridge wallets are usable the moment they are returned; there is no
    // provisioning state in the spec.
    status: 'active',
    // Bridge signs server-side. The user is never prompted, which is the
    // whole point of a custodial wallet.
    requiresUserSignature: false,
    // Deliberately undefined, not [], when Bridge did not send balances. An
    // empty array would render as a confirmed zero balance in the UI, which
    // is a different claim from "not loaded".
    balances: raw.balances ? mapBalances(raw.balances) : undefined,
    rawProviderPayload: raw,
    createdAt: raw.created_at,
  };
}


/**
 * Bridge transfer state -> Sivan's four-value status.
 *
 * Anything unrecognised maps to 'submitted', not 'failed': an unknown state is
 * a state we have not learned about yet, and calling it a failure would tell a
 * user their money did not move when it may well have.
 */
function mapBridgeTransferStatus(state?: string): WalletTransfer['status'] {
  const value = String(state ?? '').toLowerCase();
  if (['payment_processed', 'completed', 'confirmed'].includes(value)) return 'confirmed';
  if (['failed', 'canceled', 'cancelled', 'returned', 'error'].includes(value)) return 'failed';
  return 'submitted';
}

export class BridgeWalletProvider implements WalletProvider {
  readonly name = 'bridge' as const;

  /** Bridge holds keys and funds. Stated explicitly: it is a compliance fact, not a detail. */
  readonly custodyModel = 'custodial' as const;

  readonly supportedChains = SUPPORTED_CHAINS;

  constructor(private client = new BridgeClient()) {}

  async createWallet(input: CreateWalletInput): Promise<ProviderWallet> {
    const customerId = assertCustomerId(input.providerCustomerId, 'creation');

    if (!SUPPORTED_CHAINS.includes(input.chain)) {
      throw new Error(
        `Sivan does not issue wallets on "${input.chain}". Supported: ${SUPPORTED_CHAINS.join(', ')}.`
      );
    }
    if (!BRIDGE_CHAINS.includes(input.chain as (typeof BRIDGE_CHAINS)[number])) {
      throw new Error(`Bridge does not support chain "${input.chain}".`);
    }

    const raw = await this.client.request<BridgeWalletResponse>(
      `/customers/${customerId}/wallets`,
      {
        method: 'POST',
        // Bridge bills per created wallet, so a retry must never provision a
        // second one. The caller supplies a deterministic key for this reason.
        idempotencyKey: input.idempotencyKey,
        body: { chain: input.chain },
      }
    );

    return mapBridgeWallet(raw, 'wallet creation');
  }

  async getWallet(providerWalletId: string, providerCustomerId?: string): Promise<ProviderWallet> {
    const customerId = assertCustomerId(providerCustomerId, 'lookup');
    const raw = await this.client.request<BridgeWalletResponse>(
      `/customers/${customerId}/wallets/${providerWalletId}`
    );
    return mapBridgeWallet(raw, 'wallet lookup');
  }

  async listWallets(providerCustomerId: string): Promise<ProviderWallet[]> {
    const customerId = assertCustomerId(providerCustomerId, 'list');
    const raw = await this.client.request<BridgeWalletsListResponse>(
      `/customers/${customerId}/wallets`
    );
    const wallets = Array.isArray(raw?.data) ? raw.data : [];
    // Note: this endpoint does not return balances. Each mapped wallet will
    // have balances === undefined, which is accurate.
    return wallets.map((wallet) => mapBridgeWallet(wallet, 'wallet list'));
  }

  async getBalances(providerWalletId: string, providerCustomerId?: string): Promise<WalletBalance[]> {
    const customerId = assertCustomerId(providerCustomerId, 'balance lookup');
    const raw = await this.client.request<BridgeWalletResponse>(
      `/customers/${customerId}/wallets/${providerWalletId}`
    );
    return mapBalances(raw?.balances);
  }

  /**
   * Outbound transfers, via Bridge's Orchestration API.
   *
   * PREVIOUSLY THIS THREW, AND THE REASON GIVEN WAS WRONG.
   *
   * The old message said fund movement was blocked pending "Bridge Legal &
   * Compliance approval". That was never a Bridge restriction - Bridge
   * documents wallet-to-address sends explicitly, and Sivan ALREADY does
   * exactly this in createSupplierPayout():
   *
   *     POST /v0/transfers
   *     source: { payment_rail: 'bridge_wallet', bridge_wallet_id }
   *
   * It was an internal decision not to open a second exit path before one was
   * reviewed. That review has happened, so the capability is wired to the same
   * endpoint the supplier payout has used in production all along.
   *
   * WHAT BRIDGE REQUIRES, AND WHY THE ADDRESS IS NOT SIGNED FOR HERE.
   *
   * "You must use Bridge's orchestration APIs to move funds. Do not attempt to
   * send directly from the wallet address." Bridge holds the keys - there is
   * no local signing step, which is why this returns 'submitted' rather than a
   * transaction hash. The hash arrives later by webhook, exactly as the
   * supplier payout path already handles.
   */
  async createTransfer(input: WalletTransferInput): Promise<WalletTransfer> {
    const customerId = assertCustomerId(input.providerCustomerId, 'transfer');

    if (!input.providerWalletId) {
      throw new Error('Bridge transfers require the source bridge_wallet_id.');
    }

    /**
     * `on_behalf_of` is the CUSTOMER, not the wallet. Bridge attributes the
     * movement to a KYC-approved customer, and omitting it is how a transfer
     * ends up unattributable in their compliance reporting.
     */
    const raw: any = await this.client.request('/transfers', {
      method: 'POST',
      idempotencyKey: input.idempotencyKey,
      body: {
        amount: input.amount,
        on_behalf_of: customerId,
        /**
         * Zero, deliberately. Sivan's fee is already applied upstream in
         * balance.service.ts, which sends the NET amount - charging a Bridge
         * developer_fee here as well would take it twice from the same
         * transfer.
         */
        developer_fee: '0.0',
        ...(input.reference ? { client_reference_id: input.reference } : {}),
        source: {
          payment_rail: 'bridge_wallet',
          currency: String(input.asset).toLowerCase(),
          bridge_wallet_id: input.providerWalletId,
        },
        destination: {
          // The chain the funds are going TO, which for a same-chain send is
          // the chain the wallet lives on.
          payment_rail: String(input.chain).toLowerCase(),
          currency: String(input.asset).toLowerCase(),
          to_address: input.toAddress,
        },
      },
    });

    return {
      provider: this.name,
      providerTransferId: String(raw?.id ?? ''),
      /**
       * 'submitted', never 'confirmed'. Bridge accepting the instruction is
       * not the chain including it, and reporting confirmation we have not
       * observed is how a user is told their money arrived before it did.
       */
      status: 'submitted',
      txHash: raw?.destination_tx_hash || undefined,
      rawProviderPayload: raw,
    };
  }

  async getTransfer(providerTransferId: string): Promise<WalletTransfer> {
    const raw: any = await this.client.request(`/transfers/${providerTransferId}`);
    return {
      provider: this.name,
      providerTransferId: String(raw?.id ?? providerTransferId),
      status: mapBridgeTransferStatus(raw?.state ?? raw?.status),
      txHash: raw?.destination_tx_hash || undefined,
      rawProviderPayload: raw,
    };
  }
}
