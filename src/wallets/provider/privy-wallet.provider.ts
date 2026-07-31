import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { forbidden } from '../../shared/errors.js';
import type { WalletProvider } from './wallet-provider.js';
import type {
  CreateWalletInput,
  ProviderWallet,
  WalletBalance,
  WalletChain,
  WalletCustodyModel,
  WalletProviderName,
  WalletTransfer,
  WalletTransferInput,
} from '../types/wallet.types.js';

/**
 * Privy embedded wallets.
 *
 * Verified against docs.privy.io and api.privy.io/v1/openapi.json:
 *
 *   base   https://api.privy.io/v1
 *   auth   Authorization: Basic base64(appId:appSecret)  +  privy-app-id header
 *   create POST /v1/wallets            { chain_type }
 *          POST /v1/users              { linked_accounts, wallets: [...] }
 *   sign   POST /v1/wallets/{id}/rpc   { method, caip2, params }
 *
 * CUSTODY IS DECIDED BY `owner`, AND IT IS THE WHOLE ARCHITECTURE
 *
 * Privy's docs are explicit: a wallet's owner is either a USER ID, in which
 * case only the authenticated user can sign, or an AUTHORIZATION KEY, in which
 * case whoever holds that key - Sivan's backend - controls the wallet.
 *
 * Those are not two configurations of the same thing. They are custodial and
 * non-custodial, and the choice determines Sivan's regulatory posture, what the
 * UI may truthfully claim, and whether "Withdraw to NGN" can work with one tap.
 *
 * Sivan issues USER-OWNED wallets. Reasons, in order:
 *
 *   1. Sivan then holds neither funds nor keys, which is the cleaner reading of
 *      Bridge ToS 2.1(m) - the clause that has already caused trouble here.
 *   2. Privy's own model splits the key across a device share, a Privy TEE
 *      share and a user recovery share; Privy alone cannot move funds. Handing
 *      Sivan an owner key throws that property away.
 *   3. A custodial posture in Nigeria invites licensing questions Sivan has not
 *      answered.
 *
 * The cost is real and is not hidden: the backend CANNOT sign an off-ramp on
 * the user's behalf. createTransfer therefore returns `pending_user_signature`
 * rather than pretending to submit. The interface already models this, and the
 * UI must prompt.
 *
 * When one-tap off-ramp is wanted, the answer is a scoped DELEGATED SIGNER
 * (Privy "signers"), not switching the owner to Sivan: the user still owns the
 * wallet, and Sivan gets permission narrowed by policy to a specific
 * destination and cap. That is a deliberate later step, not a default.
 */

const PRIVY_BASE = 'https://api.privy.io/v1';

/** Privy's chain vocabulary, keyed by Sivan's. */
const CHAIN_TYPE: Record<WalletChain, 'ethereum' | 'solana'> = {
  // Base is an EVM chain, so the SAME secp256k1 key and the SAME 0x address
  // serve Ethereum and Base. Privy issues one `ethereum` wallet for both.
  ethereum: 'ethereum',
  base: 'ethereum',
  solana: 'solana',
};

/**
 * CAIP-2 identifiers, needed when sending a transaction.
 *
 * Mainnet and testnet differ, and sending on the wrong one silently succeeds on
 * a chain nobody is watching.
 */
const CAIP2: Record<WalletChain, { mainnet: string; testnet: string }> = {
  ethereum: { mainnet: 'eip155:1', testnet: 'eip155:11155111' },
  base: { mainnet: 'eip155:8453', testnet: 'eip155:84532' },
  solana: {
    mainnet: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    testnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  },
};

function credentials() {
  const appId = process.env.PRIVY_APP_ID || env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET || env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) throw forbidden('Privy credentials are not configured.');
  return { appId, appSecret };
}

function headers(idempotencyKey?: string) {
  const { appId, appSecret } = credentials();
  return {
    'Content-Type': 'application/json',
    Authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
    'privy-app-id': appId,
    // Privy documents idempotency keys explicitly to prevent duplicate
    // operations on retry. A duplicate wallet is a second address the user
    // may deposit to and that nothing reconciles against.
    ...(idempotencyKey ? { 'privy-idempotency-key': idempotencyKey } : {}),
  };
}

