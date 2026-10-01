/**
 * SEP-0001 ANCHOR DISCOVERY.
 *
 * Fetches and validates MoneyGram's stellar.toml, which is the authoritative
 * source for the SEP-10 and SEP-24 endpoints and the anchor's signing key.
 *
 * WHY FETCH IT INSTEAD OF HARDCODING THE ENDPOINTS
 *
 * The endpoints are documented and stable, so hardcoding would work most
 * days. The reason not to is the SIGNING KEY: SEP-10 security rests entirely
 * on verifying that the challenge was signed by the anchor, and a stale
 * hardcoded key would either reject every genuine challenge after a rotation
 * or, worse, be quietly wrong in a way nobody notices until it matters.
 *
 * AND WHY THE TOML ALONE IS NOT TRUSTED EITHER
 *
 * If an attacker could serve us a modified TOML they could also substitute
 * their own SIGNING_KEY and mint challenges we would happily sign. So the
 * fetched key is cross-checked against a pinned expected value, and a
 * mismatch is refused loudly rather than adopted. The TOML supplies the
 * endpoints; the pin supplies the trust.
 *
 * The network passphrase is likewise checked, because a sandbox TOML served
 * at a production host (or the reverse) would have us sign a challenge on the
 * wrong network, where it is worthless at best.
 */

import {
  anchorTomlUrl,
  anchorHost,
  expectedSigningKey,
  networkPassphrase,
  moneyGramEnvironment,
} from '../config/moneygram.config.js';

export interface AnchorInfo {
  /** Where the document came from. */
  tomlUrl: string;
  /** SEP-10 challenge endpoint. */
  webAuthEndpoint: string;
  /** SEP-24 interactive endpoint. */
  transferServerSep24: string;
  /** The anchor's SEP-10 signing key, cross-checked against the pin. */
  signingKey: string;
  networkPassphrase: string;
  /** USDC issuer the anchor settles in. */
  usdcIssuer?: string;
  /** 'test' or 'live' as the anchor itself declares. */
  currencyStatus?: string;
  fetchedAt: string;
}

/**
 * Minimal TOML reader for the handful of flat keys SEP-0001 needs.
 *
 * A full TOML parser is a dependency for about twenty lines of work, and the
 * fields we need are all top level strings plus one [[CURRENCIES]] block.
 * Deliberately narrow: anything it cannot parse is reported as missing rather
 * than guessed at.
 */
function readTomlValue(toml: string, key: string): string | undefined {
  const m = toml.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'mi'));
  return m?.[1];
}

function readFirstCurrency(toml: string): { code?: string; issuer?: string; status?: string } {
  const block = toml.split(/\[\[CURRENCIES\]\]/i)[1];
  if (!block) return {};
  return {
    code: readTomlValue(block, 'code'),
    issuer: readTomlValue(block, 'issuer'),
    status: readTomlValue(block, 'status'),
  };
}

/**
 * Cached because the TOML is fetched before every SEP-10 handshake and it
 * changes approximately never. Short TTL so a key rotation is picked up the
 * same day without a deploy.
 */
let cache: { info: AnchorInfo; expiresAt: number } | undefined;
const CACHE_TTL_MS = 10 * 60 * 1000;

export function clearAnchorCache(): void {
  cache = undefined;
}

