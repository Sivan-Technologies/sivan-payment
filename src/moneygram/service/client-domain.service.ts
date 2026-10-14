/**
 * SIVAN'S OWN stellar.toml, CHECKED AGAINST SIVAN'S OWN CONFIG.
 *
 * WHY THIS EXISTS
 *
 * anchor-discovery.service.ts verifies MoneyGram's stellar.toml. Nothing
 * verified OURS, and ours is half of the SEP-10 handshake.
 *
 * MoneyGram allowlists a domain and an account. During SEP-10 it can fetch
 * https://<our home domain>/.well-known/stellar.toml and read SIGNING_KEY to
 * decide whether the account asking for a challenge is one it recognises. So
 * three values have to agree that nothing in the codebase was comparing:
 *
 *   MONEYGRAM_HOME_DOMAIN         the domain we tell MoneyGram to look at
 *   MONEYGRAM_STELLAR_PUBLIC_KEY  the account we actually sign challenges with
 *   SIGNING_KEY in the published toml
 *
 * When they drift, SEP-10 fails in production with an opaque rejection from
 * the anchor, and nothing on our side logs a cause. The failure looks like a
 * MoneyGram outage. It is a one character typo in an environment variable.
 *
 * TWO REAL PROBLEMS THIS FOUND ON THE LIVE DOMAIN
 *
 *   1. https://sivantech.online/.well-known/stellar.toml answers 308 and
 *      redirects to www. The toml itself says "Hosted at sivantech.online".
 *      A client that does not follow redirects, and SEP-1 does not require
 *      that it does, sees no toml at all. Whichever hostname actually serves
 *      the file is the one MONEYGRAM_HOME_DOMAIN has to name.
 *
 *   2. The published NETWORK_PASSPHRASE is the testnet one. That is correct
 *      today because we run against the sandbox anchor, and it becomes wrong
 *      the moment MONEYGRAM_ENVIRONMENT flips to production. That transition
 *      is exactly when nobody re-reads a static file.
 *
 * Both are reported by verifyClientDomain() rather than discovered during a
 * launch.
 */

import { StrKey } from '@stellar/stellar-sdk';
import {
  sivanHomeDomain,
  sivanStellarPublicKey,
  networkPassphrase,
  moneyGramEnvironment,
} from '../config/moneygram.config.js';

export interface SivanTomlDocument {
  /** The URL we asked for, derived strictly from the configured home domain. */
  requestedUrl: string;
  /** Where the request actually ended up. Differs when a redirect occurred. */
  finalUrl: string;
  redirected: boolean;
  httpStatus: number;
  contentType?: string;
  signingKey?: string;
  networkPassphrase?: string;
  accounts: string[];
  raw: string;
}

export interface ClientDomainCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ClientDomainReport {
  ok: boolean;
  homeDomain: string;
  checks: ClientDomainCheck[];
  problems: string[];
}

export function sivanTomlUrl(domain: string): string {
  const clean = domain.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return `https://${clean}/.well-known/stellar.toml`;
}

/**
 * Pull the handful of top level values SEP-1 puts before the first table.
 *
 * This is deliberately NOT a general TOML parser. SIGNING_KEY,
 * NETWORK_PASSPHRASE and ACCOUNTS are all top level scalars or a simple
 * array, and a full parser would be a dependency and a parsing surface added
 * for no gain. Everything from the first table header onwards is ignored, so
 * a key of the same name nested inside [DOCUMENTATION] cannot be mistaken for
 * the real one.
 */
export function parseTopLevelToml(raw: string): {
  signingKey?: string;
  networkPassphrase?: string;
  accounts: string[];
} {
  const lines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (/^\[/.test(t)) break;        // first table header ends the top level
    lines.push(line);
  }
  const head = lines.join('\n');

  const scalar = (key: string): string | undefined => {
    const m = head.match(
      new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm')
    );
    return m ? m[1] : undefined;
  };

  const accounts: string[] = [];
  const arr = head.match(/^\s*ACCOUNTS\s*=\s*\[([\s\S]*?)\]/m);
  if (arr) {
    for (const m of arr[1].matchAll(/"([^"]+)"/g)) accounts.push(m[1]);
  }

  return {
    signingKey: scalar('SIGNING_KEY'),
    networkPassphrase: scalar('NETWORK_PASSPHRASE'),
    accounts,
  };
}

