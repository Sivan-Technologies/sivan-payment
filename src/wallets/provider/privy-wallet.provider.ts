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

/**
 * Privy returns created_at in TWO different units, in the same API.
 *
 * `POST /v1/wallets` answers `created_at: 1785563814490` - milliseconds.
 * `POST /v1/users`   answers `created_at: 1785563768`    - seconds.
 * Both were captured live in the same minute, which is how the discrepancy
 * became visible at all.
 *
 * Feeding the seconds value to `new Date(Number(...))` dates the record to
 * January 1970, so a wallet created today sorts before every other row and any
 * "created in the last 24h" query silently misses it.
 *
 * Ten digits is seconds, thirteen is milliseconds - unambiguous until the year
 * 2286.
 */
function privyTimestampToIso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;

  const milliseconds = numeric < 1e11 ? numeric * 1000 : numeric;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Find the Privy user carrying a given Sivan user id.
 *
 * THREE THINGS HERE WERE WRONG UNTIL THEY WERE RUN AGAINST REAL PRIVY.
 *
 * 1. `GET /v1/users/search` does not exist. It answers 405 Method Not Allowed.
 *    The search endpoint is a POST, and it accepts only `searchTerm`, `emails`,
 *    `phoneNumbers` or `walletAddresses` - a POST carrying `custom_user_id` is
 *    rejected 400 with "unrecognized_keys". There is NO server-side lookup by
 *    custom_user_id at all.
 *
 * 2. `GET /v1/users?custom_user_id=...` answers 200 and looks like it worked.
 *    It is a lie: the parameter is IGNORED and every user in the app comes
 *    back. Verified by creating two users and asking for one - both returned,
 *    and a deliberately bogus id also returned both. The previous code read
 *    `data[0].id` off that response, so it would hand whichever user happens
 *    to sort first to whoever asked. That is one user receiving another user's
 *    wallet and, eventually, another user's money.
 *
 * 3. The old code wrapped the call in `.catch(() => undefined)`, so the 405
 *    was swallowed and read as "no such user", meaning every call would have
 *    created a fresh user.
 *
 * So: page the list and match locally. Failures are NOT caught here - a lookup
 * that errors must not be reported as "user does not exist", because the
 * caller's response to that is to create a duplicate.
 *
 * COST, STATED PLAINLY: this is O(users) per call, 100 per page. Correct at
 * Sivan's current size and unacceptable at 50,000 users. The fix is not a
 * better search - Privy does not offer one - it is to persist the returned
 * `did:privy:...` id on the Sivan user record and look the user up directly
 * via GET /v1/users/{id}, which is verified to work. This function then
 * becomes the fallback for records predating that column. Deliberately not
 * done here: it needs a migration and a backfill, and shipping it silently
 * inside a bug fix is how migrations get missed.
 */
async function findPrivyUser(userId: string): Promise<any | undefined> {
  let cursor: string | undefined;

  // Bounded so a large app cannot spin forever; 100 pages x 100 users.
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);

    const response = await privyRequest<any>(`/users?${query.toString()}`);
    const users: any[] = response?.data ?? [];

    const match = users.find((user) =>
      (user?.linked_accounts ?? []).some(
        (account: any) => account?.type === 'custom_auth' && account?.custom_user_id === userId
      )
    );
    if (match) return match;

    cursor = response?.next_cursor ?? undefined;
    if (!cursor || users.length === 0) return undefined;
  }

  return undefined;
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
      // NEVER left to the caller. Privy happily issues a second wallet for the
      // same user and chain when this is absent - verified live - so an absent
      // key is a duplicate address waiting to happen. Derived from the Sivan
      // user id and chain type so a retry always replays the first wallet.
      idempotencyKey: input.idempotencyKey || `sivan_wallet_${input.userId}_${chainType}`,
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
    const found = await findPrivyUser(userId);
    if (found) return found.id;

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

  /**
   * The user's existing wallet of a chain type, if any.
   *
   * Deliberately NOT error-tolerant. Privy does not deduplicate wallets:
   * verified live by posting the same {chain_type, owner} twice without an
   * idempotency key, which produced a second Ethereum address for one user.
   * A swallowed error here therefore does not degrade gracefully, it mints a
   * second address that receives deposits nothing is watching.
   */
  private async findWallet(userId: string, chainType: string): Promise<ProviderWallet | undefined> {
    const user = await findPrivyUser(userId);

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
      // A wallet read back from `user.linked_accounts` carries NO `created_at`
      // key whatsoever - it has `verified_at`, and in seconds rather than the
      // milliseconds `POST /wallets` returns. Without this fallback every
      // wallet Sivan reuses (i.e. almost all of them after the first call)
      // reports an undefined creation time.
      createdAt: privyTimestampToIso(raw?.created_at ?? raw?.first_verified_at ?? raw?.verified_at),
    };
  }

  async getWallet(providerWalletId: string): Promise<ProviderWallet> {
    const raw = await privyRequest<any>(`/wallets/${encodeURIComponent(providerWalletId)}`);
    return this.toProviderWallet(raw, raw?.chain_type === 'solana' ? 'solana' : 'ethereum');
  }

  async listWallets(providerCustomerId: string): Promise<ProviderWallet[]> {
    const user = await findPrivyUser(providerCustomerId);

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
