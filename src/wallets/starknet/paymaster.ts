/**
 * STARKNET GAS ABSTRACTION via the AVNU paymaster (SNIP-9 / SNIP-29).
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT LIKE ARC.
 *
 * Arc needed no gas abstraction at all: USDC IS Arc's native gas token, so
 * "the recipient never buys a gas token" is a property of the chain. Starknet
 * is the opposite case. Gas is payable in STRK or ETH, Privy does NOT sponsor
 * gas on Starknet, and a brand new account holds neither. Without a paymaster
 * a Starknet user is stuck exactly where our whole product promise says they
 * should never be.
 *
 * THIS ALSO SOLVES THE PRIVY TIER 2 PROBLEM, which is the reason the design
 * landed here rather than on a local signer.
 *
 * Privy supports Starknet at Tier 2: it will create a STARK curve wallet and
 * sign a hash via rawSign, but it will NOT broadcast. Every other chain in
 * this codebase either has Privy broadcast (EVM, Solana) or has us broadcast a
 * locally assembled raw transaction (Celo CIP-64). Starknet can do neither
 * cheaply, because v3 invoke hashing covers calldata, nonce, resource bounds,
 * tip, paymaster data and both DA modes.
 *
 * The paymaster removes the problem instead of solving it:
 *
 *   1. paymaster_buildTransaction  -> AVNU returns typed data to sign
 *   2. Privy rawSign               -> signature over that typed data
 *   3. paymaster_executeTransaction -> AVNU SUBMITS the transaction
 *
 * We never broadcast, so Tier 2 is sufficient. Verified live: both endpoints
 * answer paymaster_isAvailable with true, and both methods above exist
 * (they return "Invalid params" to an empty call rather than "Method not
 * found").
 *
 * TWO MODES
 *   sponsored  we pay, from prepaid credits. Requires AVNU_API_KEY.
 *              Used for ACCOUNT DEPLOYMENT and the first transfer, because a
 *              new account has no USDC to pay with and an account on Starknet
 *              is a contract that must be deployed before it can transact.
 *   default    the user pays gas in USDC. No API key. Our standing default,
 *              so Sivan carries no float and there is no paymaster balance
 *              that can run dry and halt the chain.
 */

import { starknetRpcEndpoints } from './starknet-rpc.js';

/**
 * Public paymaster endpoints. Overridable, like every other endpoint in this
 * codebase: AVNU_PAYMASTER_URL wins when set.
 */
const PUBLIC_PAYMASTER = {
  mainnet: 'https://starknet.paymaster.avnu.fi',
  testnet: 'https://sepolia.paymaster.avnu.fi',
} as const;

export interface PaymasterOptions {
  production?: boolean;
  timeoutMs?: number;
}

export function paymasterEndpoint(options: PaymasterOptions = {}): string {
  const production = options.production ?? true;
  const configured = (process.env.AVNU_PAYMASTER_URL || '').trim();
  if (configured) return configured;
  return production ? PUBLIC_PAYMASTER.mainnet : PUBLIC_PAYMASTER.testnet;
}

/**
 * Gas token: NATIVE Circle USDC on Starknet.
 *
 * READ THIS BEFORE CHANGING THE ADDRESS. There are at least two contracts on
 * Starknet mainnet that both report symbol() as exactly "USDC", and AVNU
 * accepts BOTH as gas tokens, so a supported-token check does not tell them
 * apart. Only name() and supply do:
 *
 *   0x033068F6...93b35fb  symbol "USDC"  name "USDC"      supply ~137.9M   <- this one
 *   0x053c9125...ecf368a8 symbol "USDC"  name "USD Coin"  supply ~4.7M     StarkGate bridged
 *
 * This is the same shape as the USDC.e incident on Arbitrum, where the
 * bridged token also reported symbol "USDC" and only name() discriminated.
 * Settling into the wrong one puts funds in an asset the recipient cannot
 * off-ramp, with nothing in the symbol to warn anyone.
 *
 * Both addresses are asserted against the live chain in the test suite.
 */
export const STARKNET_GAS_TOKEN = {
  mainnet: '0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb',
  testnet: process.env.STARKNET_USDC_TESTNET_ADDRESS || '',
} as const;

export interface SupportedToken {
  token_address: string;
  decimals: number;
  price_in_strk: string;
}

/** Fee mode. `default` means the USER pays, in gasToken. */
export type FeeMode =
  | { mode: 'default'; gasToken: string }
  | { mode: 'sponsored' };

async function paymasterRpc<T>(
  method: string,
  params: unknown,
  options: PaymasterOptions = {}
): Promise<T> {
  const endpoint = paymasterEndpoint(options);
  const timeoutMs = options.timeoutMs ?? 10_000;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  /**
   * Sponsored mode only. The key must never reach a browser: this module runs
   * server side and the frontend calls our own route, not AVNU directly.
   */
  const apiKey = (process.env.AVNU_API_KEY || '').trim();
  if (apiKey) headers['x-paymaster-api-key'] = apiKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`AVNU paymaster ${method} returned HTTP ${response.status}`);
  }

  const body: any = await response.json();
  if (body?.error) {
    throw new Error(`AVNU paymaster ${method}: ${body.error?.message ?? JSON.stringify(body.error)}`);
  }
  return body?.result as T;
}

