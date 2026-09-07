import { env } from '../../config/env.js';
import { resolveNetworkMode } from '../network-mode.js';

/**
 * Celo EVM JSON-RPC & Token Contracts.
 *
 * Celo Mainnet: Chain ID 42220 (RPC: https://forno.celo.org)
 * Celo Alfajores Testnet: Chain ID 44787 (RPC: https://alfajores-forno.celo-testnet.org)
 */

export const CELO_USDC_MAINNET = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C';
export const CELO_USDC_SEPOLIA = '0x01C5C0122039549AD1493B8220cABEdD739BC44E';
export const CELO_CUSD_MAINNET = '0x765DE816845861e75A25fCA122bb6898B8B1282a';
export const CELO_CUSD_SEPOLIA = '0x874069Fa1Eb16D44d622F2e0Ca25eeA172369bC1';
export const CELO_CUSD_ALFAJORES = CELO_CUSD_SEPOLIA;

const PUBLIC_MAINNET_ENDPOINTS = [
  'https://forno.celo.org',
  'https://celo.drpc.org',
  'https://1rpc.io/celo',
];

const PUBLIC_TESTNET_ENDPOINTS = [
  'https://forno.celo-sepolia.celo-testnet.org',
  'https://celo-sepolia.drpc.org',
  'https://sepolia-rpc.celo.org',
];

export function celoRpcEndpoints(options?: { production?: boolean }): string[] {
  const isProd = typeof options?.production === 'boolean' ? options.production : resolveNetworkMode() === 'mainnet';
  const custom = (process.env.CELO_RPC_URL || '').trim();
  const fallback = (process.env.CELO_RPC_FALLBACK_URL || '').trim();
  const defaults = isProd ? PUBLIC_MAINNET_ENDPOINTS : PUBLIC_TESTNET_ENDPOINTS;

  const ordered = [custom, fallback, ...defaults].filter(Boolean);
  return [...new Set(ordered)];
}

export async function celoRpc<T = unknown>(method: string, params: unknown[], options?: { production?: boolean }): Promise<T> {
  const endpoints = celoRpcEndpoints(options);
  let lastError: Error | undefined;

  for (const endpoint of endpoints) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);

      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        lastError = new Error(`Celo RPC ${endpoint} returned HTTP ${res.status}`);
        continue;
      }

      const body: any = await res.json();
      if (body?.error) {
        lastError = new Error(`Celo RPC ${endpoint} error: ${body.error.message}`);
        continue;
      }

      return body.result as T;
    } catch (err: any) {
      lastError = err;
    }
  }

  throw lastError || new Error('All Celo RPC endpoints failed');
}

export async function isCeloHealthy(): Promise<boolean> {
  try {
    const blockNumber = await celoRpc<string>('eth_blockNumber', []);
    return typeof blockNumber === 'string' && blockNumber.startsWith('0x');
  } catch {
    return false;
  }
}
