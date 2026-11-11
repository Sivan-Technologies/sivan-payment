import { env } from '../../config/env.js';

export function getNearRpcUrl(production?: boolean): string {
  if (production) {
    return process.env.NEAR_MAINNET_RPC_URL || process.env.NEAR_RPC_URL || 'https://rpc.mainnet.near.org';
  }
  return process.env.NEAR_TESTNET_RPC_URL || 'https://rpc.testnet.near.org';
}

export function getNearUsdcContract(production?: boolean): string {
  if (production) {
    // Official native Circle USDC contract on NEAR Mainnet
    return process.env.NEAR_USDC_CONTRACT || '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
  }
  // Standard testnet NEP-141 USDC contract
  return process.env.NEAR_TESTNET_USDC_CONTRACT || 'usdc.fakes.testnet';
}

interface NearRpcResponse<T = any> {
  jsonrpc: string;
  id: string;
  result?: T;
  error?: {
    name?: string;
    cause?: {
      name?: string;
      info?: any;
    };
    message?: string;
  };
}

/**
 * Executes a JSON-RPC query against NEAR Protocol RPC.
 */
async function queryNearRpc<T>(method: string, params: Record<string, any>, production?: boolean): Promise<T | null> {
  const url = getNearRpcUrl(production);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `sivan_near_${Date.now()}`,
        method,
        params,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn(`[near-rpc] HTTP error ${res.status} from ${url}`);
      return null;
    }

    const data = (await res.json()) as NearRpcResponse<T>;
    if (data.error) {
      const errName = data.error.cause?.name || data.error.name || '';
      // UNKNOWN_ACCOUNT is expected for fresh un-funded addresses on NEAR
      if (errName === 'UNKNOWN_ACCOUNT' || errName.includes('does not exist')) {
        return null;
      }
      console.warn(`[near-rpc] RPC error: ${JSON.stringify(data.error)}`);
      return null;
    }

    return data.result ?? null;
  } catch (err: any) {
    clearTimeout(timeoutId);
    console.warn(`[near-rpc] Query failed for ${method}:`, err?.message || err);
    return null;
  }
}

/**
 * Fetches native NEAR balance in human-readable units (e.g. "1.500000").
 * Converts from yoctoNEAR (10^24).
 */
export async function fetchNearNativeBalance(accountId: string, production?: boolean): Promise<string> {
  try {
    const result = await queryNearRpc<{ amount: string }>(
      'query',
      {
        request_type: 'view_account',
        finality: 'final',
        account_id: accountId,
      },
      production
    );

    if (!result || !result.amount) {
      return '0.000000';
    }

    // Convert yoctoNEAR string (10^24) using BigInt to avoid float overflow
    const yoctoStr = result.amount;
    const pad = 24;
    const padded = yoctoStr.padStart(pad + 1, '0');
    const whole = padded.slice(0, padded.length - pad) || '0';
    const fraction = padded.slice(padded.length - pad, padded.length - pad + 6);
    return `${whole}.${fraction}`;
  } catch {
    return '0.000000';
  }
}

/**
 * Fetches NEP-141 token balance (e.g. USDC, 6 decimals) on NEAR Protocol.
 */
export async function fetchNearTokenBalance(
  accountId: string,
  contractId: string,
  decimals = 6,
  production?: boolean
): Promise<string> {
  try {
    const argsBase64 = Buffer.from(JSON.stringify({ account_id: accountId })).toString('base64');
    const result = await queryNearRpc<{ result: number[] }>(
      'query',
      {
        request_type: 'call_function',
        finality: 'final',
        account_id: contractId,
        method_name: 'ft_balance_of',
        args_base64: argsBase64,
      },
      production
    );

    if (!result || !Array.isArray(result.result)) {
      return '0.000000';
    }

    // The result is bytes representing JSON string (e.g. "15000000")
    const rawStr = Buffer.from(result.result).toString('utf8').replace(/"/g, '').trim();
    if (!rawStr || !/^\d+$/.test(rawStr)) {
      return '0.000000';
    }

    const padded = rawStr.padStart(decimals + 1, '0');
    const whole = padded.slice(0, padded.length - decimals) || '0';
    const fraction = padded.slice(padded.length - decimals, padded.length - decimals + 6);
    return `${whole}.${fraction}`;
  } catch {
    return '0.000000';
  }
}

/**
 * Reads both native NEAR and NEP-141 USDC balances for an account.
 */
export async function readNearBalances(
  accountId: string,
  production?: boolean
): Promise<{ near: string; usdc: string }> {
  const usdcContract = getNearUsdcContract(production);
  const [near, usdc] = await Promise.all([
    fetchNearNativeBalance(accountId, production),
    fetchNearTokenBalance(accountId, usdcContract, 6, production),
  ]);

  return { near, usdc };
}
