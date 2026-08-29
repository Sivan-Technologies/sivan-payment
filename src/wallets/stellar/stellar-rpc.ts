import { env } from '../../config/env.js';

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

export function horizonEndpoint(): string {
  const isProd = env.APP_ENV === 'production';
  return (process.env.STELLAR_HORIZON_URL || '').trim() || (isProd ? HORIZON_MAINNET : HORIZON_TESTNET);
}

export function sorobanEndpoint(): string {
  const isProd = env.APP_ENV === 'production';
  return (process.env.STELLAR_SOROBAN_RPC_URL || '').trim() || (isProd ? SOROBAN_MAINNET : SOROBAN_TESTNET);
}

export async function fetchStellarAccount(accountId: string): Promise<StellarAccountResponse | null> {
  const base = horizonEndpoint();
  const url = `${base}/accounts/${accountId}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Stellar Horizon returned HTTP ${res.status}`);
    }
    return (await res.json()) as StellarAccountResponse;
  } finally {
    clearTimeout(timer);
  }
}

export async function readStellarUsdcBalance(accountId: string): Promise<number> {
  const account = await fetchStellarAccount(accountId);
  if (!account) return 0;

  const usdcEntry = account.balances.find(
    (b) => (b.asset_code === 'USDC' || b.asset_code === 'usdc') && b.asset_type !== 'native'
  );

  return usdcEntry ? parseFloat(usdcEntry.balance) : 0;
}

export async function isStellarHorizonHealthy(): Promise<boolean> {
  const base = horizonEndpoint();
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
