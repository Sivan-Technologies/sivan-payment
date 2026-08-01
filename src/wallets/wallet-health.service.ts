import { env } from '../config/env.js';
import { loadAuthorizationPrivateKey } from './provider/privy-authorization.js';
import { resolveActiveWalletProvider } from './wallet-controls.service.js';

/**
 * Can the DEPLOYED service actually reach its wallet provider?
 *
 * This exists because of a specific gap. Every credential check so far has run
 * on a developer machine against a local .env, and a service on Render with a
 * mistyped secret behaves identically to a correct one right up until a user
 * asks for a wallet - at which point it fails inside an authenticated route
 * that is awkward to reach from outside.
 *
 * Worse, the failure surfaces AFTER the KYC gate, so a misconfigured
 * deployment looks like a working one to anyone testing without a verified
 * bank account. That is exactly what happened while verifying Render: the
 * request was refused for "add your payout bank account" and never touched
 * Privy at all.
 *
 * So this makes the credential question directly observable, with no user, no
 * KYC and no wallet creation involved.
 */

export interface WalletProviderHealth {
  provider: string;
  /** Did the provider answer, and accept our credentials? */
  available: boolean;
  /** Whether the check ran at all - false when nothing is configured. */
  configured: boolean;
  mode: 'mock' | 'live' | 'unconfigured';
  /** Whether Sivan can sign for wallets, i.e. one-tap off-ramp is possible. */
  delegatedSigningReady: boolean;
  details: Record<string, unknown>;
  message?: string;
  latencyMs: number;
  checkedAt: string;
}

const PRIVY_BASE = 'https://api.privy.io/v1';

/**
 * Privy: prove the credentials are actually accepted.
 *
 * GET /v1/users?limit=1 is used, and the choice matters. The obvious endpoint
 * is GET /v1/apps/{id}, which is what this first tried - but it does NOT
 * authenticate. Verified directly: it returns 200 with the app's full details
 * when handed a completely fabricated secret, so a health check built on it
 * reports "available" for a deployment whose credentials are wrong. That is
 * worse than no check at all, because it manufactures false confidence.
 *
 * /users?limit=1 returns 401 on a bad secret, confirmed by probing both. It is
 * read-only, returns at most one record, and creates nothing - unlike a
 * wallet-creating probe, which would leave a billable wallet behind that
 * cannot be deleted.
 */
