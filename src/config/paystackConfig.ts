/**
 * PAYSTACK CONFIGURATION.
 *
 * Centralised, validated access to Paystack credentials. Nothing else in the
 * codebase should read a PAYSTACK_* variable directly.
 *
 * NO HARDCODED KEYS. Every credential comes from the environment, and a
 * missing one throws a named error rather than falling back to a default that
 * would silently talk to the wrong account.
 *
 * WHY VALIDATION IS LAZY, NOT AT BOOT.
 *
 * config/env.ts validates at import time, which is right for variables the
 * process cannot run without. Paystack is a rail that most deployments do not
 * use, so a missing key must not stop the server booting. Instead every
 * accessor validates on first use and throws a message naming the exact
 * variable. The cost is that a misconfiguration surfaces at first Paystack
 * call rather than at startup; assertPaystackConfigured() exists so a health
 * check or a deploy smoke test can force that check early.
 */

/** Paystack key prefixes. Live and test keys are structurally distinguishable. */
const SECRET_PREFIXES = ['sk_live_', 'sk_test_'] as const;
const PUBLIC_PREFIXES = ['pk_live_', 'pk_test_'] as const;

export type PaystackMode = 'live' | 'test';

function requireEnv(name: string, hint: string): string {
  const value = (process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name} is not set. ${hint}`);
  }
  return value;
}

/**
 * The Paystack secret key. Server side only, never sent to a browser.
 *
 * Format is checked because a truncated or swapped key produces a 401 from
 * Paystack that reads like an outage rather than a configuration error, and
 * because pasting the PUBLIC key here is a common and confusing mistake.
 */
export function paystackSecretKey(): string {
  const key = requireEnv(
    'PAYSTACK_SECRET_KEY',
    'It is required to call the Paystack API. Find it in the Paystack dashboard under Settings, API Keys and Webhooks.'
  );
  if (key.startsWith('pk_')) {
    throw new Error(
      'PAYSTACK_SECRET_KEY holds a PUBLIC key (pk_...). The secret key starts with sk_live_ or sk_test_. ' +
        'A public key cannot authenticate API calls.'
    );
  }
  if (!SECRET_PREFIXES.some((p) => key.startsWith(p))) {
    throw new Error(
      `PAYSTACK_SECRET_KEY does not look like a Paystack secret key. Expected a prefix of ${SECRET_PREFIXES.join(' or ')}.`
    );
  }
  return key;
}

/**
 * The Paystack public key. Safe to expose to a client.
 *
 * Optional: the DVA flow is entirely server side and does not need it. It is
 * validated only when something actually asks for it.
 */
export function paystackPublicKey(): string {
  const key = requireEnv(
    'PAYSTACK_PUBLIC_KEY',
    'It is required only for client side Paystack widgets, not for the DVA flow.'
  );
  if (key.startsWith('sk_')) {
    throw new Error(
      'PAYSTACK_PUBLIC_KEY holds a SECRET key (sk_...). Never expose a secret key to a client. ' +
        'Rotate it in the Paystack dashboard immediately if it has been shipped anywhere public.'
    );
  }
  if (!PUBLIC_PREFIXES.some((p) => key.startsWith(p))) {
    throw new Error(
      `PAYSTACK_PUBLIC_KEY does not look like a Paystack public key. Expected a prefix of ${PUBLIC_PREFIXES.join(' or ')}.`
    );
  }
  return key;
}

/**
 * The secret used to verify the x-paystack-signature header.
 *
 * IMPORTANT, AND IT CORRECTS A COMMON ASSUMPTION.
 *
 * Paystack does NOT issue a separate webhook secret. Per Paystack's webhook
 * documentation, x-paystack-signature is an HMAC SHA512 of the raw request
 * body signed with your SECRET KEY. So PAYSTACK_WEBHOOK_SECRET defaults to
 * PAYSTACK_SECRET_KEY, which is the only value that will actually verify a
 * genuine Paystack signature.
 *
 * The override exists for one legitimate case: if webhooks are relayed
 * between Sivan services (sivan-escrow-agent to sivan-payment), the internal
 * hop may be signed with a distinct shared secret so an internal endpoint
 * cannot be forged. Setting it for any other reason will cause every real
 * Paystack webhook to fail verification.
 */
export function paystackWebhookSecret(): string {
  const override = (process.env.PAYSTACK_WEBHOOK_SECRET || '').trim();
  if (override) return override;
  return paystackSecretKey();
}

/** True when PAYSTACK_WEBHOOK_SECRET has been deliberately overridden. */
export function webhookSecretIsOverridden(): boolean {
  return Boolean((process.env.PAYSTACK_WEBHOOK_SECRET || '').trim());
}

/**
 * Paystack API base URL.
 *
 * Defaults to the documented production host. This is the one default in this
 * file, and it is safe in a way a credential default never is: Paystack has a
 * single public API host, so there is no wrong account to reach by accident.
 * The override exists for a sandbox proxy or a request recorder in tests.
 *
 * Trailing slashes are stripped so callers can compose paths without
 * producing a double slash, which Paystack answers with a 404.
 */
export function paystackBaseUrl(): string {
  const configured = (process.env.PAYSTACK_BASE_URL || '').trim();
  const url = configured || 'https://api.paystack.co';
  if (!/^https:\/\//i.test(url)) {
    /**
     * One narrow exception, for a loopback stub in tests.
     *
     * Deliberately requires BOTH an explicit opt-in flag AND a loopback host.
     * A flag alone would let a misconfigured deployment send live credentials
     * over plaintext to a real host; a host check alone would let any local
     * process silently downgrade. Requiring both means this cannot be
     * switched on by accident in an environment that matters.
     */
    const optedIn = (process.env.PAYSTACK_ALLOW_INSECURE_BASE_URL || '').trim() === 'true';
    const loopback = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(url);
    if (!(optedIn && loopback)) {
      throw new Error(
        `PAYSTACK_BASE_URL must be https. Got: ${url}. Paystack credentials must never cross a plaintext connection.`
      );
    }
  }
  return url.replace(/\/+$/, '');
}

/** live or test, derived from the secret key rather than a separate flag. */
export function paystackMode(): PaystackMode {
  return paystackSecretKey().startsWith('sk_live_') ? 'live' : 'test';
}

export function isPaystackLive(): boolean {
  return paystackMode() === 'live';
}

/**
 * Is Paystack configured at all? Never throws.
 *
 * For callers that must degrade rather than fail, such as a health endpoint
 * or a router deciding whether to register Paystack routes.
 */
export function isPaystackConfigured(): boolean {
  try {
    paystackSecretKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Force the whole configuration to be checked now.
 *
 * Call from a deploy smoke test or a readiness probe so a bad key is found
 * before a user hits it. Returns a summary safe to log: the mode and a
 * fingerprint, never the key.
 */
export function assertPaystackConfigured(options: { requirePublicKey?: boolean } = {}): {
  mode: PaystackMode;
  baseUrl: string;
  secretKeyFingerprint: string;
  webhookSecretOverridden: boolean;
} {
  const secret = paystackSecretKey();
  if (options.requirePublicKey) paystackPublicKey();
  const baseUrl = paystackBaseUrl();

  /**
   * A fingerprint, not the key. Enough to confirm which key is loaded when
   * two environments disagree, useless to anyone who reads a log.
   */
  const fingerprint = `${secret.slice(0, 8)}...${secret.slice(-4)}`;

  return {
    mode: paystackMode(),
    baseUrl,
    secretKeyFingerprint: fingerprint,
    webhookSecretOverridden: webhookSecretIsOverridden(),
  };
}

/**
 * Refuse a live key outside production, and a test key in production.
 *
 * The first direction is the dangerous one: a staging box holding sk_live_
 * creates REAL bank accounts against REAL customer BVNs and moves REAL money,
 * and nothing in the Paystack response distinguishes that from a test run.
 * The second direction only breaks a demo.
 *
 * Deliberately explicit rather than inferred from NODE_ENV alone, because
 * this codebase already separates deployment mode from node environment (see
 * wallets/network-mode.ts) and conflating them here would be a new convention.
 */
export function assertPaystackModeMatches(expected: PaystackMode): void {
  const actual = paystackMode();
  if (actual === expected) return;

  if (actual === 'live' && expected === 'test') {
    throw new Error(
      'A LIVE Paystack key (sk_live_) is configured in an environment expecting test keys. ' +
        'Refusing: live keys create real bank accounts against real customer BVNs and move real money. ' +
        'Set PAYSTACK_SECRET_KEY to an sk_test_ key for this deployment.'
    );
  }
  throw new Error(
    'A TEST Paystack key (sk_test_) is configured in an environment expecting live keys. ' +
      'Deposits made against a test key never settle.'
  );
}

/**
 * Authorization headers for a Paystack REST call.
 *
 * Single source, so no caller hand builds a Bearer header and no caller can
 * forget one.
 */
export function paystackHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${paystackSecretKey()}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/**
 * The IP addresses Paystack sends webhooks from, per their documentation.
 *
 * Same set for live and test. Signature verification is the primary control
 * and is not optional; this is defence in depth for an allow list at the edge,
 * and is exported rather than inlined so the gateway and the handler cannot
 * drift apart.
 */
export const PAYSTACK_WEBHOOK_IPS = [
  '52.31.139.75',
  '52.49.173.169',
  '52.214.14.220',
] as const;