export async function fetchAnchorInfo(options: { timeoutMs?: number; force?: boolean } = {}): Promise<AnchorInfo> {
  if (!options.force && cache && cache.expiresAt > Date.now()) return cache.info;

  const url = anchorTomlUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);

  let body: string;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`MoneyGram anchor discovery failed: ${url} returned HTTP ${res.status}`);
    }
    body = await res.text();
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`MoneyGram anchor discovery timed out fetching ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const webAuthEndpoint = readTomlValue(body, 'WEB_AUTH_ENDPOINT');
  const transferServerSep24 = readTomlValue(body, 'TRANSFER_SERVER_SEP0024');
  const signingKey = readTomlValue(body, 'SIGNING_KEY');
  const passphrase = readTomlValue(body, 'NETWORK_PASSPHRASE');

  const missing = [
    !webAuthEndpoint && 'WEB_AUTH_ENDPOINT',
    !transferServerSep24 && 'TRANSFER_SERVER_SEP0024',
    !signingKey && 'SIGNING_KEY',
    !passphrase && 'NETWORK_PASSPHRASE',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`MoneyGram stellar.toml at ${url} is missing required fields: ${missing.join(', ')}`);
  }

  /**
   * THE TRIPWIRE. A served TOML is not a trust anchor on its own.
   */
  const pinned = expectedSigningKey();
  if (signingKey !== pinned) {
    throw new Error(
      `MoneyGram anchor SIGNING_KEY does not match the pinned value for the ${moneyGramEnvironment()} ` +
        `environment. Served: ${signingKey}. Expected: ${pinned}. Refusing to proceed: a substituted ` +
        'signing key would let a third party mint SEP-10 challenges we would sign. If MoneyGram has ' +
        'rotated this key, verify out of band and set MONEYGRAM_ANCHOR_SIGNING_KEY.'
    );
  }

  /**
   * A sandbox TOML served from a production host means the environment is
   * misconfigured. Signing on the wrong network produces an auth token the
   * anchor will not honour, and in the other direction risks touching real
   * money from a staging box.
   */
  const expectedPassphrase = networkPassphrase();
  if (passphrase !== expectedPassphrase) {
    throw new Error(
      `MoneyGram anchor NETWORK_PASSPHRASE mismatch. Served: "${passphrase}". ` +
        `Expected for ${moneyGramEnvironment()}: "${expectedPassphrase}". ` +
        'The anchor host and MONEYGRAM_ENVIRONMENT disagree.'
    );
  }

  /** The endpoints must belong to the host we asked, not a redirect target. */
  const host = anchorHost();
  for (const [name, value] of [
    ['WEB_AUTH_ENDPOINT', webAuthEndpoint!],
    ['TRANSFER_SERVER_SEP0024', transferServerSep24!],
  ] as const) {
    if (!value.startsWith(host)) {
      throw new Error(
        `MoneyGram ${name} points outside the configured anchor host. ` +
          `Host: ${host}. Endpoint: ${value}. Refusing: this is how a hijacked discovery file redirects auth.`
      );
    }
  }

  const currency = readFirstCurrency(body);

  const info: AnchorInfo = {
    tomlUrl: url,
    webAuthEndpoint: webAuthEndpoint!,
    transferServerSep24: transferServerSep24!,
    signingKey: signingKey!,
    networkPassphrase: passphrase!,
    usdcIssuer: currency.issuer,
    currencyStatus: currency.status,
    fetchedAt: new Date().toISOString(),
  };

  cache = { info, expiresAt: Date.now() + CACHE_TTL_MS };
  return info;
}

/**
 * Health probe. Never throws, so a readiness endpoint can report degraded
 * rather than failing, and so the reason is visible to an operator.
 */
export async function anchorHealth(): Promise<{
  reachable: boolean;
  signingKeyMatches: boolean;
  networkMatches: boolean;
  currencyStatus?: string;
  message?: string;
}> {
  try {
    const info = await fetchAnchorInfo({ force: true, timeoutMs: 8_000 });
    return {
      reachable: true,
      signingKeyMatches: true,
      networkMatches: true,
      currencyStatus: info.currencyStatus,
    };
  } catch (error: any) {
    const msg = String(error?.message ?? error);
    return {
      reachable: !/timed out|HTTP \d|fetch failed/i.test(msg),
      signingKeyMatches: !/SIGNING_KEY does not match/i.test(msg),
      networkMatches: !/NETWORK_PASSPHRASE mismatch/i.test(msg),
      message: msg,
    };
  }
}
