/**
 * EVM JSON-RPC, for READING chain state.
 *
 * Privy signs but does not read. It is a key manager, not an indexer, so any
 * question about what is actually AT an address - a token balance, in practice
 * - has to be asked of a node directly.
 *
 * Deliberately hand-rolled rather than pulling in ethers or viem. This makes
 * exactly one call, eth_call against ERC-20 balanceOf, and a dependency that
 * ships a full wallet/provider/signer stack to answer one question is a large
 * surface for no gain. The equivalent Solana layer (solana/solana-rpc.ts) is
 * built the same way, so the two read paths look alike.
 *
 * The tiering, timeout and failover semantics below are copied from that file
 * on purpose: an operator who has learned one has learned both.
 */

import { env } from '../../config/env.js';
import type { WalletChain } from '../types/wallet.types.js';

/**
 * Public endpoints, used only when nothing is configured.
 *
 * These are rate-limited and are NOT suitable for production traffic. They are
 * here so a misconfigured deployment degrades - a balance that reads
 * "unavailable" - instead of failing outright. Never the intended path.
 */
const PUBLIC_ENDPOINTS: Record<string, { mainnet: string[]; testnet: string[] }> = {
  ethereum: {
    mainnet: [
      'https://ethereum-rpc.publicnode.com',
      'https://eth.drpc.org',
      'https://1rpc.io/eth',
      'https://eth.llamarpc.com',
    ],
    testnet: ['https://ethereum-sepolia-rpc.publicnode.com'],
  },
  base: {
    mainnet: [
      'https://mainnet.base.org',
      'https://base-rpc.publicnode.com',
      'https://base.drpc.org',
      'https://1rpc.io/base',
    ],
    testnet: ['https://sepolia.base.org'],
  },
  celo: {
    mainnet: [
      'https://forno.celo.org',
      'https://celo.drpc.org',
      'https://1rpc.io/celo',
    ],
    testnet: [
      'https://forno.celo.org',
      'https://celo.drpc.org',
      'https://1rpc.io/celo',
    ],
  },
  bsc: {
    mainnet: [
      'https://bsc-dataseed.binance.org',
      'https://bsc.drpc.org',
      'https://1rpc.io/bnb',
    ],
    testnet: ['https://data-seed-prebsc-1-s1.binance.org:8545'],
  },
  bnb: {
    mainnet: [
      'https://bsc-dataseed.binance.org',
      'https://bsc.drpc.org',
      'https://1rpc.io/bnb',
    ],
    testnet: ['https://data-seed-prebsc-1-s1.binance.org:8545'],
  },
};

export interface EvmRpcOptions {
  /** Mainnet when true, testnet otherwise. Passed in, never inferred here. */
  production?: boolean;
  /** Per-attempt timeout. A slow RPC must not hold a page load open. */
  timeoutMs?: number;
}

export function evmRpcEndpoints(chain: WalletChain, options: EvmRpcOptions = {}): string[] {
  const production = options.production ?? true;

  let configured = '';
  let secondary = '';

  if (chain === 'base') {
    configured = env.BASE_RPC_URL || '';
    secondary = env.BASE_RPC_FALLBACK_URL || '';
  } else if (chain === 'celo') {
    configured = process.env.CELO_RPC_URL || '';
    secondary = process.env.CELO_RPC_FALLBACK_URL || '';
  } else if (chain === 'bsc' || chain === 'bnb') {
    configured = process.env.BSC_RPC_URL || '';
    secondary = process.env.BSC_RPC_FALLBACK_URL || '';
  } else {
    configured = env.ETHEREUM_RPC_URL || '';
    secondary = env.ETHEREUM_RPC_FALLBACK_URL || '';
  }

  const fallback = PUBLIC_ENDPOINTS[chain];
  const publicEndpoints = fallback ? (production ? fallback.mainnet : fallback.testnet) : [];

  const ordered = [configured, secondary, ...publicEndpoints]
    .map((url) => (url ?? '').trim())
    .filter(Boolean);

  return [...new Set(ordered)];
}