export async function fetchSivanToml(options: {
  domain?: string;
  timeoutMs?: number;
} = {}): Promise<SivanTomlDocument> {
  const domain = options.domain ?? sivanHomeDomain();
  const requestedUrl = sivanTomlUrl(domain);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const res = await fetch(requestedUrl, {
      redirect: 'follow',
      signal: controller.signal,
    });
    const raw = await res.text();
    const parsed = parseTopLevelToml(raw);
    return {
      requestedUrl,
      finalUrl: res.url || requestedUrl,
      redirected: Boolean(res.url) && res.url !== requestedUrl,
      httpStatus: res.status,
      contentType: res.headers.get('content-type') ?? undefined,
      raw,
      ...parsed,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compare the published document against what this deployment believes.
 *
 * Returns a report rather than throwing. A health endpoint needs every
 * problem at once, not whichever one happened to be checked first.
 */
export async function verifyClientDomain(options: {
  domain?: string;
  timeoutMs?: number;
} = {}): Promise<ClientDomainReport> {
  const checks: ClientDomainCheck[] = [];
  const problems: string[] = [];

  let homeDomain: string;
  try {
    homeDomain = options.domain ?? sivanHomeDomain();
  } catch (err: any) {
    return {
      ok: false,
      homeDomain: '',
      checks: [{ name: 'home_domain_configured', ok: false, detail: String(err?.message ?? err) }],
      problems: [String(err?.message ?? err)],
    };
  }

  let doc: SivanTomlDocument;
  try {
    doc = await fetchSivanToml({ domain: homeDomain, timeoutMs: options.timeoutMs });
  } catch (err: any) {
    const detail = `Could not fetch ${sivanTomlUrl(homeDomain)}: ${String(err?.message ?? err)}`;
    return {
      ok: false,
      homeDomain,
      checks: [{ name: 'toml_reachable', ok: false, detail }],
      problems: [detail],
    };
  }

  const add = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    if (!ok) problems.push(detail);
  };

  add('toml_reachable', doc.httpStatus === 200,
      `GET ${doc.requestedUrl} returned HTTP ${doc.httpStatus}.`);

  add('served_without_redirect', !doc.redirected,
      doc.redirected
        ? `${doc.requestedUrl} redirects to ${doc.finalUrl}. SEP-1 clients are not ` +
          'required to follow redirects, so set MONEYGRAM_HOME_DOMAIN to the host ' +
          'that serves the file directly.'
        : `${doc.requestedUrl} is served directly.`);

  add('signing_key_present', Boolean(doc.signingKey),
      doc.signingKey
        ? `SIGNING_KEY ${doc.signingKey}`
        : 'The published toml has no top level SIGNING_KEY. MoneyGram reads this to ' +
          'recognise the account requesting a SEP-10 challenge.');

  if (doc.signingKey) {
    add('signing_key_valid', StrKey.isValidEd25519PublicKey(doc.signingKey),
        StrKey.isValidEd25519PublicKey(doc.signingKey)
          ? 'SIGNING_KEY is a valid Stellar public key.'
          : `SIGNING_KEY ${doc.signingKey} is not a valid Stellar public key.`);
  }

  let configured: string | undefined;
  try {
    configured = sivanStellarPublicKey();
  } catch (err: any) {
    add('stellar_public_key_configured', false, String(err?.message ?? err));
  }

  if (configured && doc.signingKey) {
    const match = configured === doc.signingKey;
    add('signing_key_matches_config', match,
        match
          ? 'The published SIGNING_KEY matches MONEYGRAM_STELLAR_PUBLIC_KEY.'
          : `The published SIGNING_KEY is ${doc.signingKey} but this deployment signs ` +
            `SEP-10 challenges with ${configured}. MoneyGram allowlists one account; ` +
            'while these disagree, production authentication is rejected with no ' +
            'explanation from our side.');
  }

  const expectedPassphrase = networkPassphrase();
  if (doc.networkPassphrase) {
    const match = doc.networkPassphrase === expectedPassphrase;
    add('network_passphrase_matches_environment', match,
        match
          ? `NETWORK_PASSPHRASE matches the ${moneyGramEnvironment()} anchor.`
          : `The published NETWORK_PASSPHRASE is "${doc.networkPassphrase}" but ` +
            `MONEYGRAM_ENVIRONMENT=${moneyGramEnvironment()} expects ` +
            `"${expectedPassphrase}". A static file does not change when the ` +
            'environment variable does, which is why this is checked.');
  } else {
    add('network_passphrase_present', false,
        'The published toml has no top level NETWORK_PASSPHRASE.');
  }

  return { ok: problems.length === 0, homeDomain, checks, problems };
}
