/**
 * STARKNET JSON-RPC, for READING chain state.
 *
 * Built the same shape as evm/evm-rpc.ts and solana/solana-rpc.ts so an
 * operator who has read one has read all three: configured endpoint first,
 * then a fallback, then a public tier, with transport failures moving to the
 * next tier and chain-level answers surfaced rather than retried.
 *
 * WHAT IS DIFFERENT FROM EVM, AND WHY IT MATTERS
 *
 * 1. The method namespace is starknet_*, not eth_*. Different request shape:
 *    a call takes {contract_address, entry_point_selector, calldata} rather
 *    than {to, data}.
 *
 * 2. The chain id is an ASCII SHORT STRING encoded as a felt, not an integer.
 *    starknet_chainId returns 0x534e5f4d41494e, which decodes to "SN_MAIN".
 *    Comparing it as a number gives a meaningless answer that still compares
 *    cleanly against other meaningless numbers.
 *
 * 3. A u256 is returned as TWO felts, [low, high]. Reading only low works for
 *    every balance below 2^128, which is every balance anyone will see in
 *    testing, and silently truncates above it. See u256ToBigInt.
 *
 * PUBLIC ENDPOINT AVAILABILITY IS POOR. Checked 26 September 2026:
 *   starknet-mainnet.public.blastapi.io   discontinued, redirects to Alchemy
 *   rpc.starknet.lava.build               discontinued
 *   starknet.drpc.org                     paid plan required
 *   free-rpc.nethermind.io/mainnet-juno   empty response
 *   api.cartridge.gg/x/starknet/mainnet   works
 * A configured provider is not optional here the way it nearly is on EVM.
 */

import type { WalletChain } from '../types/wallet.types.js';

/**
 * Public endpoints, used only when nothing is configured.
 *
 * Rate limited and NOT suitable for production traffic. Present so a
 * misconfigured deployment degrades to "balance unavailable" instead of
 * failing outright. Never the intended path.
 */
const PUBLIC_ENDPOINTS: { mainnet: string[]; testnet: string[] } = {
  mainnet: ['https://api.cartridge.gg/x/starknet/mainnet'],
  testnet: ['https://api.cartridge.gg/x/starknet/sepolia'],
};

/** Chain ids as returned by starknet_chainId, before decoding. */
export const STARKNET_CHAIN_ID_HEX = {
  mainnet: '0x534e5f4d41494e',
  testnet: '0x534e5f5345504f4c4941',
} as const;

/** Decoded short-string form, which is what CAIP-2 uses. */
export const STARKNET_CHAIN_ID = {
  mainnet: 'SN_MAIN',
  testnet: 'SN_SEPOLIA',
} as const;

/**
 * Decode a felt-encoded ASCII short string.
 *
 * Starknet packs short strings into a single felt as big-endian ASCII, so
 * 0x534e5f4d41494e is literally the bytes "SN_MAIN". This is the only correct
 * way to compare a Starknet chain id; Number() on it produces a large integer
 * that is not wrong so much as meaningless.
 */
export function decodeShortString(hex: string): string {
  const body = String(hex).replace(/^0x/, '');
  const padded = body.length % 2 ? '0' + body : body;
  return Buffer.from(padded, 'hex').toString('ascii').replace(/\0/g, '');
}

/**
 * Reassemble a u256 returned as two felts.
 *
 * Starknet has no native 256 bit integer, so ERC-20 balances come back as
 * [low, high] where the value is high * 2^128 + low.
 *
 * THIS IS THE SILENT ONE. Reading result[0] alone is correct for every value
 * below 2^128 and wrong above it, with no error. Since no test balance will
 * ever exceed 2^128, a truncating implementation passes the entire suite and
 * fails only in production on a large holder.
 */
export function u256ToBigInt(parts: readonly string[]): bigint {
  if (!Array.isArray(parts) || parts.length < 2) {
    throw new Error(
      `Expected a u256 as [low, high], got ${JSON.stringify(parts)}. ` +
        'Reading only the low felt silently truncates balances above 2^128.'
    );
  }
  const low = BigInt(parts[0]);
  const high = BigInt(parts[1]);
  return (high << 128n) + low;
}

export interface StarknetRpcOptions {
  /** Mainnet when true, testnet otherwise. Passed in, never inferred here. */
  production?: boolean;
  /** Per-attempt timeout. A slow RPC must not hold a page load open. */
  timeoutMs?: number;
}

/**
 * Endpoint tiers, configured first.
 *
 * No hardcoded production URL: STARKNET_RPC_URL and its fallback come from the
 * environment, and the public tier exists only so a misconfigured deployment
 * degrades rather than dies.
 */
export function starknetRpcEndpoints(options: StarknetRpcOptions = {}): string[] {
  const production = options.production ?? true;

  const configured = (process.env.STARKNET_RPC_URL || '').trim();
  const secondary = (process.env.STARKNET_RPC_FALLBACK_URL || '').trim();
  const publicTier = production ? PUBLIC_ENDPOINTS.mainnet : PUBLIC_ENDPOINTS.testnet;

  return [...new Set([configured, secondary, ...publicTier].filter(Boolean))];
}

