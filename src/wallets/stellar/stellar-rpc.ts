import { env } from '../../config/env.js';
import { resolveNetworkMode } from '../network-mode.js';

/**
 * Stellar Horizon and Soroban RPC Clients.
 *
 * Provides resilient, provider-tiered access to Stellar network state.
 */

const HORIZON_MAINNET = 'https://horizon.stellar.org';
const HORIZON_TESTNET = 'https://horizon-testnet.stellar.org';

const SOROBAN_MAINNET = 'https://mainnet.sorobanrpc.com';
const SOROBAN_TESTNET = 'https://soroban-testnet.stellar.org';

export interface StellarAccountBalance {
  asset_type: 'native' | 'credit_alphanum4' | 'credit_alphanum12';
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  limit?: string;
}

export interface StellarAccountResponse {
  id: string;
  account_id: string;
  sequence: string;
  balances: StellarAccountBalance[];
}

export const HORIZON_PUBLIC_MAINNET = [
  'https://horizon.stellar.org',
];

export const HORIZON_PUBLIC_TESTNET = [
  'https://horizon-testnet.stellar.org',
];

export interface StellarRpcOptions {
  production?: boolean;
  timeoutMs?: number;
}

export function horizonEndpoints(options?: StellarRpcOptions): string[] {
  const isProd = typeof options?.production === 'boolean' ? options.production : resolveNetworkMode() === 'mainnet';
  const custom = (process.env.STELLAR_HORIZON_URL || '').trim();
  const defaults = isProd ? HORIZON_PUBLIC_MAINNET : HORIZON_PUBLIC_TESTNET;
  return [...new Set([custom, ...defaults].filter(Boolean))];
}

export function horizonEndpoint(options?: StellarRpcOptions): string {
  return horizonEndpoints(options)[0];
}

export function sorobanEndpoint(options?: StellarRpcOptions): string {
  const isProd = typeof options?.production === 'boolean' ? options.production : resolveNetworkMode() === 'mainnet';
  return (process.env.STELLAR_SOROBAN_RPC_URL || '').trim() || (isProd ? SOROBAN_MAINNET : SOROBAN_TESTNET);
}

export async function fetchStellarAccount(accountId: string, options?: StellarRpcOptions): Promise<StellarAccountResponse | null> {
  const endpoints = horizonEndpoints(options);
  let lastError: Error | null = null;

  for (const base of endpoints) {
    const url = `${base}/accounts/${accountId}`;
    const controller = new AbortController();
    const timeout = options?.timeoutMs ?? 8000;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`Stellar Horizon ${base} returned HTTP ${res.status}`);
      }
      return (await res.json()) as StellarAccountResponse;
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));
      continue;
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastError) {
    console.warn(`[stellar_rpc.fetch_account_warning] All Horizon endpoints failed for ${accountId}:`, lastError.message);
  }
  return null;
}

export async function readStellarUsdcBalance(accountId: string, options?: StellarRpcOptions): Promise<number> {
  const account = await fetchStellarAccount(accountId, options);
  if (!account) return 0;

  const usdcEntry = account.balances.find(
    (b) => (b.asset_code === 'USDC' || b.asset_code === 'usdc') && b.asset_type !== 'native'
  );

  return usdcEntry ? parseFloat(usdcEntry.balance) : 0;
}

export async function readStellarUsdtBalance(accountId: string, options?: StellarRpcOptions): Promise<number> {
  const account = await fetchStellarAccount(accountId, options);
  if (!account) return 0;

  const usdtEntry = account.balances.find(
    (b) => (b.asset_code === 'USDT' || b.asset_code === 'usdt') && b.asset_type !== 'native'
  );

  return usdtEntry ? parseFloat(usdtEntry.balance) : 0;
}

export async function readStellarTokenBalances(accountId: string, options?: StellarRpcOptions): Promise<{ usdc: number; usdt: number; xlm: number }> {
  const account = await fetchStellarAccount(accountId, options);
  if (!account) return { usdc: 0, usdt: 0, xlm: 0 };

  const usdcEntry = account.balances.find(
    (b) => (b.asset_code === 'USDC' || b.asset_code === 'usdc') && b.asset_type !== 'native'
  );
  const usdtEntry = account.balances.find(
    (b) => (b.asset_code === 'USDT' || b.asset_code === 'usdt') && b.asset_type !== 'native'
  );
  const xlmEntry = account.balances.find((b) => b.asset_type === 'native');

  return {
    usdc: usdcEntry ? parseFloat(usdcEntry.balance) : 0,
    usdt: usdtEntry ? parseFloat(usdtEntry.balance) : 0,
    xlm: xlmEntry ? parseFloat(xlmEntry.balance) : 0,
  };
}

export async function isStellarHorizonHealthy(options?: StellarRpcOptions): Promise<boolean> {
  const base = horizonEndpoint(options);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${base}/`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}
