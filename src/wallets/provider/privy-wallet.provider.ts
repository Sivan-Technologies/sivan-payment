import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { forbidden, serviceUnavailable, type AppError } from '../../shared/errors.js';
import { authorizationSignature, loadAuthorizationPrivateKey } from './privy-authorization.js';
import { buildSplTransfer, solanaMintFor } from '../solana/spl-transfer.js';
import { solanaRpc } from '../solana/solana-rpc.js';
import { erc20BalanceOf, fromBaseUnits } from '../evm/evm-rpc.js';
import { resolveNetworkMode } from '../network-mode.js';
import type { NetworkMode } from '../../database/types.js';
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

const IN_PROGRESS = /idempotency key is still in progress/i;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A single Privy call.
 *
 * Retries ONLY "Previous request with matching idempotency key is still in
 * progress", and only that. This is not general-purpose retry logic: blindly
 * retrying wallet creation is how duplicates get minted.
 *
 * Why it is needed: an idempotency key makes concurrent duplicate requests
 * safe at the far end, but Privy does not block the loser until the winner
 * finishes - it rejects it outright. Two parallel provisioning calls for the
 * same user therefore turned into a thrown error rather than two callers
 * receiving one wallet. Observed live once ethereum and base correctly began
 * sharing a key.
 *
 * Retrying is safe precisely BECAUSE the key is set: the replay returns the
 * winner's wallet instead of creating another.
 */
async function privyRequest<T>(path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<T> {
  const { idempotencyKey, ...rest } = init;

  let lastError: AppError | undefined;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(`${PRIVY_BASE}${path}`, {
      ...rest,
      headers: { ...headers(idempotencyKey), ...(rest.headers ?? {}) },
    });

    const body: any = await response.json().catch(() => ({}));
    if (response.ok) return body as T;

    const message = String(body?.error ?? body?.message ?? `HTTP ${response.status}`);
    lastError = privyError(response.status, message);

    // Anything else - 401, 404, validation - is final. Surface it immediately.
    if (!IN_PROGRESS.test(message)) throw lastError;

    // The winner is mid-flight. Back off and replay the same key.
    await sleep(150 * 2 ** attempt);
  }

  throw lastError ?? serviceUnavailable('The wallet service did not respond. Please try again in a moment.');
}

/**
 * TURN A PRIVY FAILURE INTO AN HONEST HTTP STATUS.
 *
 * Reported live: "Generate Solana address" returned
 *
 *     POST /api/users/:id/wallets  500 (Internal Server Error)
 *
 * and the user saw "We could not complete that request. Please check your
 * details and try again." Both halves of that are wrong. It is not an internal
 * error - nothing in Sivan crashed - and there is nothing in the user's details
 * to check; they cannot fix a Privy credential or a rate limit by editing a
 * form. So the toast sends them round a loop that cannot terminate.
 *
 * The cause was structural rather than specific to any one failure: every
 * rejection here was raised as a plain `new Error(...)`. app.ts checks
 * `error instanceof AppError` and falls through to
 * `err.statusCode ?? 500`, so ANY Privy problem - revoked key, wrong app id,
 * quota exhausted, chain not enabled on the dashboard, Privy having an
 * outage - collapsed into one indistinguishable 500. Verified: a plain Error
 * has no statusCode and is not an AppError.
 *
 * Mapping the status back out means the user is told whether to wait or to
 * contact support, and an operator reading logs or Sentry can tell a
 * misconfiguration from an outage without reproducing it.
 *
 * The MESSAGES here are user-facing and deliberately do not quote Privy's own
 * text, which leaks provider internals; the raw message is preserved on
 * `details` for the log and for support.
 */
function privyError(status: number, message: string): AppError {
  // Sivan's credentials are wrong, revoked, or pointed at the wrong app. The
  // user can do nothing about it, and it will not fix itself - so it must not
  // read as "try again".
  if (status === 401 || status === 403) {
    return serviceUnavailable(
      'Wallet creation is temporarily unavailable. Our team has been notified.',
      { provider: 'privy', status, providerMessage: message }
    );
  }

  // Rate limited or quota exhausted. Genuinely worth retrying.
  if (status === 429) {
    return serviceUnavailable(
      'The wallet service is busy right now. Please try again in a moment.',
      { provider: 'privy', status, providerMessage: message }
    );
  }

  // Privy rejected the request itself - an unsupported chain, a malformed
  // owner, a chain not enabled for this app in the Privy dashboard. A
  // configuration problem on our side, not a user input problem.
  if (status >= 400 && status < 500) {
    return serviceUnavailable(
      'We could not create your wallet on this network right now. Please try again or contact support.',
      { provider: 'privy', status, providerMessage: message }
    );
  }

  // Privy itself is failing.
  return serviceUnavailable(
    'The wallet service is temporarily unavailable. Please try again shortly.',
    { provider: 'privy', status, providerMessage: message }
  );
}