/**
 * Is a JSON-RPC error body the endpoint's problem, not the chain's answer?
 *
 * Alchemy reports a bad key, an exhausted quota and a throttle as a JSON-RPC
 * error with HTTP *200* - not as a 401/429 status - so the status check above
 * never sees them. Those describe one provider, and the next tier can answer
 * the same question fine. A chain-level error ("execution reverted") is a real
 * answer and must still not be retried.
 */
function isEndpointLevelRpcError(error: any): boolean {
  const code = Number(error?.code);
  // -32005 exceeded limit, -32011/-32603 provider-internal.
  if ([401, 403, 429, -32005, -32011].includes(code)) return true;

  return /must be authenticated|unauthorized|forbidden|invalid api key|invalid key|quota|rate ?limit|too many requests|exceeded|over capacity|service unavailable|unknown network|unsupported network|not supported|bad gateway|free plan|paid plan/i.test(
    String(error?.message ?? '')
  );
}

/**
 * One JSON-RPC call, walking the tiers until one answers.
 *
 * A chain-level JSON-RPC error is NOT retried on the next endpoint - it is a
 * real answer, and asking a second provider the same question returns the same
 * reply a round trip later. Transport failures (timeout, 5xx, rate limit) and
 * endpoint-level errors (bad key, exhausted quota) do move on to the next tier.
 */

export async function evmRpc<T = unknown>(
  chain: WalletChain,
  method: string,
  params: unknown[],
  options: EvmRpcOptions = {}
): Promise<T> {
  const endpoints = evmRpcEndpoints(chain, options);
  if (endpoints.length === 0) {
    throw new Error(`No EVM RPC endpoint is configured or known for ${chain}.`);
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

      // The public endpoints' failure modes under load, and exactly what a
      // configured provider exists to absorb.
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`EVM RPC ${endpoint} returned HTTP ${response.status}`);
        continue;
      }

      const body: any = await response.json();

      if (body?.error) {
        const detail = body.error?.message ?? JSON.stringify(body.error);

        // A bad key or an exhausted quota describes THIS endpoint, so the next
        // tier gets a turn. Arrives as HTTP 200, hence the check down here.
        if (isEndpointLevelRpcError(body.error)) {
          lastError = new Error(`EVM RPC ${endpoint} rejected the call: ${detail}`);
          continue;
        }

        // A definitive answer from the node. Surfaced, not retried.
        throw new Error(`EVM RPC ${method}: ${detail}`);
      }


      return body?.result as T;
    } catch (error: any) {
      if (String(error?.message ?? '').startsWith(`EVM RPC ${method}:`)) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error(
    `Every EVM RPC endpoint for ${chain} failed (${endpoints.length} tried). ` +
      `Last error: ${lastError?.message ?? 'unknown'}`
  );
}

/**
 * Format a base-unit integer as a decimal string.
 *
 * String arithmetic on purpose. `Number(raw) / 10 ** decimals` loses precision
 * above 2^53 and reintroduces the float drift that WalletBalance.amount being a
 * string exists to avoid.
 */
export function fromBaseUnits(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, '0');

  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');

  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * ERC-20 balanceOf(address), as a decimal string.
 *
 * Selector 0x70a08231, then the holder left-padded to 32 bytes.
 *
 * A zero-length or 0x result means the call reached a node but the contract
 * returned nothing - a wrong contract address, or a chain where that token is
 * not deployed. That is NOT a zero balance, and reporting it as one is the
 * exact confusion this whole change set exists to remove, so it throws.
 */
export async function erc20BalanceOf(
  chain: WalletChain,
  tokenAddress: string,
  holderAddress: string,
  decimals: number,
  options: EvmRpcOptions = {}
): Promise<string> {
  const holder = holderAddress.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(holder)) {
    throw new Error(`Invalid holder address: ${holderAddress}`);
  }

  const data = '0x70a08231' + holder.slice(2).padStart(64, '0');

  const result = await evmRpc<string>(
    chain,
    'eth_call',
    [{ to: tokenAddress, data }, 'latest'],
    options
  );

  if (!result || result === '0x') {
    throw new Error(
      `balanceOf returned no data for ${tokenAddress} on ${chain}. ` +
        'The token may not be deployed at that address on this network.'
    );
  }

  return fromBaseUnits(BigInt(result), decimals);
}