/** Is the paymaster accepting work right now? */
export async function isPaymasterAvailable(options: PaymasterOptions = {}): Promise<boolean> {
  try {
    return (await paymasterRpc<boolean>('paymaster_isAvailable', [], options)) === true;
  } catch {
    return false;
  }
}

export async function getSupportedGasTokens(
  options: PaymasterOptions = {}
): Promise<SupportedToken[]> {
  return paymasterRpc<SupportedToken[]>('paymaster_getSupportedTokens', [], options);
}

/** Compare two felt addresses regardless of leading zeros or case. */
export function sameFelt(a: string, b: string): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

/**
 * Can the user actually pay gas in our settlement token on this network?
 *
 * Checked against the live supported-token list rather than assumed, because
 * AVNU adds and removes tokens and a stale constant here would surface as a
 * failed transfer at the last step.
 */
export async function isGasTokenSupported(options: PaymasterOptions = {}): Promise<boolean> {
  const production = options.production ?? true;
  const wanted = production ? STARKNET_GAS_TOKEN.mainnet : STARKNET_GAS_TOKEN.testnet;
  if (!wanted) return false;
  try {
    const tokens = await getSupportedGasTokens(options);
    return tokens.some((t) => sameFelt(t.token_address, wanted));
  } catch {
    return false;
  }
}

export interface StarknetCall {
  contract_address: string;
  entry_point_selector: string;
  calldata: string[];
}

/**
 * Step 1 of 3: ask AVNU to build the transaction and return typed data.
 *
 * Returns whatever the paymaster gives back untouched. The caller signs the
 * typed data hash with Privy and passes both to executePaymasterTransaction.
 */
export async function buildPaymasterTransaction(
  userAddress: string,
  calls: StarknetCall[],
  feeMode: FeeMode,
  options: PaymasterOptions = {}
): Promise<unknown> {
  if (feeMode.mode === 'sponsored' && !(process.env.AVNU_API_KEY || '').trim()) {
    throw new Error(
      'Sponsored gas requires AVNU_API_KEY. Set it, or use the default fee mode ' +
        'where the user pays gas in USDC.'
    );
  }
  return paymasterRpc(
    'paymaster_buildTransaction',
    [
      {
        transaction: { type: 'invoke', invoke: { user_address: userAddress, calls } },
        parameters: { version: '0x1', fee_mode: feeMode },
      },
    ],
    options
  );
}

/**
 * Step 3 of 3: hand AVNU the signature and let IT broadcast.
 *
 * This is the call that makes Privy Tier 2 sufficient. We never touch
 * starknet_addInvokeTransaction.
 */
export async function executePaymasterTransaction(
  userAddress: string,
  typedData: unknown,
  signature: string[],
  feeMode: FeeMode,
  options: PaymasterOptions = {}
): Promise<{ transaction_hash?: string; tracking_id?: string }> {
  return paymasterRpc(
    'paymaster_executeTransaction',
    [
      {
        transaction: {
          type: 'invoke',
          invoke: { user_address: userAddress, typed_data: typedData, signature },
        },
        parameters: { version: '0x1', fee_mode: feeMode },
      },
    ],
    options
  );
}

/**
 * The fee mode Sivan uses by default: the user pays gas in USDC.
 *
 * Deliberately not sponsorship. Sponsorship needs a prepaid balance that can
 * run dry, and when it does every Starknet transfer stops rather than
 * degrading. Gasless has no balance to exhaust. Sponsorship is reserved for
 * account deployment, where the user provably has nothing to pay with.
 */
export function defaultFeeMode(production = true): FeeMode {
  const gasToken = production ? STARKNET_GAS_TOKEN.mainnet : STARKNET_GAS_TOKEN.testnet;
  if (!gasToken) {
    throw new Error('No Starknet gas token configured for this network mode.');
  }
  return { mode: 'default', gasToken };
}

/** Sponsored mode, for account deployment and the first inbound transfer. */
export function sponsoredFeeMode(): FeeMode {
  return { mode: 'sponsored' };
}

/**
 * Sanity check used by health endpoints and the test suite: the paymaster is
 * up, and it accepts the token we actually settle in.
 *
 * Reported separately rather than as one boolean, because "paymaster down"
 * and "our token is no longer an accepted gas token" need different responses
 * from an operator.
 */
export async function paymasterHealth(options: PaymasterOptions = {}): Promise<{
  available: boolean;
  gasTokenSupported: boolean;
  endpoint: string;
  rpcEndpointCount: number;
}> {
  const [available, gasTokenSupported] = await Promise.all([
    isPaymasterAvailable(options),
    isGasTokenSupported(options),
  ]);
  return {
    available,
    gasTokenSupported,
    endpoint: paymasterEndpoint(options),
    rpcEndpointCount: starknetRpcEndpoints(options).length,
  };
}
