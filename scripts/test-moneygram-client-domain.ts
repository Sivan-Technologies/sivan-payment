/**
 * SIVAN'S OWN stellar.toml VERSUS SIVAN'S OWN CONFIG.
 *
 * anchor-discovery verifies MoneyGram's toml. Nothing verified ours, and ours
 * is the other half of SEP-10. MoneyGram allowlists a domain and an account,
 * so three values must agree:
 *
 *   MONEYGRAM_HOME_DOMAIN         the domain we point MoneyGram at
 *   MONEYGRAM_STELLAR_PUBLIC_KEY  the account we sign challenges with
 *   SIGNING_KEY in the published toml
 *
 * When they drift, production SEP-10 is rejected by the anchor and nothing on
 * our side explains why. It looks like a MoneyGram outage.
 *
 * The parser tests run offline against fixtures. The alignment tests run
 * against the real published document at sivantech.online.
 */

import {
  parseTopLevelToml,
  sivanTomlUrl,
  fetchSivanToml,
  verifyClientDomain,
} from '../src/moneygram/service/client-domain.service.js';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`); }
}
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, a === b, `expected ${String(b)}, got ${String(a)}`);

function named(report: { checks: { name: string; ok: boolean; detail: string }[] }, n: string) {
  return report.checks.find((c) => c.name === n);
}

const LIVE_DOMAIN = 'www.sivantech.online';
const REDIRECTING_DOMAIN = 'sivantech.online';
const PUBLISHED_KEY = 'GC2U4MR5FDCOICAGDUQU5JAEOM4C4WQOCPB3NABMTYPLX56YCKC35N3V';

async function main() {
  console.log('\n== 1. URL construction is exact ==');
  eq('a bare domain becomes the SEP-1 path',
     sivanTomlUrl('example.test'),
     'https://example.test/.well-known/stellar.toml');
  eq('a scheme in the configured value is stripped, not doubled',
     sivanTomlUrl('https://example.test'),
     'https://example.test/.well-known/stellar.toml');
  eq('a trailing slash does not produce a double slash',
     sivanTomlUrl('example.test/'),
     'https://example.test/.well-known/stellar.toml');

  console.log('\n== 2. Only TOP LEVEL keys are read ==');

  /**
   * The parser must stop at the first table header. A SIGNING_KEY inside
   * [DOCUMENTATION] is not the document's signing key, and treating it as one
   * would authenticate against an attacker chosen value in a toml we do not
   * fully control.
   */
  const shadowed = `
VERSION="2.0.0"
SIGNING_KEY="GREAL"
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
ACCOUNTS=[
  "GONE",
  "GTWO"
]

