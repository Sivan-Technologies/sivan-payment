/**
 * MONEYGRAM ANCHOR CONFIGURATION.
 *
 * MoneyGram is a Stellar SEP-24 anchor for CASH PICKUP and CASH-IN. It is a
 * different rail from the NGN bank providers in src/ngn (Breet and the rest),
 * not a replacement for them, and it is deliberately NOT registered as an
 * NgnProviderAdapter: that interface models a bank transfer to an account
 * number, while this one ends at a human collecting notes over a counter with
 * a reference number. Forcing them into one interface would make both worse.
 *
 * Breet remains the active NGN provider and nothing here touches it.
 *
 * TWO ENVIRONMENTS, AND THEY DIFFER IN WAYS THAT MATTER
 *
 * Verified by fetching both discovery files:
 *
 *   sandbox  extmgxanchor.moneygram.com
 *            NETWORK_PASSPHRASE "Test SDF Network ; September 2015"
 *            SIGNING_KEY        GCUZ6YLL5RQBTYLTTQLPCM73C5XAIUGK2TIMWQH7HPSGWVS2KJ2F3CHS
 *            USDC status        test
 *
 *   production mgxanchor.moneygram.com
 *            NETWORK_PASSPHRASE "Public Global Stellar Network ; September 2015"
 *            SIGNING_KEY        GD5NUMEX7LYHXGXCAD4PGW7JDMOUY2DKRGY5XZHJS5IONVHDKCJYGVCL
 *            USDC status        live
 *
 * The signing key AND the network passphrase both change. A SEP-10 challenge
 * must be verified against the right key on the right network: accept the
 * wrong key and a forged challenge passes, use the wrong passphrase and every
 * genuine one is rejected. Both are therefore resolved together from one
 * source rather than configured as independent variables that can drift.
 *
 * NO HARDCODED ENDPOINTS. The hosts above are documented defaults; every one
 * is overridable, and the authoritative values are read from the anchor's own
 * stellar.toml at runtime rather than trusted from this file.
 */

import { Networks } from '@stellar/stellar-sdk';

export type MoneyGramEnvironment = 'sandbox' | 'production';

/**
 * Documented anchor hosts. Defaults only: MONEYGRAM_ANCHOR_HOST overrides,
 * and the TOML fetched from the host is what actually drives the flow.
 */
const ANCHOR_HOSTS: Record<MoneyGramEnvironment, string> = {
  sandbox: 'https://extmgxanchor.moneygram.com',
  production: 'https://mgxanchor.moneygram.com',
};

/**
 * Expected signing keys, used as a TRIPWIRE rather than as the source.
 *
 * The TOML is authoritative, but if an attacker could serve us a modified
 * TOML they could also substitute their own signing key and mint valid
 * looking challenges. Pinning the known values means a mismatch is loud.
 * Override only if MoneyGram rotates, and verify out of band first.
 */
const EXPECTED_SIGNING_KEY: Record<MoneyGramEnvironment, string> = {
  sandbox: 'GCUZ6YLL5RQBTYLTTQLPCM73C5XAIUGK2TIMWQH7HPSGWVS2KJ2F3CHS',
  production: 'GD5NUMEX7LYHXGXCAD4PGW7JDMOUY2DKRGY5XZHJS5IONVHDKCJYGVCL',
};

/** Network passphrase per environment. Not independently configurable. */
const NETWORK_PASSPHRASE: Record<MoneyGramEnvironment, string> = {
  sandbox: Networks.TESTNET,
  production: Networks.PUBLIC,
};

/**
 * Which MoneyGram environment this deployment talks to.
 *
 * Defaults to sandbox. The opposite default would have a misconfigured
 * staging box moving real money to real counters, which is unrecoverable in
 * a way that a failed sandbox call is not.
 */
