import { env } from '../../config/env.js';

export function getNearRpcUrls(production?: boolean): string[] {
  if (production) {
    const list = [
      process.env.NEAR_MAINNET_RPC_URL,
      process.env.NEAR_RPC_URL,
      'https://free.rpc.fastnear.com',
      'https://rpc.mainnet.near.org',
    ].filter(Boolean) as string[];
    return list;
  }
  const testList = [
    process.env.NEAR_TESTNET_RPC_URL,
    'https://test.rpc.fastnear.com',
    'https://rpc.testnet.near.org',
  ].filter(Boolean) as string[];
  return testList;
}

export function getNearRpcUrl(production?: boolean): string {
  return getNearRpcUrls(production)[0];
}

export const NEAR_CIRCLE_USDC_TESTNET = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
export const NEAR_FAKES_USDC_TESTNET = 'usdc.fakes.testnet';

export function getNearUsdcContract(production?: boolean): string {
  if (production) {
    // Official native Circle USDC contract on NEAR Mainnet
    return process.env.NEAR_USDC_CONTRACT || '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
  }
  // Official Circle native USDC contract on NEAR Testnet
  return process.env.NEAR_TESTNET_USDC_CONTRACT || NEAR_CIRCLE_USDC_TESTNET;
}

export const NEAR_BRIDGED_USDC_MAINNET = 'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near';

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
 * Executes a JSON-RPC query against NEAR Protocol RPC with multi-endpoint fallback.
 */
async function queryNearRpc<T>(method: string, params: Record<string, any>, production?: boolean): Promise<T | null> {
  const candidateUrls = getNearRpcUrls(production);

  for (const url of candidateUrls) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1200);

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
        continue;
      }

      const data = (await res.json()) as NearRpcResponse<T>;
      if (data.error) {
        const errName = data.error.cause?.name || data.error.name || '';
        // UNKNOWN_ACCOUNT is expected for fresh un-funded addresses on NEAR
        if (errName === 'UNKNOWN_ACCOUNT' || errName.includes('does not exist')) {
          return null;
        }
        continue;
      }

      return data.result ?? null;
    } catch {
      clearTimeout(timeoutId);
      continue;
    }
  }

  return null;
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
 * Supports both native Circle USDC and bridged USDC.e on NEAR mainnet,
 * and resiliently inspects mainnet if testnet returns zero.
 */
export async function readNearBalances(
  accountId: string,
  production?: boolean
): Promise<{ near: string; usdc: string }> {
  const usdcContract = getNearUsdcContract(production);

  if (production) {
    const [near, nativeUsdc, bridgedUsdc] = await Promise.all([
      fetchNearNativeBalance(accountId, true),
      fetchNearTokenBalance(accountId, usdcContract, 6, true),
      fetchNearTokenBalance(accountId, NEAR_BRIDGED_USDC_MAINNET, 6, true),
    ]);

    const totalUsdc = (Number(nativeUsdc) + Number(bridgedUsdc)).toFixed(6);
    return { near, usdc: totalUsdc };
  }

  // On staging / testnet mode: query testnet Circle USDC and Fakes USDC in parallel
  const [near, circleUsdc, fakesUsdc] = await Promise.all([
    fetchNearNativeBalance(accountId, false),
    fetchNearTokenBalance(accountId, NEAR_CIRCLE_USDC_TESTNET, 6, false),
    fetchNearTokenBalance(accountId, NEAR_FAKES_USDC_TESTNET, 6, false),
  ]);

  const testnetTotalUsdc = (Number(circleUsdc) + Number(fakesUsdc)).toFixed(6);

  // If user deposited real USDC on Mainnet while testing in staging,
  // check Mainnet FastNear so real deposited funds are never ignored or marked unavailable
  if (Number(testnetTotalUsdc) === 0 && Number(near) === 0) {
    try {
      const [mainNear, mainNativeUsdc, mainBridgedUsdc] = await Promise.all([
        fetchNearNativeBalance(accountId, true),
        fetchNearTokenBalance(accountId, getNearUsdcContract(true), 6, true),
        fetchNearTokenBalance(accountId, NEAR_BRIDGED_USDC_MAINNET, 6, true),
      ]);
      const mainTotalUsdc = (Number(mainNativeUsdc) + Number(mainBridgedUsdc)).toFixed(6);
      if (Number(mainTotalUsdc) > 0 || Number(mainNear) > 0) {
        return { near: mainNear, usdc: mainTotalUsdc };
      }
    } catch {
      // Return testnet zeros safely on fallback error
    }
  }

  return { near, usdc: testnetTotalUsdc };
}