async function checkPrivy(timeoutMs: number): Promise<WalletProviderHealth> {
  const started = Date.now();
  const appId = process.env.PRIVY_APP_ID || env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET || env.PRIVY_APP_SECRET;

  const signingKey = loadAuthorizationPrivateKey(
    process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY || env.PRIVY_AUTHORIZATION_PRIVATE_KEY
  );
  const quorumId = (
    process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID || env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID || ''
  ).trim();

  const base = {
    provider: 'privy',
    // Reported separately from `available`, because a signing key is what
    // makes one-tap off-ramp possible. Without it wallets still work, but
    // every withdrawal falls back to pending_user_signature - and nothing in
    // the product can currently consume that.
    delegatedSigningReady: Boolean(signingKey && quorumId),
    details: {
      appIdConfigured: Boolean(appId),
      appSecretConfigured: Boolean(appSecret),
      authorizationKeyConfigured: Boolean(signingKey),
      keyQuorumConfigured: Boolean(quorumId),
      // Safe to expose: it appears in the dashboard URL and in every client
      // bundle. The SECRET is never echoed, not even truncated - a prefix is
      // enough to confirm a paste error and enough to help an attacker.
      appId: appId || undefined,
      keyQuorumId: quorumId || undefined,
    },
    checkedAt: new Date().toISOString(),
  };

  if (!appId || !appSecret) {
    return {
      ...base,
      available: false,
      configured: false,
      mode: 'unconfigured' as const,
      message: 'PRIVY_APP_ID or PRIVY_APP_SECRET is not set on this deployment.',
      latencyMs: Date.now() - started,
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${PRIVY_BASE}/users?limit=1`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
          'privy-app-id': appId,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const body: any = await response.json().catch(() => ({}));

    if (!response.ok) {
      return {
        ...base,
        available: false,
        configured: true,
        mode: 'live' as const,
        // 401 means the credentials are wrong, which is a different problem
        // from Privy being down, and an operator needs to know which.
        message:
          response.status === 401
            ? 'Privy rejected these credentials. Check PRIVY_APP_SECRET on this deployment.'
            : `Privy returned HTTP ${response.status}: ${body?.error ?? 'unknown error'}`,
        latencyMs: Date.now() - started,
      };
    }

    // Credentials are good. Now confirm the key quorum actually EXISTS in this
    // app - a quorum id copied from another environment authenticates fine and
    // then fails at signing time, which is far harder to diagnose.
    let quorumExists: boolean | undefined;
    if (quorumId) {
      quorumExists = await fetch(`${PRIVY_BASE}/key_quorums/${encodeURIComponent(quorumId)}`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
          'privy-app-id': appId,
        },
      })
        .then((quorumResponse) => quorumResponse.ok)
        .catch(() => undefined);
    }

    const usersVisible = Array.isArray(body?.data) ? body.data.length : undefined;

    return {
      ...base,
      available: true,
      configured: true,
      mode: 'live' as const,
      // Signing needs BOTH a key and a quorum that exists here. A configured
      // quorum id that belongs to another app is not ready, whatever the
      // environment variables say.
      delegatedSigningReady: Boolean(signingKey && quorumId && quorumExists !== false),
      details: {
        ...base.details,
        keyQuorumExists: quorumExists,
        usersVisible,
      },
      message:
        quorumId && quorumExists === false
          ? 'Credentials are valid, but PRIVY_AUTHORIZATION_KEY_QUORUM_ID does not exist in this Privy app.'
          : undefined,
      latencyMs: Date.now() - started,
    };
  } catch (error: any) {
    return {
      ...base,
      available: false,
      configured: true,
      mode: 'live' as const,
      message:
        error?.name === 'AbortError'
          ? `Privy did not respond within ${timeoutMs}ms.`
          : String(error?.message ?? error),
      latencyMs: Date.now() - started,
    };
  }
}

/** Bridge: credential presence only, since its probe needs a live customer. */
function checkBridge(): WalletProviderHealth {
  const apiKey = process.env.BRIDGE_API_KEY || (env as any).BRIDGE_API_KEY;
  return {
    provider: 'bridge',
    available: Boolean(apiKey),
    configured: Boolean(apiKey),
    mode: apiKey ? 'live' : 'unconfigured',
    // Bridge wallets are custodial: Bridge holds the keys and signs, so there
    // is no delegated signer to be ready.
    delegatedSigningReady: false,
    details: { apiKeyConfigured: Boolean(apiKey) },
    message: apiKey ? undefined : 'BRIDGE_API_KEY is not set on this deployment.',
    latencyMs: 0,
    checkedAt: new Date().toISOString(),
  };
}

function checkMock(): WalletProviderHealth {
  return {
    provider: 'mock',
    available: true,
    configured: true,
    mode: 'mock',
    delegatedSigningReady: false,
    details: {},
    // Stated loudly. A mock wallet hands out an address nobody controls, and
    // an operator seeing "available: true" should not read that as healthy.
    message: 'Mock wallets are simulated. Addresses belong to nobody and funds sent to them are lost.',
    latencyMs: 0,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Health for whichever provider is currently active.
 *
 * Resolved through the same path wallet creation uses, so this reports on the
 * provider that would ACTUALLY serve a user - not on whatever the environment
 * variable happens to say. If an admin has overridden the provider, this
 * follows the override.
 */
export async function getWalletProviderHealth(timeoutMs = 8_000): Promise<WalletProviderHealth> {
  const provider = (await resolveActiveWalletProvider()).trim().toLowerCase();

  if (provider === 'privy') return checkPrivy(timeoutMs);
  if (provider === 'bridge') return checkBridge();
  if (provider === 'mock') return checkMock();

  return {
    provider,
    available: false,
    configured: false,
    mode: 'unconfigured',
    delegatedSigningReady: false,
    details: {},
    message: `Unknown wallet provider "${provider}".`,
    latencyMs: 0,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Every provider, so an operator can see what switching WOULD get them.
 *
 * The Privy check makes a network call; the others do not, so this is cheap
 * enough for an admin screen to poll.
 */
export async function getAllWalletProviderHealth(timeoutMs = 8_000) {
  const active = (await resolveActiveWalletProvider()).trim().toLowerCase();
  const privy = await checkPrivy(timeoutMs);

  return {
    activeProvider: active,
    providers: [privy, checkBridge(), checkMock()],
    checkedAt: new Date().toISOString(),
  };
}