export function moneyGramEnvironment(): MoneyGramEnvironment {
  const raw = (process.env.MONEYGRAM_ENVIRONMENT || '').trim().toLowerCase();
  if (raw === 'production' || raw === 'live') return 'production';
  return 'sandbox';
}

export function isMoneyGramProduction(): boolean {
  return moneyGramEnvironment() === 'production';
}

/** Anchor host, env override first, documented default second. */
export function anchorHost(): string {
  const configured = (process.env.MONEYGRAM_ANCHOR_HOST || '').trim();
  const host = configured || ANCHOR_HOSTS[moneyGramEnvironment()];
  if (!/^https:\/\//i.test(host)) {
    throw new Error(
      `MONEYGRAM_ANCHOR_HOST must be https. Got: ${host}. SEP-10 credentials must never cross a plaintext connection.`
    );
  }
  return host.replace(/\/+$/, '');
}

/** SEP-0001 discovery document for the configured anchor. */
export function anchorTomlUrl(): string {
  return `${anchorHost()}/.well-known/stellar.toml`;
}

export function expectedSigningKey(): string {
  const override = (process.env.MONEYGRAM_ANCHOR_SIGNING_KEY || '').trim();
  return override || EXPECTED_SIGNING_KEY[moneyGramEnvironment()];
}

export function networkPassphrase(): string {
  return NETWORK_PASSPHRASE[moneyGramEnvironment()];
}

/**
 * The Stellar account Sivan authenticates as.
 *
 * This is the account MoneyGram allowlists, and the one that must hold the
 * USDC that gets sent to the anchor during a withdrawal. Public key only
 * here: the secret is resolved separately and never returned by this module.
 */
export function sivanStellarPublicKey(): string {
  const key = (process.env.MONEYGRAM_STELLAR_PUBLIC_KEY || process.env.STELLAR_PUBLIC_KEY || '').trim();
  if (!key) {
    throw new Error(
      'MONEYGRAM_STELLAR_PUBLIC_KEY is not set. It is the account MoneyGram allowlists for SEP-10 ' +
        'and the account that funds withdrawals.'
    );
  }
  if (!/^G[A-Z2-7]{55}$/.test(key)) {
    throw new Error(`MONEYGRAM_STELLAR_PUBLIC_KEY is not a valid Stellar public key: ${key.slice(0, 8)}...`);
  }
  return key;
}

/**
 * The signing secret, fetched only at the moment of signing.
 *
 * Deliberately a function rather than a module constant so the value is not
 * sitting in memory for the process lifetime, and so a missing secret fails
 * at the signing call with a named error rather than at import.
 */
export function sivanStellarSecret(): string {
  const secret = (process.env.MONEYGRAM_STELLAR_SECRET || process.env.STELLAR_SECRET_KEY || '').trim();
  if (!secret) {
    throw new Error(
      'MONEYGRAM_STELLAR_SECRET is not set. SEP-10 requires signing the anchor challenge with the ' +
        'allowlisted account key.'
    );
  }
  if (!/^S[A-Z2-7]{55}$/.test(secret)) {
    throw new Error('MONEYGRAM_STELLAR_SECRET is not a valid Stellar secret key (expected S... 56 chars).');
  }
  return secret;
}

/**
 * The home domain Sivan presents during SEP-10.
 *
 * MoneyGram allowlists this domain and will reject a challenge request from
 * one it does not recognise. It must match the domain serving our own
 * stellar.toml.
 */
