import { env } from '../../config/env.js';

/**
 * Solana chain reads, with a fallback endpoint.
 *
 * WHY THIS EXISTS
 *
 * Privy signs and broadcasts; it does not read chain state. One question it
 * therefore cannot answer decides whether an SPL transfer works at all: does
 * the recipient already hold a token account for this mint? Send USDC to an
 * address with no associated token account and the transfer fails - and on the
 * wrong construction it can land somewhere nobody can spend from.
 *
 * So an RPC is not a redundancy layer bolted onto Privy. It is a component
 * Sivan needs regardless, and Privy has no equivalent.
 *
 * TIERS, IN ORDER
 *
 *   1. SOLANA_RPC_URL           a paid provider, e.g. Alchemy
 *   2. SOLANA_RPC_FALLBACK_URL  a second provider, different vendor ideally
 *   3. api.mainnet-beta.solana.com
 *
 * The public endpoint is last on purpose. It answers in ~0.16s when idle and
 * is rate-limited under load, which is exactly when a payout queue would need
 * it. It is here so a misconfigured deployment degrades instead of failing,
 * never as the intended path.
 */

const PUBLIC_MAINNET = 'https://api.mainnet-beta.solana.com';
const PUBLIC_DEVNET = 'https://api.devnet.solana.com';

export interface SolanaRpcOptions {
  /** Devnet in every non-production environment. */
  production?: boolean;
  /** Per-attempt timeout. A slow RPC must not hold a payout open. */
  timeoutMs?: number;
}

/**
 * Endpoints to try, in order, with duplicates removed.
 *
 * Configuring the same URL as both primary and fallback is a plausible
 * copy-paste error, and retrying an identical endpoint doubles the latency of
 * a failure while adding no resilience.
 */
export function solanaRpcEndpoints(options: SolanaRpcOptions = {}): string[] {
  const production = options.production ?? env.APP_ENV === 'production';
  const publicEndpoint = production ? PUBLIC_MAINNET : PUBLIC_DEVNET;

  const ordered = [env.SOLANA_RPC_URL, env.SOLANA_RPC_FALLBACK_URL, publicEndpoint]
    .map((url) => (url ?? '').trim())
    .filter(Boolean);

  return [...new Set(ordered)];
}

export interface SolanaRpcResult<T> {
  result: T;
  /** Which endpoint answered, so a silent fallback is visible in logs. */
  endpoint: string;
  /** True when a configured provider failed and a later tier answered. */
  usedFallback: boolean;
}

/**
 * One JSON-RPC call, walking the tiers until one answers.
 *
 * A JSON-RPC *error* is NOT retried on the next endpoint: "account not found"
 * is a real answer, and asking a second provider the same question wastes a
 * round trip to get the same reply. Only transport failures - timeout, 5xx,
 * rate limit - move to the next tier.
 */
export async function solanaRpc<T = unknown>(
  method: string,
  params: unknown[],
  options: SolanaRpcOptions = {}
): Promise<SolanaRpcResult<T>> {
  const endpoints = solanaRpcEndpoints(options);
  const timeoutMs = options.timeoutMs ?? 8_000;

  let lastError: Error | undefined;

  for (let index = 0; index < endpoints.length; index += 1) {
    const endpoint = endpoints[index]!;

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

      // 429 and 5xx are the public endpoint's failure modes under load, and
      // exactly what a second provider exists to absorb.
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`Solana RPC ${endpoint} returned HTTP ${response.status}`);
        continue;
      }

      const body: any = await response.json();

      if (body?.error) {
        // A definitive answer from the chain. Surfaced, not retried.
        throw new Error(`Solana RPC ${method}: ${body.error?.message ?? JSON.stringify(body.error)}`);
      }

      return { result: body?.result as T, endpoint, usedFallback: index > 0 };
    } catch (error: any) {
      // A thrown JSON-RPC error must propagate rather than trigger failover.
      if (String(error?.message ?? '').startsWith(`Solana RPC ${method}:`)) throw error;

      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error(
    `Every Solana RPC endpoint failed (${endpoints.length} tried). Last error: ${lastError?.message ?? 'unknown'}`
  );
}

/**
 * Does this account exist on chain?
 *
 * The question behind the ATA check. `null` from getAccountInfo means the
 * address has never been created - for a token account that means an SPL
 * transfer to it will fail.
 */
export async function accountExists(address: string, options: SolanaRpcOptions = {}): Promise<boolean> {
  const { result } = await solanaRpc<{ value: unknown } | null>(
    'getAccountInfo',
    [address, { encoding: 'base64' }],
    options
  );
  return (result as any)?.value != null;
}

/** Health probe, for an admin panel that should show the rail is reachable. */
export async function solanaRpcHealth(options: SolanaRpcOptions = {}) {
  const started = Date.now();
  try {
    const { endpoint, usedFallback } = await solanaRpc<string>('getHealth', [], {
      ...options,
      timeoutMs: options.timeoutMs ?? 4_000,
    });
    return {
      available: true,
      endpoint,
      usedFallback,
      latencyMs: Date.now() - started,
      // Named so an operator can see they are on the rate-limited public
      // endpoint before it starts failing under load rather than after.
      isPublicEndpoint: endpoint === PUBLIC_MAINNET || endpoint === PUBLIC_DEVNET,
    };
  } catch (error: any) {
    return {
      available: false,
      endpoint: undefined,
      usedFallback: false,
      latencyMs: Date.now() - started,
      isPublicEndpoint: false,
      message: String(error?.message ?? error),
    };
  }
}