[DOCUMENTATION]
SIGNING_KEY="GFAKE"
NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
`;
  const p = parseTopLevelToml(shadowed);
  eq('the top level SIGNING_KEY wins', p.signingKey, 'GREAL');
  eq('a SIGNING_KEY inside a table is ignored', p.signingKey === 'GFAKE', false);
  eq('the top level NETWORK_PASSPHRASE wins',
     p.networkPassphrase, 'Test SDF Network ; September 2015');
  eq('multi line ACCOUNTS arrays are read', p.accounts.length, 2);
  eq('the first account is parsed', p.accounts[0], 'GONE');

  const empty = parseTopLevelToml('[DOCUMENTATION]\nSIGNING_KEY="GFAKE"\n');
  eq('a document whose first line is a table yields no signing key',
     empty.signingKey, undefined);
  eq('and no accounts', empty.accounts.length, 0);

  console.log('\n== 3. The live published document ==');
  const doc = await fetchSivanToml({ domain: LIVE_DOMAIN, timeoutMs: 15_000 });
  eq('it is served', doc.httpStatus, 200);
  check('it is served as TOML, not as the SPA index.html',
        (doc.contentType ?? '').includes('toml'),
        `content-type ${doc.contentType}`);
  check('the body is not HTML',
        !/^\s*<!doctype html/i.test(doc.raw), doc.raw.slice(0, 60));
  eq('the published SIGNING_KEY is the one we expect', doc.signingKey, PUBLISHED_KEY);

  console.log('\n== 4. Drift between config and the published toml is caught ==');

  process.env.MONEYGRAM_STELLAR_PUBLIC_KEY = PUBLISHED_KEY;
  const aligned = await verifyClientDomain({ domain: LIVE_DOMAIN, timeoutMs: 15_000 });
  check('an aligned deployment reports ok', aligned.ok, JSON.stringify(aligned.problems));
  check('the signing key check passes',
        named(aligned, 'signing_key_matches_config')?.ok === true,
        named(aligned, 'signing_key_matches_config')?.detail);

  // The failure this whole module exists to catch.
  process.env.MONEYGRAM_STELLAR_PUBLIC_KEY =
    'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const drifted = await verifyClientDomain({ domain: LIVE_DOMAIN, timeoutMs: 15_000 });
  check('a mismatched signing key makes the report fail', !drifted.ok);
  const sk = named(drifted, 'signing_key_matches_config');
  check('the mismatch is reported on the signing key check', sk?.ok === false, sk?.detail);
  check('the message names BOTH keys so the fix is obvious',
        Boolean(sk && sk.detail.includes(PUBLISHED_KEY) &&
                sk.detail.includes('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN')),
        sk?.detail);
  process.env.MONEYGRAM_STELLAR_PUBLIC_KEY = PUBLISHED_KEY;

  console.log('\n== 5. A redirecting home domain is reported, not tolerated ==');

  /**
   * The apex really does 308 to www while the file claims to be hosted at the
   * apex. SEP-1 does not require a client to follow redirects, so this is a
   * genuine production risk rather than a cosmetic one.
   */
  const viaApex = await verifyClientDomain({ domain: REDIRECTING_DOMAIN, timeoutMs: 15_000 });
  const rd = named(viaApex, 'served_without_redirect');
  check('the redirect from the apex is detected', rd?.ok === false, rd?.detail);
  check('the advice names the environment variable to change',
        Boolean(rd && rd.detail.includes('MONEYGRAM_HOME_DOMAIN')), rd?.detail);
  check('a redirecting domain makes the whole report fail', !viaApex.ok);

  const direct = named(await verifyClientDomain({ domain: LIVE_DOMAIN, timeoutMs: 15_000 }),
                       'served_without_redirect');
  check('the host that serves it directly passes the same check', direct?.ok === true,
        direct?.detail);

  console.log('\n== 6. Environment passphrase drift is caught ==');

  /**
   * The published passphrase is the testnet one, which is right today and
   * becomes wrong the moment the environment flips. A static file does not
   * change when an environment variable does.
   */
  const prev = process.env.MONEYGRAM_ENVIRONMENT;
  process.env.MONEYGRAM_ENVIRONMENT = 'production';
  const prod = await verifyClientDomain({ domain: LIVE_DOMAIN, timeoutMs: 15_000 });
  const np = named(prod, 'network_passphrase_matches_environment');
  check('switching to production flags the testnet passphrase', np?.ok === false, np?.detail);
  check('the message quotes the expected passphrase',
        Boolean(np && np.detail.includes('Public Global Stellar Network')), np?.detail);
  if (prev === undefined) delete process.env.MONEYGRAM_ENVIRONMENT;
  else process.env.MONEYGRAM_ENVIRONMENT = prev;

  const sandbox = named(await verifyClientDomain({ domain: LIVE_DOMAIN, timeoutMs: 15_000 }),
                        'network_passphrase_matches_environment');
  check('and it passes again in sandbox', sandbox?.ok === true, sandbox?.detail);

  console.log('\n== 7. An unreachable domain reports rather than throws ==');
  const dead = await verifyClientDomain({
    domain: 'stellar-toml-does-not-exist.sivantech.online',
    timeoutMs: 8_000,
  });
  check('an unresolvable host does not throw', dead.ok === false);
  check('and it says which URL failed',
        dead.problems.some((x) => x.includes('.well-known/stellar.toml')),
        JSON.stringify(dead.problems));

  console.log(`\nPassed ${passed}, failed ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nSUITE CRASHED:', err?.message ?? err);
  process.exit(1);
});