export function sivanHomeDomain(): string {
  const d = (process.env.MONEYGRAM_HOME_DOMAIN || '').trim();
  if (!d) {
    throw new Error(
      'MONEYGRAM_HOME_DOMAIN is not set. MoneyGram allowlists this domain for SEP-10 and it must match ' +
        'the domain serving our .well-known/stellar.toml.'
    );
  }
  return d.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/** Optional REST Payout API credentials, a separate rail from SEP-24. */
export function payoutApiConfig(): { baseUrl: string; partnerId: string; apiKey: string } {
  const baseUrl = (process.env.MONEYGRAM_API_BASE_URL || '').trim();
  const partnerId = (process.env.MONEYGRAM_PARTNER_ID || '').trim();
  const apiKey = (process.env.MONEYGRAM_API_KEY || '').trim();
  const missing = [
    !baseUrl && 'MONEYGRAM_API_BASE_URL',
    !partnerId && 'MONEYGRAM_PARTNER_ID',
    !apiKey && 'MONEYGRAM_API_KEY',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `MoneyGram Payout API is not configured. Missing: ${missing.join(', ')}. ` +
        'This is the server-to-server payout rail and is separate from the SEP-24 interactive flow.'
    );
  }
  if (!/^https:\/\//i.test(baseUrl)) {
    throw new Error(`MONEYGRAM_API_BASE_URL must be https. Got: ${baseUrl}`);
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), partnerId, apiKey };
}

/** MoneyGram's RSA public key for webhook signature verification. */
export function webhookPublicKey(): string {
  const pem = (process.env.MONEYGRAM_WEBHOOK_PUBLIC_KEY || '').trim();
  if (!pem) {
    throw new Error(
      'MONEYGRAM_WEBHOOK_PUBLIC_KEY is not set. Webhooks are signed RSA-SHA256 and MUST be verified ' +
        'before the payload is parsed; without the key every callback has to be rejected.'
    );
  }
  if (!pem.includes('BEGIN PUBLIC KEY')) {
    throw new Error('MONEYGRAM_WEBHOOK_PUBLIC_KEY must be a PEM public key including the BEGIN PUBLIC KEY header.');
  }
  return pem.replace(/\\n/g, '\n');
}

/** Is the SEP-24 rail configured enough to attempt a session? Never throws. */
export function isMoneyGramConfigured(): boolean {
  try {
    anchorHost();
    sivanStellarPublicKey();
    sivanHomeDomain();
    return true;
  } catch {
    return false;
  }
}

/**
 * Configuration summary safe to log or return from a health endpoint.
 *
 * Reports what is set, never the values. The Stellar public key is safe to
 * show in full; the secret is reported only as present or absent.
 */
export function moneyGramConfigSummary(): {
  environment: MoneyGramEnvironment;
  anchorHost: string;
  networkPassphrase: string;
  expectedSigningKey: string;
  stellarAccount?: string;
  homeDomain?: string;
  secretPresent: boolean;
  payoutApiConfigured: boolean;
  webhookKeyConfigured: boolean;
} {
  const safe = <T>(fn: () => T): T | undefined => { try { return fn(); } catch { return undefined; } };
  return {
    environment: moneyGramEnvironment(),
    anchorHost: anchorHost(),
    networkPassphrase: networkPassphrase(),
    expectedSigningKey: expectedSigningKey(),
    stellarAccount: safe(sivanStellarPublicKey),
    homeDomain: safe(sivanHomeDomain),
    secretPresent: Boolean(safe(sivanStellarSecret)),
    payoutApiConfigured: Boolean(safe(payoutApiConfig)),
    webhookKeyConfigured: Boolean(safe(webhookPublicKey)),
  };
}

/**
 * Refuse a production anchor when the deployment expects sandbox.
 *
 * The dangerous direction is production-in-staging: a cashout there is a real
 * person collecting real cash, and no response distinguishes it from a test.
 */
export function assertMoneyGramEnvironment(expected: MoneyGramEnvironment): void {
  const actual = moneyGramEnvironment();
  if (actual === expected) return;
  if (actual === 'production') {
    throw new Error(
      'MoneyGram is pointed at PRODUCTION in an environment expecting sandbox. Refusing: a cashout here ' +
        'is real cash collected at a real counter. Set MONEYGRAM_ENVIRONMENT=sandbox.'
    );
  }
  throw new Error('MoneyGram is pointed at SANDBOX in an environment expecting production. Cashouts will not settle.');
}