/**
 * Whether to sign against mainnet.
 *
 * An explicit `mode` wins, for callers that have already resolved one. Absent,
 * it asks resolveNetworkMode(), which reads this deployment's NETWORK_MODE.
 *
 * The fallback used to be `APP_ENV === 'production'`, and that was the line
 * that actually decided the chain: nothing in the codebase passes `mode`, so
 * every signature went through it. Two things were wrong with it. It conflated
 * "which environment is this" with "which chain is this", leaving no way to run
 * a staging box against mainnet or a production-shaped box against testnet. And
 * it was silent - APP_ENV is set for a dozen unrelated reasons, so the chain a
 * transfer signed against was a side effect of a variable nobody thought of as
 * chain configuration. NETWORK_MODE says what it means, and defaults to
 * mainnet, so an unset value still signs real.
 */
function isProduction(mode?: NetworkMode): boolean {
  if (mode) return mode === 'mainnet';
  return resolveNetworkMode() === 'mainnet';
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


/**
 * USDC and USDT contracts, per chain and environment.
 *
 * Hardcoded on purpose and worth being careful about: an address that is
 * merely PLAUSIBLE sends the user's funds to a contract that is not the token
 * they chose, and there is no recovering that. Mainnet values are Circle's and
 * Tether's official deployments; testnet values are Circle's published test
 * tokens.
 *
 * Deliberately incomplete rather than guessed. USDT has no Circle-style
 * canonical testnet, and Base has no native USDT at all - Breet publishes no
 * Base USDT asset either, so the gap is consistent across the stack. A missing
 * entry makes createTransfer refuse, which is the correct outcome.
 */
const ERC20_TOKENS: Record<string, { mainnet?: string; testnet?: string }> = {
  'ethereum:usdc': {
    mainnet: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    testnet: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', // Sepolia
  },
  'ethereum:usdt': {
    mainnet: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  },
  'base:usdc': {
    mainnet: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    testnet: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia
  },
};

export function erc20TokenAddress(
  chain: WalletChain,
  asset: string,
  production: boolean
): string | undefined {
  const entry = ERC20_TOKENS[`${chain}:${String(asset).toLowerCase()}`];
  if (!entry) return undefined;
  return production ? entry.mainnet : entry.testnet;
}

/** USDC and USDT are 6-decimal tokens on every chain Sivan supports. */
export function decimalsFor(asset: string): number {
  return ['usdc', 'usdt'].includes(String(asset).toLowerCase()) ? 6 : 18;
}

/**
 * Convert a decimal amount to base units without floating point.
 *
 * `Number(amount) * 10 ** decimals` is the obvious version and it is wrong:
 * 1.1 * 1e6 is 1100000.0000000001, and once that becomes a BigInt the user
 * moves a different sum than the one they approved. Parsing the string
 * directly avoids the representation entirely.
 */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const trimmed = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Invalid amount: ${amount}`);

  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) {
    // Silently truncating would move less than the user asked for, and the
    // difference is invisible on the confirmation screen.
    throw new Error(`${amount} has more than ${decimals} decimal places.`);
  }
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

/**
 * ABI-encode transfer(address,uint256).
 *
 * Selector 0xa9059cbb, then the recipient and amount each left-padded to 32
 * bytes. Written out rather than pulling in a web3 library for one call.
 */
export function encodeErc20Transfer(to: string, amount: string, decimals: number): string {
  const address = to.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`Invalid recipient address: ${to}`);

  const value = toBaseUnits(amount, decimals);
  if (value <= 0n) throw new Error('Transfer amount must be greater than zero.');

  return (
    '0xa9059cbb' +
    address.slice(2).padStart(64, '0') +
    value.toString(16).padStart(64, '0')
  );
}


/**
 * Signer ids on a wallet payload, from whichever shape Privy returned it in.
 *
 * POST /v1/wallets and GET /v1/wallets/{id} carry `additional_signers`. A
 * wallet read back from `user.linked_accounts` does NOT - it is a different
 * projection with no signer information at all. Returning [] there would
 * report a delegated wallet as non-delegated, so the reuse path re-reads the
 * wallet rather than trusting the linked-account view.
 */
function signersOf(raw: any): string[] {
  const signers = raw?.additional_signers;
  if (!Array.isArray(signers)) return [];
  return signers.map((signer: any) => signer?.signer_id).filter(Boolean);
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

    const quorumId = (process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID || env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID || '').trim();

    const created = await privyRequest<any>('/wallets', {
      method: 'POST',
      // ALWAYS derived, and deliberately NOT `input.idempotencyKey ||  ...`.
      //
      // Privy issues a second wallet for the same user and chain when this is
      // absent - verified live - so the key is the last line of defence behind
      // the findWallet reuse check above.
      //
      // Letting the caller win defeated it. user-wallet.service.ts sends
      // `sivan-wallet-${userId}-${chain}` using the SIVAN chain name, so
      // 'ethereum' and 'base' produce two DIFFERENT keys for what is one
      // secp256k1 wallet at Privy. Sequentially the reuse lookup hides that;
      // concurrently it does not, and the user ends up with two EVM addresses.
      //
      // Keying on chainType collapses ethereum and base onto one key, which is
      // the truth of the underlying key material. input.idempotencyKey is now
      // ignored here on purpose: there is no legitimate reason for a caller to
      // ask for a SECOND wallet on a chain the user already has, and every
      // accidental one costs a billable wallet that cannot be deleted.
      idempotencyKey: `sivan_wallet_${input.userId}_${chainType}`,
      body: JSON.stringify({
        chain_type: chainType,
        // Ties the Privy wallet back to the Sivan user. Without this the only
        // link is a row in Sivan's database, and a lost row means an orphaned
        // wallet with funds in it.
        owner: { user_id: await this.ensurePrivyUser(input.userId, input.metadata) },
        // Sivan as an ADDITIONAL SIGNER, when one is configured.
        //
        // Note what this is not: the owner is still the user. An additional
        // signer is a narrower grant that can be scoped by policy and revoked,
        // and it is what allows a one-tap NGN off-ramp without Sivan taking
        // custody.
        //
        // It must be set AT CREATION. Attaching a signer later is a PATCH that
        // itself requires the wallet owner's signature - which Sivan does not
        // have - so a wallet created without this can never be delegated to.
        ...(quorumId ? { additional_signers: [{ signer_id: quorumId }] } : {}),
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
    }).catch(async (error: any) => {
      // LOST A RACE. Not a hypothetical: provisioning ethereum and base
      // concurrently for a new user made both branches find no Privy user,
      // both POST /users, and the loser threw
      //   "Input conflict caused by an existing user: did:privy:..."
      // straight out of createWallet. A user double-tapping "create wallet"
      // hits this too.
      //
      // Sequential duplicates are fine - Privy answers 200 with the existing
      // user, verified live - so this is purely a concurrency edge, and the
      // right response is to adopt the winner rather than fail the request.
      const message = String(error?.message ?? '');
      if (!/conflict/i.test(message)) throw error;

      // Privy names the winning user in the error text; prefer re-reading it
      // over trusting a parsed string, and fall back to a fresh lookup.
      const did = message.match(/did:privy:[a-z0-9]+/i)?.[0];
      if (did) return { id: did };

      const retry = await findPrivyUser(userId);
      if (retry) return retry;
      throw error;
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

    const chain = chainType === 'solana' ? 'solana' : 'ethereum';

    // Re-read the wallet rather than returning the linked-account projection.
    //
    // `user.linked_accounts` does NOT carry `additional_signers` - verified
    // live, the field is absent entirely, not empty. Returning that projection
    // would report every REUSED wallet as non-delegated, which is almost all
    // of them after the first call, and Sivan would fall back to asking the
    // user to sign on wallets it can actually sign for itself.
    if (wallet?.id) {
      const full = await privyRequest<any>(`/wallets/${encodeURIComponent(wallet.id)}`).catch(() => undefined);
      if (full) return this.toProviderWallet(full, chain);
    }

    return this.toProviderWallet(wallet, chain);
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
      // Read from the wallet Privy actually returned, never assumed from
      // config. A configured quorum means new wallets GET a signer; it says
      // nothing about a wallet created before that config existed.
      delegatedSigningEnabled: signersOf(raw).length > 0,
      delegatedSignerId: signersOf(raw)[0],
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
   * Balances are read FROM THE CHAIN, not from Privy.
   *
   * Privy is a key manager, not an indexer - it signs, it does not track token
   * balances - so the question has to be put to an RPC node directly.
   *
   * WHAT THIS NUMBER IS, AND IS NOT. It is what the address holds on chain. It
   * is NOT a spendable Sivan balance: tokens can arrive that were never a Sivan
   * deposit, and the ledger remains the source of truth for what a user may
   * actually move. Callers must present it as an on-chain balance and reconcile
   * against the ledger rather than treating it as an entitlement.
   *
   * IT THROWS RATHER THAN RETURNING [] when it cannot answer. The two are not
   * interchangeable: [] is a claim that the address is empty, and the caller
   * renders it as "Nothing received yet". Returning that over a wallet holding
   * real funds is precisely the failure this replaced - a user was shown
   * "Nothing received yet" while 20 USDC sat at their address. An error sets
   * balancesUnavailable and the UI says so honestly.
   */
  async getBalances(
    _providerWalletId?: string,
    _providerCustomerId?: string,
    address?: string,
    chain?: WalletChain
  ): Promise<WalletBalance[]> {
    if (!address || !chain) {
      // Not a zero balance - a caller that did not say WHICH address on WHICH
      // chain. Guessing here is how a balance gets read off the wrong network.
      //
      // The user-facing text names no provider: "Privy" is an implementation
      // detail they did not choose and cannot act on, and the same wording
      // would be wrong the moment the provider changes. The specifics stay in
      // `details`, which reaches the log and Sentry but not the browser.
      throw serviceUnavailable(
        'We could not read your wallet balance just now. Please try again in a moment.',
        { provider: 'privy', reason: 'getBalances called without an address and chain' }
      );
    }

    const production = isProduction();

    if (chain === 'solana') {
      return this.solanaBalances(address, production);
    }

    // USDC and USDT where a contract is known for this chain and network. A
    // missing entry is skipped rather than reported as zero: Base has no
    // native USDT, and "0 USDT on Base" would be an invented figure.
    const balances: WalletBalance[] = [];

    for (const asset of ['usdc', 'usdt'] as const) {
      const token = erc20TokenAddress(chain, asset, production);
      if (!token) continue;

      const amount = await erc20BalanceOf(
        chain,
        token,
        address,
        decimalsFor(asset),
        { production }
      );

      balances.push({ asset, chain, amount, contractAddress: token });
    }

    return balances;
  }

  /**
   * SPL token balances for a Solana owner.
   *
   * Uses getTokenAccountsByOwner filtered by mint rather than deriving the
   * associated token address: the derivation needs an off-curve PDA and a
   * base58 implementation, and the RPC answers the same question directly.
   *
   * An owner with NO token account for a mint is a genuine, confirmed zero -
   * the account has never received that token - so it is reported as "0"
   * rather than skipped. That is different from an RPC that could not be
   * reached, which throws.
   */
  private async solanaBalances(address: string, production: boolean): Promise<WalletBalance[]> {
    const balances: WalletBalance[] = [];

    for (const asset of ['usdc', 'usdt'] as const) {
      const mint = solanaMintFor(asset, production);
      if (!mint) continue;

      const { result } = await solanaRpc<any>(
        'getTokenAccountsByOwner',
        [address, { mint }, { encoding: 'jsonParsed' }],
        { production }
      );

      const accounts: any[] = result?.value ?? [];

      // Summed, not first-only. One owner can hold several accounts for the
      // same mint, and showing only one under-reports the holding.
      const total = accounts.reduce((sum, account) => {
        const raw = account?.account?.data?.parsed?.info?.tokenAmount?.amount;
        return sum + (raw ? BigInt(raw) : 0n);
      }, 0n);

      balances.push({
        asset,
        chain: 'solana',
        amount: fromBaseUnits(total, 6),
        contractAddress: mint,
      });
    }

    return balances;
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

    // The one place the network is chosen for this transfer. Everything below
    // - the CAIP-2 id, the token contract, the Solana mint - must agree with
    // it, because a mainnet contract address on a testnet chain id is a
    // transfer that either reverts or lands somewhere nobody is watching.
    const caip2 = isProduction(input.networkMode) ? caip.mainnet : caip.testnet;

    const signingKey = loadAuthorizationPrivateKey(
      process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY || env.PRIVY_AUTHORIZATION_PRIVATE_KEY
    );

    // WITHOUT A SIGNING KEY, SAY SO - DO NOT PRETEND.
    //
    // This branch is the honest one and stays. A user-owned Privy wallet
    // cannot be moved by app credentials alone: signing returns 401 "No valid
    // authorization keys or user signing keys available". If Sivan holds no
    // delegated signer, the transaction genuinely needs the user, and
    // returning a payload for them to sign is the truthful shape.
    if (!signingKey) {
      return {
        provider: this.name,
        providerTransferId: `privy_pending_${input.idempotencyKey || crypto.randomUUID()}`,
        status: 'pending_user_signature',
        userSignaturePayload: {
          walletId: input.providerWalletId,
          chain: input.chain,
          caip2,
          asset: input.asset,
          amount: input.amount,
          toAddress: input.toAddress,
          reference: input.reference,
          rpcMethod: input.chain === 'solana' ? 'signAndSendTransaction' : 'eth_sendTransaction',
        },
      };
    }

    // THE KEY IS NOT ENOUGH - THIS WALLET MUST ALSO HAVE THE SIGNER.
    //
    // Holding a signing key says nothing about any particular wallet. Privy
    // attaches additional signers AT CREATION and refuses to add one later:
    // the PATCH must be signed by the wallet's OWNER, which is the user.
    // Verified live - both an app-credentialled PATCH and one signed by the
    // key being added return 401, and the signer list stays empty.
    //
    // So a wallet provisioned before delegated signing existed can NEVER gain
    // it. Checked here rather than discovered at the signing call, because the
    // honest outcome for such a wallet is pending_user_signature, not a 401
    // the caller cannot interpret.
    const wallet = await this.getWallet(input.providerWalletId).catch(() => undefined);
    if (wallet && wallet.delegatedSigningEnabled === false) {
      return {
        provider: this.name,
        providerTransferId: `privy_pending_${input.idempotencyKey || crypto.randomUUID()}`,
        status: 'pending_user_signature',
        userSignaturePayload: {
          walletId: input.providerWalletId,
          chain: input.chain,
          caip2,
          asset: input.asset,
          amount: input.amount,
          toAddress: input.toAddress,
          reference: input.reference,
          rpcMethod: input.chain === 'solana' ? 'signAndSendTransaction' : 'eth_sendTransaction',
          // Stated so a caller can explain the difference to the user, and so
          // an operator can see which wallets need reprovisioning.
          reason: 'This wallet was created without a Sivan signer and cannot be signed for automatically.',
        },
      };
    }

    // Solana takes a fully built transaction rather than a description, so it
    // is constructed here and submitted through a different RPC method.
    if (input.chain === 'solana') {
      return this.sendSolanaTransfer(input, signingKey, caip2);
    }

    // Same mode as caip2 above, NOT a fresh isProduction() read. Those two
    // disagreeing is the specific failure this parameter exists to prevent: a
    // mainnet USDC contract addressed on Base Sepolia is not a token contract
    // at all, and the transfer fails after the user has approved it.
    const token = erc20TokenAddress(input.chain, input.asset, isProduction(input.networkMode));

    if (!token) {
      throw forbidden(`No ${input.asset.toUpperCase()} contract known for ${input.chain}.`);
    }

    const url = `${PRIVY_BASE}/wallets/${encodeURIComponent(input.providerWalletId)}/rpc`;
    const body = {
      method: 'eth_sendTransaction',
      caip2,
      // Gas sponsorship. On EVM Privy can also charge gas to the wallet's own
      // USDC, but that is a dashboard setting rather than a request flag, so
      // this asks for sponsorship and reports clearly when it is switched off.
      sponsor: true,
      params: {
        transaction: {
          to: token,
          // ERC-20 transfer(address,uint256). Encoded here rather than pulling
          // in a web3 library for one 68-byte call.
          data: encodeErc20Transfer(input.toAddress, input.amount, decimalsFor(input.asset)),
          value: '0x0',
        },
      },
    };

    const { appId } = credentials();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers(input.idempotencyKey),
        'privy-authorization-signature': authorizationSignature({
          method: 'POST',
          url,
          body,
          appId,
          privateKeyPem: signingKey,
          // MUST match the header actually sent. The signature covers privy-
          // prefixed headers, so including one here that is not on the request
          // (or omitting one that is) fails as an opaque 401.
          idempotencyKey: input.idempotencyKey,
        }),
      },
      body: JSON.stringify(body),
    });

    const result: any = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = String(result?.error ?? result?.message ?? `HTTP ${response.status}`);

      // Named explicitly because the fix is a dashboard toggle, not a code
      // change, and the raw message does not say that.
      // Privy words this two ways depending on where the gap is: "not
      // enabled" when the app has no sponsorship at all, and "not configured
      // for chain <caip2>" when it is on but that specific network is not
      // covered. Both are dashboard settings rather than code faults, and the
      // raw message does not say so.
      if (/gas sponsorship is not (enabled|configured)/i.test(message)) {
        throw forbidden(
          `Gas sponsorship is not available for ${caip2}. Enable it for this network in the Privy ` +
            'dashboard, or the wallet must hold native currency to pay its own gas.'
        );
      }
      throw new Error(`Privy: ${message}`);
    }

    return {
      provider: this.name,
      // `??` was wrong here. A SPONSORED transaction is an ERC-4337 user
      // operation, and Privy returns `hash: ""` - an EMPTY STRING, not null -
      // because the real transaction hash does not exist until a bundler
      // includes it on chain. `??` only falls through on null/undefined, so
      // the empty string passed straight through and every sponsored transfer
      // was stored with an EMPTY id. Nothing could then be reconciled or
      // looked up. Confirmed live through the service path.
      providerTransferId:
        // `data.transaction_id` FIRST: Privy nests it, and the top-level read
        // this used to lead with never matched. It happened to work on EVM
        // only because the user-operation hash below caught the fall-through.
        result?.data?.transaction_id ||
        result?.transaction_id ||
        result?.data?.user_operation_hash ||
        result?.data?.hash ||
        `privy_tx_${crypto.randomUUID()}`,
      status: 'submitted',
      // Deliberately left undefined rather than '' when sponsored: there is no
      // transaction hash yet, and an empty string reads as "we have one".
      txHash: result?.data?.hash || result?.hash || undefined,
      userOperationHash: result?.data?.user_operation_hash || undefined,
      sponsored: Boolean(result?.data?.sponsorship_provider),
      rawProviderPayload: result,
    };
  }

  /**
   * Move SPL tokens out of a user's Solana wallet.
   *
   * Separate from the EVM path because the shape genuinely differs: EVM takes
   * a transaction DESCRIPTION that Privy completes, Solana takes a fully built
   * and serialised transaction that Privy only signs and broadcasts.
   *
   * The associated token account is resolved and checked before anything is
   * signed - see buildSplTransfer. That check needs an RPC, which is why
   * Solana support required an RPC layer and EVM did not.
   */
  private async sendSolanaTransfer(
    input: WalletTransferInput,
    signingKey: string,
    caip2: string
  ): Promise<WalletTransfer> {
    // Derived from the SAME input.networkMode that produced the caip2 passed
    // in above. This drives both the mint and the RPC that buildSplTransfer
    // reads token accounts from, so an env-derived value here would look up
    // the recipient's account on one network and sign for another.
    const production = isProduction(input.networkMode);
    const mint = solanaMintFor(input.asset, production);

    if (!mint) {
      throw forbidden(
        `No Solana mint known for ${String(input.asset).toUpperCase()} in this environment.`
      );
    }

    // The SENDER's address is needed to derive their token account, and
    // WalletTransferInput carries only the wallet ID. Resolved here rather
    // than added to the interface: every caller already passes an id the
    // provider can look up, and widening the interface would push a
    // Solana-specific field onto the EVM and Bridge paths that never use it.
    const wallet = await this.getWallet(input.providerWalletId);
    if (!wallet?.address) {
      throw forbidden('Could not resolve the sending wallet address for this Solana transfer.');
    }

    const built = await buildSplTransfer({
      fromOwner: wallet.address,
      toOwner: input.toAddress,
      mint,
      amount: input.amount,
      decimals: 6,
      production,
    });

    const url = `${PRIVY_BASE}/wallets/${encodeURIComponent(input.providerWalletId)}/rpc`;
    const body = {
      method: 'signAndSendTransaction',
      caip2,
      // Solana has no user-pays gas mode - Privy's token-gas feature is EVM
      // only - so sponsorship is the only way a user without SOL can move
      // USDC. Requested here and reported plainly when it is switched off.
      sponsor: true,
      params: { transaction: built.transactionBase64, encoding: 'base64' },
    };

    const { appId } = credentials();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers(input.idempotencyKey),
        'privy-authorization-signature': authorizationSignature({
          method: 'POST',
          url,
          body,
          appId,
          privateKeyPem: signingKey,
          idempotencyKey: input.idempotencyKey,
        }),
      },
      body: JSON.stringify(body),
    });

    const result: any = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = String(result?.error ?? result?.message ?? `HTTP ${response.status}`);
      if (/gas sponsorship is not (enabled|configured)/i.test(message)) {
        throw forbidden(
          `Gas sponsorship is not available for ${caip2}. Solana has no user-pays gas mode, so ` +
            'either enable sponsorship for this network in the Privy dashboard or the wallet must hold SOL.'
        );
      }
      throw new Error(`Privy: ${message}`);
    }

    /**
     * PRIVY CALLS THE SOLANA SIGNATURE `data.hash`, NOT `data.signature`.
     *
     * This read `result?.data?.signature`, which does not exist in their
     * response, so txHash was ALWAYS undefined and providerTransferId fell all
     * the way through to a random UUID. Confirmed against two real sends on
     * api-test, both stored as `privy_sol_<uuid>` with txHash null - while the
     * transactions were finalised on chain the whole time under signatures
     * Sivan had thrown away.
     *
     * The cost: nothing could look those transfers up. No confirmation, no
     * explorer link, no support answer to "did it arrive?" beyond reading the
     * recipient's balance by hand. It is also why the user concluded the money
     * had not been sent.
     *
     * Their documented 200 body (api-reference/wallets/solana/sign-and-send-
     * transaction) is:
     *   { method, data: { hash, signed_transaction, caip2, transaction_id } }
     * so transaction_id is nested under `data` as well - the top-level read
     * below never matched either.
     *
     * Every historical key is kept as a fallback rather than replaced: an
     * adapter that only understands today's shape breaks silently the next
     * time a vendor renames a field, which is exactly what happened here.
     */
    const signature = result?.data?.hash || result?.data?.signature || result?.signature || undefined;

    return {
      provider: this.name,
      // Same empty-string trap as the EVM path above: `??` would let Privy's
      // empty string through, so `||` is deliberate.
      providerTransferId:
        result?.data?.transaction_id ||
        result?.transaction_id ||
        signature ||
        `privy_sol_${crypto.randomUUID()}`,
      status: 'submitted',
      txHash: signature,
      sponsored: Boolean(result?.data?.sponsorship_provider),
      rawProviderPayload: {
        ...result,
        // Carried so a caller can explain a slightly larger SOL deduction: the
        // sender pays rent when the recipient had no token account.
        createdRecipientTokenAccount: built.createsRecipientAccount,
        estimatedRentSol: built.estimatedRentSol,
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

/**
 * Can we actually talk to Privy, right now, with the credentials we hold?
 *
 * Exists because operational health reported
 * `wallet_provider_serves_ngn_users: ok` while POST /wallets was returning 500
 * on the live API. Both statements were true at once: the signal only read
 * WHICH provider was selected, never whether that provider would answer. So
 * "All systems operational" sat at the bottom of the screen while a user was
 * being told to check details they could not fix.
 *
 * Deliberately a READ. GET /apps/:id is authenticated and cheap and creates
 * nothing - a probe that provisioned a wallet would cost money on every health
 * poll, and Privy wallets cannot be deleted.
 *
 * Never throws: a health probe that can take down the health endpoint is worse
 * than no probe.
 */
export async function probePrivyCredentials(): Promise<{ ok: boolean; status?: number; message?: string }> {
  const appId = process.env.PRIVY_APP_ID || env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET || env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) {
    return { ok: false, message: 'PRIVY_APP_ID / PRIVY_APP_SECRET are not set' };
  }

  try {
    const controller = new AbortController();
    // Short: this runs inside a health request, which must stay fast.
    const timer = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(`${PRIVY_BASE}/apps/${encodeURIComponent(appId)}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
        'privy-app-id': appId,
      },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (response.ok) return { ok: true, status: response.status };

    const body: any = await response.json().catch(() => ({}));
    return {
      ok: false,
      status: response.status,
      message: String(body?.error ?? body?.message ?? `HTTP ${response.status}`),
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