async function privyRequest<T>(path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<T> {
  const { idempotencyKey, ...rest } = init;
  const response = await fetch(`${PRIVY_BASE}${path}`, {
    ...rest,
    headers: { ...headers(idempotencyKey), ...(rest.headers ?? {}) },
  });

  const body: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Privy: ${body?.error ?? body?.message ?? `HTTP ${response.status}`}`);
  }
  return body as T;
}

function isProduction(): boolean {
  return (process.env.APP_ENV || env.APP_ENV) === 'production';
}

export class PrivyWalletProvider implements WalletProvider {
  readonly name: WalletProviderName = 'privy';

  /**
   * Stated on the interface rather than buried, because it changes what the
   * product may claim and how Sivan is regulated.
   */
  readonly custodyModel: WalletCustodyModel = 'non_custodial';

  /**
   * Base is served by the Ethereum wallet - same key, same address - so all
   * three are supported with only TWO keys per user.
   */
  readonly supportedChains: readonly string[] = ['solana', 'ethereum', 'base'];

  /**
   * Create (or return) the user's wallet for a chain.
   *
   * One Privy USER per Sivan user, carrying their Sivan user id as a
   * linked custom account so the two systems can always be reconciled without
   * a lookup table that can drift.
   *
   * Note what this means for addresses: asking for `base` and `ethereum`
   * returns THE SAME wallet and the same 0x address. That is correct - they are
   * one key - and the caller must not treat them as distinct deposits.
   */
  async createWallet(input: CreateWalletInput): Promise<ProviderWallet> {
    const chainType = CHAIN_TYPE[input.chain];
    if (!chainType) throw forbidden(`Privy does not issue wallets on ${input.chain}.`);

    // Reuse an existing wallet of this chain type before creating another.
    // Privy will happily create a second wallet, and a user with two Solana
    // addresses has one nobody is watching for deposits.
    const existing = await this.findWallet(input.userId, chainType);
    if (existing) return existing;

    const created = await privyRequest<any>('/wallets', {
      method: 'POST',
      idempotencyKey: input.idempotencyKey,
      body: JSON.stringify({
        chain_type: chainType,
        // Ties the Privy wallet back to the Sivan user. Without this the only
        // link is a row in Sivan's database, and a lost row means an orphaned
        // wallet with funds in it.
        owner: { user_id: await this.ensurePrivyUser(input.userId, input.metadata) },
      }),
    });

    return this.toProviderWallet(created, input.chain);
  }

  /**
   * One Privy user per Sivan user, found by the Sivan id.
   *
   * Uses a custom_auth linked account rather than email: a user may change
   * their email, and the mapping must not break when they do.
   */
  private async ensurePrivyUser(userId: string, metadata?: Record<string, unknown>): Promise<string> {
    const search = await privyRequest<any>(
      `/users/search?custom_user_id=${encodeURIComponent(userId)}`
    ).catch(() => undefined);

    const found = search?.data?.[0]?.id ?? search?.[0]?.id;
    if (found) return found;

    const created = await privyRequest<any>('/users', {
      method: 'POST',
      // Same Sivan user must never produce two Privy users, even under retry.
      idempotencyKey: `privy_user_${userId}`,
      body: JSON.stringify({
        linked_accounts: [
          { type: 'custom_auth', custom_user_id: userId },
          ...(metadata?.email ? [{ type: 'email', address: String(metadata.email) }] : []),
        ],
      }),
    });

    const id = created?.id;
    if (!id) throw new Error('Privy: user creation returned no id.');
    return id;
  }

  private async findWallet(userId: string, chainType: string): Promise<ProviderWallet | undefined> {
    const search = await privyRequest<any>(
      `/users/search?custom_user_id=${encodeURIComponent(userId)}`
    ).catch(() => undefined);

    const user = search?.data?.[0] ?? search?.[0];
    const wallet = (user?.linked_accounts ?? []).find(
      (account: any) => account?.type === 'wallet' && account?.chain_type === chainType
    );
    if (!wallet) return undefined;

    return this.toProviderWallet(wallet, chainType === 'solana' ? 'solana' : 'ethereum');
  }

  private toProviderWallet(raw: any, chain: WalletChain): ProviderWallet {
    const address = raw?.address;
    if (!address) throw new Error('Privy: wallet response contained no address.');

    return {
      provider: this.name,
      providerWalletId: raw?.id ?? raw?.wallet_id ?? address,
      chain,
      address,
      custodyModel: this.custodyModel,
      status: 'active',
      // The defining property of this provider. Sivan cannot move these funds
      // without the user, and the UI must not imply otherwise.
      requiresUserSignature: true,
      rawProviderPayload: raw,
      createdAt: raw?.created_at ? new Date(Number(raw.created_at)).toISOString() : undefined,
    };
  }

  async getWallet(providerWalletId: string): Promise<ProviderWallet> {
    const raw = await privyRequest<any>(`/wallets/${encodeURIComponent(providerWalletId)}`);
    return this.toProviderWallet(raw, raw?.chain_type === 'solana' ? 'solana' : 'ethereum');
  }

  async listWallets(providerCustomerId: string): Promise<ProviderWallet[]> {
    const search = await privyRequest<any>(
      `/users/search?custom_user_id=${encodeURIComponent(providerCustomerId)}`
    ).catch(() => undefined);

    const user = search?.data?.[0] ?? search?.[0];
    return (user?.linked_accounts ?? [])
      .filter((account: any) => account?.type === 'wallet')
      .map((account: any) =>
        this.toProviderWallet(account, account?.chain_type === 'solana' ? 'solana' : 'ethereum')
      );
  }

  /**
   * Balances are NOT read from Privy.
   *
   * Privy is a key manager, not an indexer - it signs, it does not track token
   * balances. More importantly, a chain balance is the wrong number anyway:
   * tokens can arrive that were never a Sivan deposit, and escrow holds funds
   * that exist on-chain but are not spendable. The LEDGER is the source of
   * truth, and chain state is used only to reconcile.
   *
   * Returning an empty array rather than throwing, so a caller asking for a
   * display balance degrades to "unknown" instead of erroring.
   */
  async getBalances(): Promise<WalletBalance[]> {
    return [];
  }

  /**
   * Move funds out.
   *
   * Returns `pending_user_signature`, ALWAYS, and does not pretend otherwise.
   *
   * A user-owned Privy wallet can only be signed by the authenticated user.
   * Sivan's backend holds no owner key, by design. Building the transaction
   * server-side and returning it for the client to sign is the honest shape;
   * quietly failing at submit time would be worse.
   *
   * If one-tap off-ramp becomes a requirement, the fix is a scoped delegated
   * signer restricted by policy to a specific destination and cap - not making
   * Sivan the owner.
   */
  async createTransfer(input: WalletTransferInput): Promise<WalletTransfer> {
    const caip = CAIP2[input.chain];
    if (!caip) throw forbidden(`No CAIP-2 chain id for ${input.chain}.`);

    return {
      provider: this.name,
      providerTransferId: `privy_pending_${input.idempotencyKey || crypto.randomUUID()}`,
      status: 'pending_user_signature',
      userSignaturePayload: {
        walletId: input.providerWalletId,
        chain: input.chain,
        caip2: isProduction() ? caip.mainnet : caip.testnet,
        asset: input.asset,
        amount: input.amount,
        toAddress: input.toAddress,
        reference: input.reference,
        // The client passes this straight to Privy, which is what makes the
        // signature the user's rather than Sivan's.
        rpcMethod: input.chain === 'solana' ? 'signAndSendTransaction' : 'eth_sendTransaction',
      },
    };
  }

  async getTransfer(providerTransferId: string): Promise<WalletTransfer> {
    // Nothing was submitted server-side, so there is nothing to poll. Saying so
    // beats inventing a status the caller might act on.
    if (providerTransferId.startsWith('privy_pending_')) {
      return {
        provider: this.name,
        providerTransferId,
        status: 'pending_user_signature',
      };
    }

    const raw = await privyRequest<any>(`/transactions/${encodeURIComponent(providerTransferId)}`)
      .catch(() => undefined);

    return {
      provider: this.name,
      providerTransferId,
      status: raw?.status === 'confirmed' ? 'confirmed' : raw?.status === 'failed' ? 'failed' : 'submitted',
      txHash: raw?.hash,
      rawProviderPayload: raw,
    };
  }
}

/**
 * Chains a single Privy key covers.
 *
 * Exported so provisioning does not create three wallets where two keys serve
 * three chains: one secp256k1 EVM key for Ethereum AND Base, one ed25519 key
 * for Solana. Solana signs on a different curve, so it is genuinely a separate
 * key and cannot be derived from the EVM one.
 */
export function chainsPerKey(): { keyType: string; chains: WalletChain[] }[] {
  return [
    { keyType: 'evm_secp256k1', chains: ['ethereum', 'base'] },
    { keyType: 'solana_ed25519', chains: ['solana'] },
  ];
}
