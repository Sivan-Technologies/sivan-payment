import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { forbidden, serviceUnavailable, badRequest, type AppError } from '../../shared/errors.js';
import { authorizationSignature, loadAuthorizationPrivateKey } from './privy-authorization.js';
import { buildSplTransfer, solanaMintFor } from '../solana/spl-transfer.js';
import { solanaRpc } from '../solana/solana-rpc.js';
import { erc20BalanceOf, fromBaseUnits, waitForEvmReceipt } from '../evm/evm-rpc.js';
import { resolveNetworkMode } from '../network-mode.js';
import { db } from '../../database/json-database.js';
import type { NetworkMode } from '../../database/types.js';
import { buildCeloTransferPayload } from '../celo/celo-tx-builder.js';
import { buildCip64SigningHash, buildCip64SignedRawTx, CELO_MAINNET_CHAIN_ID, CELO_SEPOLIA_CHAIN_ID } from '../celo/cip64-serializer.js';
import { celoRpc } from '../celo/celo-rpc.js';
import type { WalletProvider } from './wallet-provider.js';
import {
  Keypair as StellarKeypairSdk,
  Asset as StellarAssetSdk,
  Networks as StellarNetworks,
  TransactionBuilder as StellarTxBuilder,
  Operation as StellarOperation,
  Account as StellarAccountSdk,
  StrKey as StellarStrKey,
  Memo as StellarMemo,
} from '@stellar/stellar-sdk';
import { generateStellarKeypair } from '../stellar/stellar-keypair.js';
import { fetchStellarAccount, horizonEndpoints } from '../stellar/stellar-rpc.js';
import { getStellarUsdcIssuer, getStellarUsdtIssuer, ensureStellarAccountAndTrustline } from '../stellar/trustline.js';

