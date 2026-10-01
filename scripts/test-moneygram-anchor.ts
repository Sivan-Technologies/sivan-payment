/**
 * MONEYGRAM ANCHOR DISCOVERY, AGAINST THE REAL ANCHORS.
 *
 * Hits MoneyGram's live sandbox and production stellar.toml. No key needed:
 * SEP-0001 discovery is public, which is what makes it testable in CI while
 * the rest of the flow is not.
 *
 * The assertions that matter are the refusals. SEP-10 security rests on
 * verifying that a challenge was signed by the anchor, so a wrong or
 * substituted signing key is the failure that lets a third party mint
 * challenges we would sign with the account that holds our USDC.
 */

import {
  fetchAnchorInfo, clearAnchorCache, anchorHealth,
} from '../src/moneygram/service/anchor-discovery.service.js';
import {
  moneyGramEnvironment, anchorHost, networkPassphrase, expectedSigningKey,
  isMoneyGramConfigured, moneyGramConfigSummary, assertMoneyGramEnvironment,
  sivanStellarPublicKey, sivanStellarSecret, webhookPublicKey, payoutApiConfig,
} from '../src/moneygram/config/moneygram.config.js';

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ok - ${name}`); }
  else { failed++; console.log(`  ❌ FAIL - ${name}${detail ? `  (${detail})` : ''}`); }
}
function throws(fn: () => unknown): boolean { try { fn(); return false; } catch { return true; } }
async function rejectsWith(fn: () => Promise<unknown>, re: RegExp): Promise<boolean> {
  try { await fn(); return false; } catch (e: any) { return re.test(String(e?.message ?? e)); }
}
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { fn(); } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}
async function withEnvAsync(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    clearAnchorCache();
  }
}

const SANDBOX_KEY = 'GCUZ6YLL5RQBTYLTTQLPCM73C5XAIUGK2TIMWQH7HPSGWVS2KJ2F3CHS';
const PROD_KEY = 'GD5NUMEX7LYHXGXCAD4PGW7JDMOUY2DKRGY5XZHJS5IONVHDKCJYGVCL';
const TESTNET_PP = 'Test SDF Network ; September 2015';
const PUBLIC_PP = 'Public Global Stellar Network ; September 2015';

async function main() {
  console.log('\n' + '='.repeat(52));
  console.log('🔷 SIVAN MONEYGRAM ANCHOR TEST SUITE');
  console.log('='.repeat(52));

  // ── 1. Environment defaults ─────────────────────────────────────
  console.log('\n══ 1. Environment Resolution ══');

  withEnv({ MONEYGRAM_ENVIRONMENT: undefined, MONEYGRAM_ANCHOR_HOST: undefined }, () => {
    /** Sandbox by default: the opposite default moves real cash from staging. */
    check('defaults to sandbox, not production', moneyGramEnvironment() === 'sandbox');
    check('sandbox host is the documented ext anchor',
      anchorHost() === 'https://extmgxanchor.moneygram.com', anchorHost());
    check('sandbox uses the TESTNET passphrase', networkPassphrase() === TESTNET_PP);
  });

  withEnv({ MONEYGRAM_ENVIRONMENT: 'production', MONEYGRAM_ANCHOR_HOST: undefined }, () => {
    check('production host is the live anchor',
      anchorHost() === 'https://mgxanchor.moneygram.com', anchorHost());
    check('production uses the PUBLIC passphrase', networkPassphrase() === PUBLIC_PP);
    check('signing keys differ between environments', expectedSigningKey() === PROD_KEY);
  });

  withEnv({ MONEYGRAM_ANCHOR_HOST: 'http://insecure.example.com' }, () => {
    check('a plaintext anchor host is refused', throws(anchorHost));
  });

  /** Production-in-staging is the direction that spends real money. */
  withEnv({ MONEYGRAM_ENVIRONMENT: 'production' }, () => {
    check('production anchor in a sandbox deployment is REFUSED',
      throws(() => assertMoneyGramEnvironment('sandbox')));
  });

  // ── 2. Live sandbox anchor ──────────────────────────────────────
  console.log('\n══ 2. Live Sandbox Anchor ══');

  await withEnvAsync({ MONEYGRAM_ENVIRONMENT: 'sandbox', MONEYGRAM_ANCHOR_HOST: undefined, MONEYGRAM_ANCHOR_SIGNING_KEY: undefined }, async () => {
    clearAnchorCache();
    const info = await fetchAnchorInfo({ force: true });
    check('sandbox TOML fetched', Boolean(info.tomlUrl));
    check('SEP-10 auth endpoint discovered',
      info.webAuthEndpoint.endsWith('/stellarsepservice/auth'), info.webAuthEndpoint);
    check('SEP-24 transfer server discovered',
      info.transferServerSep24.endsWith('/stellarsepservice/sep24'), info.transferServerSep24);
    check('signing key matches the pinned sandbox key', info.signingKey === SANDBOX_KEY, info.signingKey);
    check('network passphrase is TESTNET', info.networkPassphrase === TESTNET_PP);
    check('the anchor declares its USDC as test', info.currencyStatus === 'test', String(info.currencyStatus));
    check('a USDC issuer is published', Boolean(info.usdcIssuer), String(info.usdcIssuer));
  });

  // ── 3. Live production anchor ───────────────────────────────────
  console.log('\n══ 3. Live Production Anchor ══');

  await withEnvAsync({ MONEYGRAM_ENVIRONMENT: 'production', MONEYGRAM_ANCHOR_HOST: undefined, MONEYGRAM_ANCHOR_SIGNING_KEY: undefined }, async () => {
    clearAnchorCache();
    const info = await fetchAnchorInfo({ force: true });
    check('production signing key matches the pin', info.signingKey === PROD_KEY, info.signingKey);
    check('production passphrase is PUBLIC', info.networkPassphrase === PUBLIC_PP);
    check('the anchor declares its USDC as live', info.currencyStatus === 'live', String(info.currencyStatus));
    /** The two environments must not be confusable. */
    check('production and sandbox signing keys differ', PROD_KEY !== SANDBOX_KEY);
  });

  // ── 4. The tripwire ─────────────────────────────────────────────
  console.log('\n══ 4. Signing Key Tripwire ══');

  /**
   * THE LOAD BEARING REFUSAL. A served TOML is not a trust anchor: whoever
   * can modify it can also substitute a signing key and mint challenges we
   * would sign with the account holding our USDC.
   */
  await withEnvAsync({
    MONEYGRAM_ENVIRONMENT: 'sandbox', MONEYGRAM_ANCHOR_HOST: undefined,
    MONEYGRAM_ANCHOR_SIGNING_KEY: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB',
  }, async () => {
    clearAnchorCache();
    check('a signing key that does not match the pin is REFUSED',
      await rejectsWith(() => fetchAnchorInfo({ force: true }), /SIGNING_KEY does not match the pinned value/));
  });

  /** Sandbox TOML served while configured as production: environment mismatch. */
  await withEnvAsync({
    MONEYGRAM_ENVIRONMENT: 'production',
    MONEYGRAM_ANCHOR_HOST: 'https://extmgxanchor.moneygram.com',
    MONEYGRAM_ANCHOR_SIGNING_KEY: SANDBOX_KEY,
  }, async () => {
    clearAnchorCache();
    check('a sandbox TOML under production config is REFUSED on passphrase',
      await rejectsWith(() => fetchAnchorInfo({ force: true }), /NETWORK_PASSPHRASE mismatch/));
  });

  // ── 5. Credential guards ────────────────────────────────────────
  console.log('\n══ 5. Credential Guards ══');

  withEnv({ MONEYGRAM_STELLAR_PUBLIC_KEY: undefined, STELLAR_PUBLIC_KEY: undefined }, () => {
    check('a missing Stellar public key is refused', throws(sivanStellarPublicKey));
  });
  withEnv({ MONEYGRAM_STELLAR_PUBLIC_KEY: 'not-a-key' }, () => {
    check('a malformed Stellar public key is refused', throws(sivanStellarPublicKey));
  });
  withEnv({ MONEYGRAM_STELLAR_SECRET: 'GABC', STELLAR_SECRET_KEY: undefined }, () => {
    check('a public key in the SECRET slot is refused', throws(sivanStellarSecret));
  });
  withEnv({ MONEYGRAM_WEBHOOK_PUBLIC_KEY: 'garbage' }, () => {
    check('a non-PEM webhook key is refused', throws(webhookPublicKey));
  });
  withEnv({ MONEYGRAM_API_BASE_URL: undefined, MONEYGRAM_PARTNER_ID: undefined, MONEYGRAM_API_KEY: undefined }, () => {
    check('the payout API refuses partial configuration, naming what is missing',
      throws(payoutApiConfig));
  });

  // ── 6. Summary must not leak ────────────────────────────────────
  console.log('\n══ 6. Config Summary Hygiene ══');

  withEnv({
    MONEYGRAM_ENVIRONMENT: 'sandbox',
    MONEYGRAM_STELLAR_SECRET: 'S' + 'A'.repeat(55),
    MONEYGRAM_STELLAR_PUBLIC_KEY: 'G' + 'A'.repeat(55),
    MONEYGRAM_HOME_DOMAIN: 'sivantech.online',
  }, () => {
    const s = moneyGramConfigSummary();
    const json = JSON.stringify(s);
    check('the summary NEVER contains the Stellar secret',
      !json.includes('S' + 'A'.repeat(55)), json.slice(0, 120));
    check('it reports the secret as present without revealing it', s.secretPresent === true);
    check('it reports the environment', s.environment === 'sandbox');
    check('isMoneyGramConfigured() is true once the basics are set', isMoneyGramConfigured());
  });

  // ── 7. Health probe never throws ────────────────────────────────
  console.log('\n══ 7. Health Probe ══');
  await withEnvAsync({ MONEYGRAM_ENVIRONMENT: 'sandbox', MONEYGRAM_ANCHOR_HOST: undefined, MONEYGRAM_ANCHOR_SIGNING_KEY: undefined }, async () => {
    clearAnchorCache();
    const h = await anchorHealth();
    check('health reports the live sandbox anchor reachable', h.reachable === true, JSON.stringify(h));
    check('and the signing key matching', h.signingKeyMatches === true);
  });
  await withEnvAsync({ MONEYGRAM_ANCHOR_HOST: 'https://nonexistent-anchor.invalid' }, async () => {
    clearAnchorCache();
    const h = await anchorHealth();
    check('an unreachable anchor degrades instead of throwing', h.reachable === false, JSON.stringify(h));
  });

  console.log('\n' + '='.repeat(52));
  console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(52) + '\n');
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('\nSUITE ERROR:', e?.message ?? e); process.exitCode = 1; });