/** Does this JSON-RPC error describe the endpoint rather than the chain? */
function isEndpointLevelRpcError(error: any): boolean {
  const code = Number(error?.code);
  if ([401, 403, 429, -32005, -32011].includes(code)) return true;
  return /must be authenticated|unauthorized|forbidden|invalid api key|quota|rate ?limit|too many requests|exceeded|over capacity|service unavailable|no longer available|discontinued|upgrade to paid/i.test(
    String(error?.message ?? '')
  );
}

/**
 * One Starknet JSON-RPC call, walking the tiers until one answers.
 *
 * A chain-level error is a real answer and is surfaced, not retried on the
 * next endpoint. Transport failures and endpoint-level errors do move on.
 */
export async function starknetRpc<T = unknown>(
  method: string,
  params: unknown,
  options: StarknetRpcOptions = {}
): Promise<T> {
  const endpoints = starknetRpcEndpoints(options);
  if (endpoints.length === 0) {
    throw new Error('No Starknet RPC endpoint is configured or known.');
  }

  const timeoutMs = options.timeoutMs ?? 8_000;
  let lastError: Error | undefined;

  for (const endpoint of endpoints) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`Starknet RPC ${endpoint} returned HTTP ${response.status}`);
        continue;
      }

      const body: any = await response.json();

      if (body?.error) {
        const detail = body.error?.message ?? JSON.stringify(body.error);
        if (isEndpointLevelRpcError(body.error)) {
          lastError = new Error(`Starknet RPC ${endpoint} rejected the call: ${detail}`);
          continue;
        }
        throw new Error(`Starknet RPC ${method}: ${detail}`);
      }

      return body?.result as T;
    } catch (error: any) {
      if (String(error?.message ?? '').startsWith(`Starknet RPC ${method}:`)) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error(
    `Every Starknet RPC endpoint failed (${endpoints.length} tried). ` +
      `Last error: ${lastError?.message ?? 'unknown'}`
  );
}

/** The chain id this endpoint actually serves, decoded to SN_MAIN or SN_SEPOLIA. */
export async function starknetChainId(options: StarknetRpcOptions = {}): Promise<string> {
  const raw = await starknetRpc<string>('starknet_chainId', [], options);
  return decodeShortString(raw);
}

/**
 * Read an ERC-20 balance, as a decimal string.
 *
 * Note the selector is passed in rather than computed: Starknet entry point
 * selectors are starknet_keccak of the function name, which needs a Cairo-aware
 * hash. Hardcoding the two we use avoids pulling a dependency into the read
 * path, and both are asserted against the live chain in the test suite.
 */
export const SELECTOR = {
  /** starknet_keccak("balanceOf") */
  balanceOf: '0x2e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e',
  /** starknet_keccak("symbol") */
  symbol: '0x216b05c387bab9ac31918a3e61672f4618601f3c598a2f3f2710f37053e1ea4',
  /** starknet_keccak("decimals") */
  decimals: '0x4c4fb1ab068f6039d5780c68dd0fa2f8742cceb3426d19667778ca7f3518a9',
} as const;

export async function starknetCall(
  contractAddress: string,
  selector: string,
  calldata: string[] = [],
  options: StarknetRpcOptions = {}
): Promise<string[]> {
  return starknetRpc<string[]>(
    'starknet_call',
    [{ contract_address: contractAddress, entry_point_selector: selector, calldata }, 'latest'],
    options
  );
}

/**
 * Format a base-unit integer as a decimal string.
 *
 * String arithmetic on purpose, matching fromBaseUnits in evm-rpc.ts.
 * Number(raw) / 10 ** decimals loses precision above 2^53.
 */
export function fromBaseUnits(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * ERC-20 balanceOf on Starknet, as a decimal string.
 *
 * Returns the reassembled u256, never just the low felt.
 */
export async function starknetErc20Balance(
  tokenAddress: string,
  holderAddress: string,
  decimals: number,
  options: StarknetRpcOptions = {}
): Promise<string> {
  const result = await starknetCall(tokenAddress, SELECTOR.balanceOf, [holderAddress], options);
  if (!result || result.length === 0) {
    throw new Error(
      `balanceOf returned no data for ${tokenAddress} on Starknet. ` +
        'The token may not be deployed at that address on this network.'
    );
  }
  return fromBaseUnits(u256ToBigInt(result), decimals);
}

/**
 * Is an account contract actually deployed at this address?
 *
 * On Starknet an account IS a contract, and a brand new user has a
 * counterfactual address with no class hash at it. That account cannot
 * transact until a DEPLOY_ACCOUNT lands, and it cannot pay for its own
 * deployment because it holds nothing. This is the one case where sponsorship
 * is mandatory rather than an optimisation, and no other chain Sivan supports
 * has this state at all.
 */
export async function isAccountDeployed(
  address: string,
  options: StarknetRpcOptions = {}
): Promise<boolean> {
  try {
    const classHash = await starknetRpc<string>(
      'starknet_getClassHashAt',
      ['latest', address],
      options
    );
    return Boolean(classHash) && classHash !== '0x0';
  } catch (error: any) {
    // "Contract not found" is a definitive NO, not a transport failure.
    if (/contract not found|is not deployed/i.test(String(error?.message ?? ''))) return false;
    throw error;
  }
}