import type {
  CreateWalletInput,
  ProviderWallet,
  WalletAsset,
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

/**
 * Privy API base, from the environment.
 *
 * Was a hardcoded literal. A baked-in base URL cannot be pointed at a staging
 * tenant or a proxy without editing source, and it silently keeps working when
 * an operator believes they have redirected it, which is the failure that
 * matters: the change looks applied and is not.
 *
 * The default preserves existing behaviour so nothing breaks on deploy.
 */
const PRIVY_BASE = (process.env.PRIVY_API_BASE_URL || env.PRIVY_API_BASE_URL || 'https://api.privy.io/v1').replace(/\/+$/, '');

/** Privy's chain vocabulary, keyed by Sivan's. */
const CHAIN_TYPE: Record<WalletChain, string> = {
  ethereum: 'ethereum',
  base: 'ethereum',
  solana: 'solana',
  stellar: 'stellar',
  celo: 'ethereum',
  bsc: 'ethereum',
  bnb: 'ethereum',
  // Arbitrum One is an EVM rollup: standard JSON-RPC, standard secp256k1
  // addresses. Privy needs no new key material for it.
  arbitrum: 'ethereum',
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
  stellar: {
    mainnet: 'stellar:pubnet',
    testnet: 'stellar:testnet',
  },
  celo: {
    mainnet: 'eip155:42220',
    testnet: 'eip155:11142220',
  },
  bsc: {
    mainnet: 'eip155:56',
    testnet: 'eip155:97',
  },
  bnb: {
    mainnet: 'eip155:56',
    testnet: 'eip155:97',
  },
  /**
   * Arbitrum One and Arbitrum Sepolia.
   *
   * Both chain ids were read back from the live RPCs before being written
   * here, rather than copied from documentation:
   *   eth_chainId on arb1      -> 0xa4b1  = 42161
   *   eth_chainId on sepolia   -> 0x66eee = 421614
   *
   * The distinction matters more than usual on a rollup. An EVM address is
   * identical across both, so a transaction sent with the wrong CAIP-2 does
   * not bounce. It succeeds, on a chain nobody is watching.
   */
  arbitrum: {
    mainnet: 'eip155:42161',
    testnet: 'eip155:421614',
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

/**
 * Privy's wording when `additional_signers` names a quorum this app does not
 * own. Matched on the phrase rather than the status because Privy returns it
 * as a 400 `invalid_data` - indistinguishable by status from a genuinely
 * malformed request, and the two need opposite responses.
 */
const QUORUM_NOT_FOUND = /key quorum/i;

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
export function privyError(status: number, message: string): AppError {
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

  /**
   * THE KEY QUORUM DOES NOT BELONG TO THIS PRIVY APP.
   *
   * This is the live failure, and it is worth its own branch because it is
   * the one 4xx that RETRYING CAN NEVER FIX.
   *
   * Reproduced against the real Privy API, not inferred:
   *
   *     POST /v1/wallets { additional_signers: [{ signer_id: <bad id> }] }
   *     -> 400 {"error":"Unable to find the specified key quorums for this
   *              app...","code":"invalid_data"}
   *
   * Live was carrying PRIVY_AUTHORIZATION_KEY_QUORUM_ID
   * "4852a189a600d3364dff80f4c1ffa597", which returns 404 from
   * GET /v1/key_quorums/{id} on app cms5yve2000rv0cl1m2xk4ejo. Every single
   * wallet creation sent it as additional_signers, so every single one failed.
   *
   * It landed in the generic 4xx branch above, whose message ends "Please try
   * again or contact support." The first half of that is a lie: the value is
   * an environment variable, so the hundredth attempt fails exactly like the
   * first. Users retried, Sentry filled with identical events, and the text
   * gave nobody - user or operator - the one fact that ends it.
   *
   * NOTE WHAT THIS DELIBERATELY DOES NOT DO: fall back to creating the wallet
   * WITHOUT additional_signers. That would turn a loud, fixable outage into a
   * silent permanent one - a signer cannot be attached to an existing wallet
   * (PATCH needs the owner's signature, which Sivan does not hold), so every
   * wallet minted during the misconfiguration would be undelegatable forever
   * and no off-ramp could ever sign for it. Failing is the correct behaviour;
   * failing INFORMATIVELY is the fix.
   */
  if (QUORUM_NOT_FOUND.test(message)) {
    return serviceUnavailable(
      'Wallet creation is temporarily unavailable. Our team has been notified.',
      {
        provider: 'privy',
        status,
        providerMessage: message,
        misconfiguration: 'PRIVY_AUTHORIZATION_KEY_QUORUM_ID',
        configuredQuorumId:
          (process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID || env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID || '').trim()
          || '(not set)',
        privyAppId: process.env.PRIVY_APP_ID || env.PRIVY_APP_ID || '(not set)',
        fix:
          'PRIVY_AUTHORIZATION_KEY_QUORUM_ID does not exist in this Privy app. '
          + 'Key quorum ids are per-app. Set it to a quorum returned by '
          + 'GET /v1/key_quorums/{id} on THIS app id, and set the matching '
          + 'PRIVY_AUTHORIZATION_PRIVATE_KEY at the same time. Retrying cannot help.',
      }
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
  'celo:usdc': {
    mainnet: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
    testnet: '0x01C5C0122039549AD1493B8220cABEdD739BC44E',
  },
  'celo:usdt': {
    mainnet: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e',
    testnet: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e',
  },
  'celo:cusd': {
    mainnet: '0x765DE816845861e75A25fCA122bb6898B8B1282a',
    testnet: '0x765DE816845861e75A25fCA122bb6898B8B1282a',
  },
  'bsc:usdc': {
    mainnet: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    testnet: '0x64544969ed7EBf5f083679233325356EbE738930',
  },
  /**
   * Arbitrum USDC. Both are Circle NATIVE USDC, not the bridged USDC.e.
   *
   * Each was read back from its own RPC with symbol() and decimals() before
   * being written here, the same standard the Celo entries were held to:
   *   42161  0xaf88d065e77c8cC2239327C5EDb3A432268e5831  USDC  6dp
   *   421614 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d  USDC  6dp
   *
   * Worth the check on Arbitrum specifically. The bridged legacy token
   * USDC.e at 0xFF97...5CC8 is still widely circulated and reports symbol()
   * as exactly "USDC", so a symbol check does NOT tell them apart. Only
   * name() does:
   *
   *   native   0xaf88...5831  "USD Coin"
   *   bridged  0xFF97...5CC8  "USD Coin (Arb1)"
   *
   * The two are not interchangeable: USDC.e cannot be redeemed with Circle or
   * moved by CCTP, so a transfer into it lands in an asset the recipient
   * cannot off-ramp, with nothing in the symbol to warn anyone.
   */
  'arbitrum:usdc': {
    mainnet: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    testnet: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  },
  'arbitrum:usdt': {
    mainnet: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    testnet: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  },
  'bsc:usdt': {
    mainnet: '0x55d398326f99059fF775485246999027B3197955',
    testnet: '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd',
  },
  'bnb:usdc': {
    mainnet: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    testnet: '0x64544969ed7EBf5f083679233325356EbE738930',
  },
  'bnb:usdt': {
    mainnet: '0x55d398326f99059fF775485246999027B3197955',
    testnet: '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd',
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
  readonly supportedChains: readonly string[] = ['solana', 'ethereum', 'base', 'celo', 'bsc', 'bnb', 'arbitrum'];

  /**
   * Create (or return) the user's wallet for a chain.
   *
   * Direct Server Wallets via POST /v1/wallets:
   * Issues genuine on-chain Ed25519 (Solana) and secp256k1 (EVM) keypairs.
   */
  async createWallet(input: CreateWalletInput): Promise<ProviderWallet> {
    const chainType = CHAIN_TYPE[input.chain];
    if (!chainType || input.chain === 'stellar') throw forbidden(`Privy does not issue wallets on ${input.chain}.`);

    // Reuse an existing wallet of this chain type before creating another.
    const existing = await this.findWallet(input.userId, chainType);
    if (existing) return existing;

    const quorumId = (process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID || env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID || '').trim();

    let ownerUserId: string | undefined;
    try {
      ownerUserId = await this.ensurePrivyUser(input.userId, input.metadata);
    } catch {
      ownerUserId = undefined;
    }

    const payload: any = {
      chain_type: chainType,
    };
    if (ownerUserId) {
      payload.owner = { user_id: ownerUserId };
    }
    if (quorumId) {
      payload.additional_signers = [{ signer_id: quorumId }];
    }

    const created = await privyRequest<any>('/wallets', {
      method: 'POST',
      idempotencyKey: `sivan_wallet_${input.userId}_${chainType}`,
      body: JSON.stringify(payload),
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
      idempotencyKey: `privy_user_${userId}`,
      body: JSON.stringify({
        linked_accounts: [
          { type: 'custom_auth', custom_user_id: userId },
          ...(metadata?.email ? [{ type: 'email', address: String(metadata.email) }] : []),
        ],
      }),
    }).catch(async (error: any) => {
      const message = String(error?.message ?? '');
      if (!/conflict/i.test(message)) throw error;

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
   */
  private async findWallet(userId: string, chainType: string): Promise<ProviderWallet | undefined> {
    const chain = chainType === 'solana' ? 'solana' : 'ethereum';
    const dbWallet = await db.findUserWallet(userId, chain as any).catch(() => undefined);
    if (dbWallet?.providerWalletId) {
      const full = await privyRequest<any>(`/wallets/${encodeURIComponent(dbWallet.providerWalletId)}`).catch(() => undefined);
      if (full) return this.toProviderWallet(full, chain);
    }

    const user = await findPrivyUser(userId).catch(() => undefined);
    const wallet = (user?.linked_accounts ?? []).find(
      (account: any) => account?.type === 'wallet' && account?.chain_type === chainType
    );
    if (!wallet) return undefined;

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
    chain?: WalletChain,
    networkMode?: NetworkMode
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

    /**
     * THE SAME MODE THE TRANSFER WOULD USE.
     *
     * This was a bare isProduction(), which reads the process-wide
     * NETWORK_MODE, while createTransfer honours a per-request one. So a
     * wallet could be transferred from on Base Sepolia and read on Base
     * mainnet - and it was: a user's 20 USDC on Sepolia returned 0, because
     * the mainnet USDC contract has no balance for that address.
     *
     * isProduction(mode) falls back to resolveNetworkMode() when the caller
     * passes nothing, so existing callers keep their behaviour.
     */
    const production = isProduction(networkMode);

    if (chain === 'solana') {
      return this.solanaBalances(address, production);
    }

    if (chain === 'stellar') {
      const { readStellarTokenBalances } = await import('../stellar/stellar-rpc.js');
      const stellarBalances = await readStellarTokenBalances(address).catch(() => ({ usdc: 0, usdt: 0, xlm: 0 }));
      return [
        {
          asset: 'usdc',
          chain: 'stellar',
          amount: Number(stellarBalances.usdc).toFixed(6),
        },
        {
          asset: 'usdt',
          chain: 'stellar',
          amount: Number(stellarBalances.usdt).toFixed(6),
        },
        {
          asset: 'xlm',
          chain: 'stellar',
          amount: Number(stellarBalances.xlm).toFixed(6),
        },
      ];
    }

    // USDC and USDT where a contract is known for this chain and network. A
    // missing entry is skipped rather than reported as zero: Base has no
    // native USDT, and "0 USDT on Base" would be an invented figure.
    const balances: WalletBalance[] = [];
    const assetsToCheck: WalletAsset[] = chain === 'celo' ? ['usdc', 'usdt', 'cusd'] : ['usdc', 'usdt'];
    for (const asset of assetsToCheck) {
      const token = erc20TokenAddress(chain, asset, production);
      if (!token) continue;

      try {
        const amount = await erc20BalanceOf(
          chain,
          token,
          address,
          decimalsFor(asset),
          { production }
        );

        balances.push({ asset, chain, amount, contractAddress: token });
      } catch (err) {
        // Individual token contract read error defaults to 0 rather than failing the entire wallet
        balances.push({ asset, chain, amount: '0', contractAddress: token });
      }
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

      try {
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
      } catch (err: any) {
        // A cluster-mint mismatch (e.g. devnet mint against mainnet RPC) or empty account
        // should resolve as 0 rather than failing the entire multi-chain wallet read.
        console.warn(`[solanaBalances] getTokenAccountsByOwner non-fatal note for ${asset}:`, err?.message || err);
        balances.push({
          asset,
          chain: 'solana',
          amount: '0.000000',
          contractAddress: mint,
        });
      }
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
    if (input.chain === 'stellar') {
      return this.sendStellarTransfer(input);
    }

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

    // Celo has a dedicated flow supporting CIP-64 native fee abstraction
    // and atomic Multicall3 protocol fee collection.
    if (input.chain === 'celo') {
      return this.sendCeloTransfer(input, signingKey, caip2);
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
      // Base and BSC use Privy gas sponsorship.
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

    const evmTxHash: string | undefined = result?.data?.hash || result?.hash || undefined;
    const userOpHash: string | undefined = result?.data?.user_operation_hash || undefined;
    const isSponsored = Boolean(result?.data?.sponsorship_provider);

    /**
     * RECEIPT VERIFICATION — guard against false success receipts on EVM chains.
     *
     * For NON-SPONSORED transactions we have a real txHash immediately and can
     * poll eth_getTransactionReceipt inline to verify status 0x1 before reporting
     * success. This matches the fix applied to the Celo settlement relayer.
     *
     * For SPONSORED (ERC-4337 user operations) no txHash exists until a bundler
     * includes the user operation in a block, so we cannot poll synchronously.
     * Those fall through to 'submitted' and the background transfer-confirmation
     * poller confirms them asynchronously.
     *
     * A reverted non-sponsored tx throws immediately so the balance hold is
     * released and the user is told the truth: the send failed on-chain.
     */
    const production = isProduction(input.networkMode);
    if (evmTxHash && !isSponsored && /^0x[0-9a-fA-F]{64}$/.test(evmTxHash)) {
      const receiptResult = await waitForEvmReceipt(input.chain, evmTxHash, {
        production,
        pollAttempts: 15,  // 30s max — keeps the HTTP response under gateway timeout
        pollIntervalMs: 2_000,
      });

      if (receiptResult.reverted) {
        console.error(
          `[privy.createTransfer] ${input.chain} tx ${evmTxHash} reverted (status 0x0). No funds transferred.`
        );
        throw new Error(
          `Transaction reverted on-chain (status 0x0). No funds were transferred. txHash: ${evmTxHash}`
        );
      }

      const confirmedStatus = receiptResult.confirmed ? 'confirmed' : 'submitted';
      return {
        provider: this.name,
        providerTransferId:
          result?.data?.transaction_id ||
          result?.transaction_id ||
          evmTxHash,
        status: confirmedStatus,
        txHash: evmTxHash,
        userOperationHash: userOpHash,
        sponsored: false,
        rawProviderPayload: { ...result, confirmed: receiptResult.confirmed },
      };
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
      // 'submitted' for sponsored txs — background poller will confirm.
      status: 'submitted',
      // Deliberately left undefined rather than '' when sponsored: there is no
      // transaction hash yet, and an empty string reads as "we have one".
      txHash: evmTxHash,
      userOperationHash: userOpHash,
      sponsored: isSponsored,
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

    /**
     * COLLECT THE FEE IN THIS TRANSACTION, WHEN IT IS SWITCHED ON.
     *
     * Read here rather than in the builder so the builder stays pure and
     * testable without an admin lookup. Both switches must agree: an address
     * to send to, and an operator who has turned collection on. Either missing
     * means the fee stays where it is today - in the user's wallet.
     *
     * `.catch` on the controls read matters: a controls outage must not fail a
     * transfer the user is waiting on. Failing to the uncollected behaviour is
     * the safe direction.
     */
    const feeWallet = env.SIVAN_FEE_WALLET_SOLANA?.trim();
    const collectionOn = feeWallet
      ? await import('../wallet-controls.service.js')
          .then((mod) => mod.getWalletControls())
          /**
           * `!== false`, NOT `=== true`.
           *
           * The control now defaults ON, so an absent field means "collect".
           * `=== true` would read a controls row written before this field
           * existed as OFF and silently keep leaving fees behind - the default
           * would be right in the schema and wrong in production, which is the
           * hardest kind of wrong to notice.
           *
           * Only an explicit `false` - an admin who turned it off - stops it.
           */
          .then((controls) => controls?.collectTransferFeeOnChain !== false)
          /**
           * A controls-read failure still falls back to NOT collecting. The
           * user is waiting on this transfer; an uncollected fee is Sivan's
           * problem, a failed send is theirs.
           */
          .catch(() => false)
      : false;

    const built = await buildSplTransfer({
      fromOwner: wallet.address,
      toOwner: input.toAddress,
      mint,
      amount: input.amount,
      decimals: 6,
      production,
      ...(collectionOn && feeWallet && Number(input.feeAmount ?? 0) > 0
        ? { feeCollection: { owner: feeWallet, amount: String(input.feeAmount) } }
        : {}),
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
    const signature =
      result?.data?.hash ||
      result?.data?.signature ||
      result?.signature ||
      result?.data?.transaction_hash ||
      result?.transaction_hash ||
      result?.data?.txHash ||
      result?.data?.result ||
      (typeof result?.result === 'string' ? result.result : undefined) ||
      undefined;

    /**
     * SOLANA SIGNATURE STATUS VERIFICATION — guard against false receipts.
     *
     * signAndSendTransaction resolves when Privy broadcasts the transaction.
     * The signature exists but the transaction has NOT yet been confirmed by
     * the network. Showing a receipt immediately would be a false success
     * notification if the transaction fails to land.
     *
     * Poll getSignatureStatuses for up to 30s (15 × 2s). Solana slots are
     * ~400ms so the signature is normally confirmed within the first 2–3 polls.
     *
     * confirmed/finalized + err === null → status:'confirmed'
     * err is set (InsufficientFunds, simulation failure etc.) → throw so the
     *   balance hold is released and the user is told the truth.
     * timeout → status:'submitted'; background poller handles the rest.
     */
    let solanaStatus: 'confirmed' | 'submitted' = 'submitted';
    if (signature) {
      const solanaPollAttempts = 15;
      const solanaPollIntervalMs = 2_000;
      const solRpcOpts = { production: isProduction(input.networkMode) };

      for (let attempt = 0; attempt < solanaPollAttempts; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, solanaPollIntervalMs));

        let statusResult: any = null;
        try {
          statusResult = await solanaRpc<any>(
            'getSignatureStatuses',
            [[signature], { searchTransactionHistory: true }],
            solRpcOpts
          );
        } catch {
          // RPC hiccup — not evidence the tx failed.
          continue;
        }

        const statuses: any[] = statusResult?.result?.value ?? [];
        const sigStatus = statuses[0];

        if (!sigStatus) continue; // Not yet visible to this node.

        if (sigStatus.err !== null && sigStatus.err !== undefined) {
          // Transaction was processed and FAILED on-chain.
          console.error(
            `[privy.sendSolanaTransfer] Signature ${signature} confirmed with error:`,
            sigStatus.err
          );
          throw new Error(
            `Solana transaction failed on-chain: ${JSON.stringify(sigStatus.err)}. No funds were transferred. signature: ${signature}`
          );
        }

        const cs = sigStatus.confirmationStatus;
        if (cs === 'confirmed' || cs === 'finalized') {
          solanaStatus = 'confirmed';
          break;
        }
        // 'processed' is too early — tx is in a block but not yet confirmed
        // by a supermajority of validators. Keep polling.
      }

      if (solanaStatus !== 'confirmed') {
        console.warn(
          `[privy.sendSolanaTransfer] Signature ${signature} did not reach confirmed status within ${solanaPollAttempts * solanaPollIntervalMs / 1000}s. Returning submitted.`
        );
      }
    }

    return {
      provider: this.name,
      // Same empty-string trap as the EVM path above: `??` would let Privy's
      // empty string through, so `||` is deliberate.
      providerTransferId:
        result?.data?.transaction_id ||
        result?.transaction_id ||
        signature ||
        `privy_sol_${crypto.randomUUID()}`,
      status: solanaStatus,
      txHash: signature,
      sponsored: Boolean(result?.data?.sponsorship_provider),
      rawProviderPayload: {
        ...result,
        // Carried so a caller can explain a slightly larger SOL deduction: the
        // sender pays rent when the recipient had no token account.
        createdRecipientTokenAccount: built.createsRecipientAccount,
        estimatedRentSol: built.estimatedRentSol,
        feeSkippedReason: built.feeSkippedReason,
      },
    };
  }

  /**
   * Execute an on-chain Celo USDC/USDT/cUSD transfer using Celo native fee
   * abstraction (CIP-64 / Type 0x7b transactions).
   *
   * WHY THIS EXISTS — THE PRIVY SCHEMA PROBLEM
   *
   * Privy's high-level RPC endpoint (`eth_sendTransaction`) validates all
   * transaction parameters against a strict EIP-1559 Zod schema. Celo's custom
   * `feeCurrency` field is not in the EIP-1559 spec, so Privy rejects it:
   *   "Unrecognized key(s) in object: 'feeCurrency'"
   * Without feeCurrency the node requires native CELO for gas, which Sivan
   * users do not hold.
   *
   * THE FIX — THREE STEPS, PRIVY STILL HOLDS THE KEYS
   *
   * 1. Build the CIP-64 transaction locally (Sivan's server). Compute the
   *    keccak256 hash of the 0x7b-prefixed RLP envelope.
   *
   * 2. Call Privy's low-level `raw_sign` endpoint with that hash. Privy signs
   *    it with the wallet's secp256k1 key inside its HSM and returns r, s, v.
   *    No schema validation happens — Privy only sees a 32-byte hash.
   *
   * 3. Attach the signature to the CIP-64 envelope and broadcast the raw
   *    transaction directly to the Celo node via eth_sendRawTransaction.
   *    The node honours `feeCurrency` and deducts gas from USDC/USDT/cUSD.
   *    Zero native CELO required in the user's wallet.
   *
   * Sivan fee collection: if SIVAN_CELO_FEE_WALLET is set and feeAmount > 0,
   * buildCeloTransferPayload bundles the recipient transfer and the fee sweep
   * atomically via Multicall3 in the same transaction.
   */
  private async sendCeloTransfer(
    input: WalletTransferInput,
    signingKey: string,
    caip2: string
  ): Promise<WalletTransfer> {
    const production = isProduction(input.networkMode);
    const token = erc20TokenAddress('celo', input.asset, production);
    if (!token) throw forbidden(`No ${input.asset.toUpperCase()} contract known for Celo.`);

    const chainId = production ? CELO_MAINNET_CHAIN_ID : CELO_SEPOLIA_CHAIN_ID;
    const rpcOpts = { production };

    // -------------------------------------------------------------------
    // Step 1a: resolve the transfer calldata
    // EOA transfers directly invoke USDC.transfer(recipient, amount).
    // Multicall3 cannot be used for EOA transfers because Multicall3.aggregate3
    // executes as msg.sender == Multicall3, which holds zero tokens and reverts.
    // -------------------------------------------------------------------
    const payload = buildCeloTransferPayload({
      tokenAddress: token,
      recipientAddress: input.toAddress,
      amount: input.amount,
      decimals: decimalsFor(input.asset),
    });

    // -------------------------------------------------------------------
    // Step 1b: resolve the SENDER address (needed for nonce and fee checks)
    // -------------------------------------------------------------------
    const walletRow = await db.findWalletByProviderWalletId(input.providerWalletId).catch(() => undefined);
    let senderAddress = walletRow?.address;
    if (!senderAddress) {
      const pWallet = await this.getWallet(input.providerWalletId).catch(() => undefined);
      senderAddress = pWallet?.address;
    }

    if (!senderAddress) {
      throw forbidden(
        `Celo CIP-64: could not resolve sender address for wallet ${input.providerWalletId}. ` +
        'The wallet must exist in the database or Privy before a transfer can be signed.'
      );
    }

    // -------------------------------------------------------------------
    // Step 1c: resolve feeCurrency adapter (USDC > USDT > cUSD priority)
    // -------------------------------------------------------------------
    let feeCurrency = input.feeCurrency?.trim();
    if (!feeCurrency) {
      try {
        const { resolveCeloFeeCurrency } = await import('../celo/celo-fee-currency.js');
        const resolved = await resolveCeloFeeCurrency(senderAddress, rpcOpts);
        feeCurrency = resolved.feeCurrencyAddress;
      } catch {
        const { getCeloFeeCurrencyRegistry } = await import('../celo/celo-fee-currency.js');
        feeCurrency = getCeloFeeCurrencyRegistry(rpcOpts).usdcAdapter;
      }
    }

    // -------------------------------------------------------------------
    // Step 1d: fetch nonce and gas parameters from Celo RPC
    // -------------------------------------------------------------------

    const [nonceHex, gasPriceHex] = await Promise.all([
      celoRpc<string>('eth_getTransactionCount', [senderAddress, 'pending'], rpcOpts),
      celoRpc<string>('eth_gasPrice', [feeCurrency], rpcOpts).catch(() => celoRpc<string>('eth_gasPrice', [], rpcOpts)),
    ]);

    const nonce = BigInt(nonceHex);
    // Celo eth_gasPrice(feeCurrency) returns the base price in that fee token.
    // Add a 30% buffer + priority tip to guarantee it exceeds any node base fee floor.
    const baseGasPrice  = BigInt(gasPriceHex);
    const maxPriority   = 2_000_000_000n;                        // 2 Gwei tip
    const maxFee        = (baseGasPrice * 13n / 10n) + maxPriority;

    // Safe gas limit for ERC-20 transfer with feeCurrency adapter overhead (~50k extra)
    const gasLimit = 250_000n;

    // -------------------------------------------------------------------
    // Step 1d: build the CIP-64 signing hash
    // -------------------------------------------------------------------
    const cip64Params = {
      chainId,
      nonce,
      maxPriorityFeePerGas: maxPriority,
      maxFeePerGas: maxFee,
      gasLimit,
      to: payload.to,
      value: 0n,
      data: payload.data,
      feeCurrency,
    };

    const signingHash = buildCip64SigningHash(cip64Params);

    // -------------------------------------------------------------------
    // Step 2: Privy secp256k1_sign — Privy signs the hash inside HSM
    // -------------------------------------------------------------------
    const rawSignUrl = `${PRIVY_BASE}/wallets/${encodeURIComponent(input.providerWalletId)}/rpc`;
    const rawSignBody = {
      method: 'secp256k1_sign',
      params: { hash: signingHash },
    };
    const { appId } = credentials();

    const rawSignResponse = await fetch(rawSignUrl, {
      method: 'POST',
      headers: {
        ...headers(input.idempotencyKey),
        'privy-authorization-signature': authorizationSignature({
          method: 'POST',
          url: rawSignUrl,
          body: rawSignBody,
          appId,
          privateKeyPem: signingKey,
          idempotencyKey: input.idempotencyKey,
        }),
      },
      body: JSON.stringify(rawSignBody),
    });

    const rawSignResult: any = await rawSignResponse.json().catch(() => ({}));
    if (!rawSignResponse.ok) {
      const msg = String(rawSignResult?.error ?? rawSignResult?.message ?? `HTTP ${rawSignResponse.status}`);
      throw new Error(`Privy Celo secp256k1_sign: ${msg}`);
    }

    const privySignature: string = rawSignResult?.data?.signature ?? rawSignResult?.signature;
    if (!privySignature) {
      throw new Error('Privy Celo secp256k1_sign: response did not contain a signature field.');
    }

    // -------------------------------------------------------------------
    // Step 3: assemble signed CIP-64 raw tx and broadcast to Celo RPC
    // -------------------------------------------------------------------
    const rawTx = buildCip64SignedRawTx(cip64Params, privySignature);

    const txHash = await celoRpc<string>('eth_sendRawTransaction', [rawTx], rpcOpts);

    // -------------------------------------------------------------------
    // Step 3b: RECEIPT VERIFICATION — guard against false success receipts.
    //
    // eth_sendRawTransaction resolves as soon as the node accepts the broadcast.
    // It does NOT mean the transaction was included and it certainly does NOT
    // mean it succeeded. A tx can be included and REVERT (status 0x0) — in that
    // case no value moved and returning 'submitted' (let alone 'confirmed')
    // would emit a false receipt the user could screenshot as proof of payment.
    //
    // Poll the receipt for up to ~30s (15 × 2s). Celo blocks every ~5s so the
    // receipt normally arrives on attempt 1–3.
    //
    // Reverted → throw immediately so the balance hold is released and the user
    //            is told the truth: the send failed on-chain.
    // TimedOut → return 'submitted'; the background transfer-confirmation poller
    //            will finish it and fire a confirmed notification.
    // -------------------------------------------------------------------
    if (txHash) {
      const receiptResult = await waitForEvmReceipt('celo', txHash, {
        production,
        pollAttempts: 15,
        pollIntervalMs: 2_000,
      });

      if (receiptResult.reverted) {
        console.error(
          `[privy.sendCeloTransfer] Transaction ${txHash} reverted (status 0x0). No funds were transferred.`
        );
        throw new Error(
          `Celo transaction reverted on-chain (status 0x0). No funds were transferred. txHash: ${txHash}`
        );
      }

      if (receiptResult.confirmed) {
        // -------------------------------------------------------------------
        // Step 4: Collect Sivan Protocol Fee on-chain if feeAmount > 0
        // -------------------------------------------------------------------
        let feeTxHash: string | undefined;
        const feeWallet = env.SIVAN_FEE_WALLET_CELO?.trim() || process.env.SIVAN_FEE_WALLET_CELO?.trim();
        const feeAmountNum = Number(input.feeAmount ?? 0);

        if (feeWallet && feeAmountNum > 0 && feeWallet.toLowerCase() !== senderAddress.toLowerCase()) {
          try {
            const collectionOn = await import('../wallet-controls.service.js')
              .then((mod) => mod.getWalletControls())
              .then((controls) => controls?.collectTransferFeeOnChain !== false)
              .catch(() => false);

            if (collectionOn) {
              const feePayload = buildCeloTransferPayload({
                tokenAddress: token,
                recipientAddress: feeWallet,
                amount: String(input.feeAmount),
                decimals: decimalsFor(input.asset),
              });

              const feeCip64Params = {
                chainId,
                nonce: nonce + 1n,
                maxPriorityFeePerGas: maxPriority,
                maxFeePerGas: maxFee,
                gasLimit,
                to: feePayload.to,
                value: 0n,
                data: feePayload.data,
                feeCurrency,
              };

              const feeSigningHash = buildCip64SigningHash(feeCip64Params);
              const feeIdempotencyKey = input.idempotencyKey ? `${input.idempotencyKey}_fee` : undefined;
              const feeSignBody = { method: 'secp256k1_sign', params: { hash: feeSigningHash } };

              const feeSignResponse = await fetch(rawSignUrl, {
                method: 'POST',
                headers: {
                  ...headers(feeIdempotencyKey),
                  'privy-authorization-signature': authorizationSignature({
                    method: 'POST',
                    url: rawSignUrl,
                    body: feeSignBody,
                    appId,
                    privateKeyPem: signingKey,
                    idempotencyKey: feeIdempotencyKey,
                  }),
                },
                body: JSON.stringify(feeSignBody),
              });

              const feeSignResult: any = await feeSignResponse.json().catch(() => ({}));
              if (feeSignResponse.ok) {
                const feePrivySignature: string = feeSignResult?.data?.signature ?? feeSignResult?.signature;
                if (feePrivySignature) {
                  const feeRawTx = buildCip64SignedRawTx(feeCip64Params, feePrivySignature);
                  feeTxHash = await celoRpc<string>('eth_sendRawTransaction', [feeRawTx], rpcOpts);
                }
              } else {
                console.warn('[privy.sendCeloTransfer] Fee sign note:', feeSignResult?.error ?? feeSignResult?.message);
              }
            }
          } catch (feeErr) {
            console.warn('[privy.sendCeloTransfer] On-chain Celo protocol fee transfer note:', feeErr);
          }
        }

        return {
          provider: this.name,
          providerTransferId: txHash,
          status: 'confirmed',
          txHash,
          userOperationHash: undefined,
          sponsored: false,
          rawProviderPayload: { chainId: chainId.toString(), txHash, feeTxHash, feeCurrency, senderAddress, confirmed: true },
        };
      }

      // timedOut — broadcast is in flight, background poller will confirm.
      console.warn(`[privy.sendCeloTransfer] Receipt for ${txHash} timed out after polling; returning submitted.`);
    }

    return {
      provider: this.name,
      providerTransferId: txHash ?? `privy_celo_cip64_${crypto.randomUUID()}`,
      status: 'submitted',
      txHash: txHash || undefined,
      userOperationHash: undefined,
      sponsored: false,
      rawProviderPayload: { chainId: chainId.toString(), txHash, feeCurrency, senderAddress, confirmed: false },
    };
  }

  /**
   * Execute an on-chain transfer on Stellar Horizon using non-custodial Ed25519 keys.
   */
  private async sendStellarTransfer(input: WalletTransferInput): Promise<WalletTransfer> {
    const production = isProduction(input.networkMode);
    const networkPassphrase = production ? StellarNetworks.PUBLIC : StellarNetworks.TESTNET;

    let userId = input.userId;
    if (!userId && input.providerWalletId) {
      const w = await db.findWalletByProviderWalletId(input.providerWalletId).catch(() => undefined);
      if (w?.userId) userId = w.userId;
      if (!userId && input.providerWalletId.startsWith('stellar_')) {
        const addr = input.providerWalletId.replace(/^stellar_/, '');
        const wByAddr = await db.findWalletByAddress(addr).catch(() => undefined);
        if (wByAddr?.userId) userId = wByAddr.userId;
      }
    }

    if (!userId) {
      throw badRequest('Could not resolve user identity for this Stellar transfer.');
    }

    if (!StellarStrKey.isValidEd25519PublicKey(input.toAddress)) {
      throw badRequest(`Invalid Stellar destination address: ${input.toAddress}`);
    }

    const kp = generateStellarKeypair(`sivan_stellar_${userId}`);
    const senderKeypair = StellarKeypairSdk.fromSecret(kp.secretKey);
    const senderAddress = senderKeypair.publicKey();

    let senderAccountResp = await fetchStellarAccount(senderAddress, { production });
    if (!senderAccountResp && !production) {
      try {
        await fetch(`https://friendbot.stellar.org/?addr=${senderAddress}`);
        await new Promise((r) => setTimeout(r, 2000));
        senderAccountResp = await fetchStellarAccount(senderAddress, { production });
      } catch {}
    }

    if (!senderAccountResp) {
      throw forbidden(`Sending Stellar wallet (${senderAddress}) is not activated on the network.`);
    }

    // Auto-setup destination if it is an internal Sivan user
    const destWallet = await db.findWalletByAddress(input.toAddress).catch(() => undefined);
    if (destWallet?.userId) {
      await ensureStellarAccountAndTrustline(`sivan_stellar_${destWallet.userId}`, input.toAddress, { production }).catch(() => null);
    } else if (!production) {
      const destAccount = await fetchStellarAccount(input.toAddress, { production });
      if (!destAccount) {
        try {
          await fetch(`https://friendbot.stellar.org/?addr=${input.toAddress}`);
          await new Promise((r) => setTimeout(r, 1500));
        } catch {}
      }
    }

    const senderAccount = new StellarAccountSdk(senderAddress, senderAccountResp.sequence);
    const builder = new StellarTxBuilder(senderAccount, {
      fee: '200',
      networkPassphrase,
    });

    const normalizedAsset = String(input.asset || 'usdc').toLowerCase();
    let stellarAsset: StellarAssetSdk;
    if (normalizedAsset === 'xlm' || normalizedAsset === 'native') {
      stellarAsset = StellarAssetSdk.native();
    } else if (normalizedAsset === 'usdt') {
      stellarAsset = new StellarAssetSdk('USDT', getStellarUsdtIssuer({ production }));
    } else {
      stellarAsset = new StellarAssetSdk('USDC', getStellarUsdcIssuer({ production }));
    }

    builder.addOperation(
      StellarOperation.payment({
        destination: input.toAddress,
        asset: stellarAsset,
        amount: String(input.amount),
      })
    );

    const feeWallet = env.SIVAN_FEE_WALLET_STELLAR?.trim() || process.env.SIVAN_FEE_WALLET_STELLAR?.trim();
    if (feeWallet && Number(input.feeAmount ?? 0) > 0 && StellarStrKey.isValidEd25519PublicKey(feeWallet)) {
      builder.addOperation(
        StellarOperation.payment({
          destination: feeWallet,
          asset: stellarAsset,
          amount: String(input.feeAmount),
        })
      );
    }

    if (input.reference) {
      builder.addMemo(StellarMemo.text(String(input.reference).slice(0, 28)));
    }

    const tx = builder.setTimeout(60).build();
    tx.sign(senderKeypair);
    const txXdr = tx.toXDR();

    const endpoints = horizonEndpoints({ production });
    let txHash: string | undefined;
    let submitError: string | undefined;

    for (const base of endpoints) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const formData = new URLSearchParams();
        formData.append('tx', txXdr);

        const res = await fetch(`${base}/transactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formData.toString(),
          signal: controller.signal,
        });

        const data: any = await res.json().catch(() => ({}));
        if (res.ok && (data?.hash || data?.successful)) {
          txHash = data.hash || data.id;
          break;
        } else {
          const detail = data?.extras?.result_codes
            ? JSON.stringify(data.extras.result_codes)
            : data?.detail || data?.title || `HTTP ${res.status}`;
          submitError = detail;
        }
      } catch (err: any) {
        submitError = err?.message || String(err);
      } finally {
        clearTimeout(timer);
      }
    }

    if (!txHash) {
      throw new Error(`Stellar Horizon transaction broadcast failed: ${submitError || 'Unknown error'}`);
    }

    return {
      provider: this.name,
      providerTransferId: txHash,
      txHash,
      status: 'submitted',
      sponsored: true,
      rawProviderPayload: { txHash, network: production ? 'public' : 'testnet' },
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

    if (/^[0-9a-fA-F]{64}$/.test(providerTransferId)) {
      const endpoints = horizonEndpoints();
      for (const base of endpoints) {
        try {
          const res = await fetch(`${base}/transactions/${providerTransferId}`);
          if (res.ok) {
            const data: any = await res.json().catch(() => null);
            if (data && typeof data.successful === 'boolean') {
              return {
                provider: this.name,
                providerTransferId,
                status: data.successful ? 'confirmed' : 'failed',
                txHash: providerTransferId,
                rawProviderPayload: data,
              };
            }
          }
        } catch {}
      }
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
 * Deliberately a READ. It creates nothing - a probe that provisioned a wallet
 * would cost money on every health poll, and Privy wallets cannot be deleted.
 *
 * Never throws: a health probe that can take down the health endpoint is worse
 * than no probe.
 *
 *
 * THIS PROBE PREVIOUSLY GAVE A CONFIDENTLY WRONG DIAGNOSIS.
 *
 * Live reported, verbatim:
 *
 *     PRIVY_AUTHORIZATION_KEY_QUORUM_ID "p6udcvpskmckzjykax1ss83t" is not
 *     usable by this app (401: Invalid app ID or app secret.)
 *
 * That sent the operator hunting a key quorum. The quorum was fine. The app
 * SECRET was wrong, and Privy never even looked at the quorum because auth
 * failed first. Measured against the real API rather than assumed:
 *
 *     quorum in this app            -> 200
 *     quorum in a DIFFERENT app     -> 404  Key quorum not found
 *     quorum that does not exist    -> 404  Key quorum not found
 *     right app id + wrong secret   -> 401  Invalid app ID or app secret.
 *     prod app id + sandbox secret  -> 401  Invalid app ID or app secret.
 *
 * So 404 means the QUORUM is wrong and 401 means the SECRET is wrong. Two
 * different faults with two different fixes, and they must never share wording
 * - rotating a good secret because the probe blamed the wrong thing is a
 * self-inflicted outage.
 *
 * THE ROOT CAUSE WAS THE FIRST CALL, WHICH DID NOT AUTHENTICATE AT ALL.
 *
 * The probe used to open with `GET /apps/{id}` as its credential check. That
 * endpoint does NOT authenticate - verified by calling it with the literal
 * secret "fake-secret-xyz" and receiving 200 plus the app's real name. So the
 * credential check passed unconditionally, execution ALWAYS fell through to
 * the quorum branch, and that branch attributed the resulting 401 to whatever
 * quorum id it happened to be holding.
 *
 * A health probe whose first assertion cannot fail is not a check, it is
 * decoration - and this one actively misdirected the person debugging it.
 *
 * `GET /wallets?limit=1` replaces it: it genuinely 401s on a bad secret
 * (verified both ways), and it is the closest READ to the write this signal
 * actually cares about - wallet creation.
 */
export async function probePrivyCredentials(): Promise<{ ok: boolean; status?: number; message?: string }> {
  const appId = process.env.PRIVY_APP_ID || env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET || env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) {
    return { ok: false, message: 'PRIVY_APP_ID / PRIVY_APP_SECRET are not set' };
  }

  const auth = {
    Authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
    'privy-app-id': appId,
  };

  /** Short timeout: this runs inside a health request, which must stay fast. */
  const get = async (path: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    return fetch(`${PRIVY_BASE}/${path}`, { headers: auth, signal: controller.signal })
      .finally(() => clearTimeout(timer));
  };

  try {
    /**
     * AN ENDPOINT THAT ACTUALLY REJECTS A BAD SECRET.
     *
     * Not GET /apps/{id} - see the header. That returns 200 for any secret at
     * all, which is why this probe used to blame the quorum for every
     * credential fault.
     */
    const response = await get('wallets?limit=1');

    if (!response.ok) {
      const body: any = await response.json().catch(() => ({}));
      const detail = String(body?.error ?? body?.message ?? `HTTP ${response.status}`);
      return {
        ok: false,
        status: response.status,
        message:
          response.status === 401 || response.status === 403
            ? `${detail} PRIVY_APP_SECRET does not belong to PRIVY_APP_ID "${appId}". `
              + 'Copy the App secret from THIS app in the Privy dashboard - a secret from '
              + 'another app returns exactly this error. The key quorum is NOT involved: '
              + 'Privy rejects the credentials before it ever reads it.'
            : detail,
      };
    }

    /**
     * CREDENTIALS BEING VALID IS NOT THE SAME AS WALLET CREATION WORKING.
     *
     * The wallet POST sends one thing this read does not:
     *
     *     additional_signers: [{ signer_id: PRIVY_AUTHORIZATION_KEY_QUORUM_ID }]
     *
     * A quorum id belonging to a DIFFERENT Privy app - the usual outcome of
     * copying test env values into production, since quorum ids are per-app -
     * authenticates perfectly and then fails the create with a 404. So the
     * probe has to check the quorum separately, or it keeps reporting healthy
     * while no user can get a wallet.
     *
     * Only checked when one is configured: the quorum is optional, and its
     * absence is a different (already reported) signal about delegated
     * signing rather than a fault.
     */
    const quorumId = (process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID || env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID || '').trim();
    if (!quorumId) return { ok: true, status: response.status };

    const quorumResponse = await get(`key_quorums/${encodeURIComponent(quorumId)}`);
    if (quorumResponse.ok) return { ok: true, status: response.status };

    const quorumBody: any = await quorumResponse.json().catch(() => ({}));
    return {
      ok: false,
      status: quorumResponse.status,
      message:
        `The app secret is CORRECT, but PRIVY_AUTHORIZATION_KEY_QUORUM_ID "${quorumId}" `
        + `is not in app "${appId}" (${quorumResponse.status}: `
        + `${String(quorumBody?.error ?? quorumBody?.message ?? 'not found')}). `
        + 'Every wallet creation sends this as additional_signers and will fail. '
        + 'Key quorum ids are per-app - create one in THIS app, or point PRIVY_APP_ID at the app that owns it. '
        + 'Do NOT rotate the app secret: it authenticated fine to reach this check.',
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * WHAT PRIVY HAS ACTUALLY BILLED US, in USD.
 *
 * GET /v1/apps/gas_spend is authoritative in a way our own estimate can never
 * be: gas-policy.ts multiplies a hardcoded rent constant by a hardcoded SOL
 * price, which is fine for a pre-flight limit and wrong for reconciliation.
 * Two numbers with different jobs - this one is the invoice.
 *
 * Constraints from the API, and each one shapes the call:
 *   - wallet_ids is REQUIRED and capped at 100, so this batches.
 *   - the range must not exceed 30 days.
 *   - "user pays" transfers are excluded by Privy, which is correct: those
 *     cost our credits nothing.
 *
 * Never throws. This feeds a health signal and an admin panel; a Privy outage
 * must not take either down, and "unknown" is an honest answer that a zero
 * would not be.
 */
export async function fetchPrivyGasSpendUsd(input: {
  walletIds: string[];
  startMs: number;
  endMs: number;
}): Promise<{ ok: boolean; usd?: number; message?: string }> {
  const appId = process.env.PRIVY_APP_ID || env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET || env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) return { ok: false, message: 'Privy credentials are not configured' };
  if (!input.walletIds.length) return { ok: true, usd: 0 };

  const auth = `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`;
  let total = 0;

  try {
    // 100 ids per request is Privy's documented ceiling.
    for (let index = 0; index < input.walletIds.length; index += 100) {
      const batch = input.walletIds.slice(index, index + 100);
      const params = new URLSearchParams();
      for (const id of batch) params.append('wallet_ids', id);
      params.set('start_timestamp', String(Math.floor(input.startMs)));
      params.set('end_timestamp', String(Math.floor(input.endMs)));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(`${PRIVY_BASE}/apps/gas_spend?${params.toString()}`, {
        headers: { Authorization: auth, 'privy-app-id': appId },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));

      if (!response.ok) {
        const body: any = await response.json().catch(() => ({}));
        return {
          ok: false,
          message: `Privy gas_spend returned ${response.status}: ${String(body?.error ?? body?.message ?? 'unknown')}`,
        };
      }

      const body: any = await response.json().catch(() => ({}));
      total += Number(body?.value ?? 0);
    }

    return { ok: true, usd: Math.round(total * 1e6) / 1e6 };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
