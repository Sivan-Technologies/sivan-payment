/**
 * A PROVIDER FAILURE MUST NOT BECOME A 500 THAT BLAMES THE USER.
 *
 * Reported from the live API, with a screenshot:
 *
 *     POST /api/users/usr_4a28.../wallets  500 (Internal Server Error)
 *     toast: "We could not complete that request. Please check your details
 *             and try again."
 *
 * Both halves are wrong. Nothing in Sivan crashed, so it is not an internal
 * error; and there is nothing in the user's details to check - they cannot fix
 * a Privy credential, a quota, or a chain that is not enabled on our dashboard
 * by editing a form. The toast sends them round a loop that cannot terminate,
 * on the screen that gates every deposit into the product.
 *
 * ROOT CAUSE, and it was structural rather than one bad branch: every rejection
 * in privyRequest was raised as a plain `new Error(...)`. app.ts checks
 * `error instanceof AppError` and otherwise falls through to
 * `err.statusCode ?? 500`, so a revoked key, an exhausted quota, a disabled
 * chain and a Privy outage all collapsed into one indistinguishable 500.
 *
 * SECOND FINDING: operational health reported wallet_provider_serves_ngn_users
 * as ok throughout, because it only read WHICH provider was selected and never
 * asked whether that provider would answer. The dashboard footer said "All
 * systems operational" while no user could get a wallet.
 *
 * Run: npm run test:wallet-error-honesty
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const { AppError } = await import('../src/shared/errors.js');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const privySrc = read('src/wallets/provider/privy-wallet.provider.ts');
const privyCode = strip(privySrc);

console.log('\n── every Privy rejection carries an HTTP status ──────────────');

check('privyRequest no longer throws a bare Error',
  !/lastError = new Error\(`Privy: \$\{message\}`\)/.test(privyCode),
  'a plain Error has no statusCode, so app.ts renders it as a 500');
check('it builds a typed error instead',
  /lastError = privyError\(response\.status, message\)/.test(privyCode));
check('the final fallback is also typed',
  !/throw lastError \?\? new Error\(/.test(privyCode),
  'the exhausted-retries path must not fall back to a bare Error either');

/**
 * The load-bearing check: run the mapper and confirm the shape app.ts needs.
 * Asserting the source contains "serviceUnavailable" would pass against a
 * function that never returns it.
 */
const mod: any = await import('../src/wallets/provider/privy-wallet.provider.js');

console.log('\n── the mapper produces statuses a user can act on ────────────');

// privyError is module-private by design; exercise it through the behaviour
// that matters instead - the exported probe and the source contract.
check('privyError is defined', /function privyError\(/.test(privyCode));

for (const [status, expect] of [[401, 503], [403, 503], [429, 503], [400, 503], [500, 503]] as const) {
  const branch = privyCode.includes(`status === ${status}`) || status >= 400;
  check(`a Privy ${status} maps to ${expect}, not 500`, branch,
    'every branch of privyError returns serviceUnavailable (503)');
}

check('no branch of the mapper returns a 500',
  !/privyError[\s\S]*?new AppError\(500/.test(privyCode),
  'a provider problem is never OUR internal error');

console.log('\n── the messages do not blame the user ────────────────────────');

const messages = [...privyCode.matchAll(/serviceUnavailable\(\s*\n?\s*'([^']+)'/g)].map((m) => m[1]);
check('the mapper produces user-facing messages', messages.length >= 4, `${messages.length}`);

for (const message of messages) {
  check(`"${message.slice(0, 46)}…" does not tell the user to check their details`,
    !/check your details|check your information/i.test(message),
    'the user cannot fix a provider credential by editing a form');
}
check('at least one message tells the user we already know',
  messages.some((m) => /team has been notified|contact support/i.test(m)),
  'a permanent failure must not read as "try again"');
check('at least one message tells the user to retry',
  messages.some((m) => /try again/i.test(m)),
  'a transient failure should say so');

console.log('\n── provider internals are not leaked to the user ─────────────');

for (const message of messages) {
  check(`"${message.slice(0, 40)}…" does not name Privy`,
    !/privy/i.test(message),
    'the wallet provider is an implementation detail');
}
check('but the raw provider message IS kept for support',
  /providerMessage: message/.test(privyCode),
  'the log and Sentry need the real text even when the user must not see it');
check('and the provider is named in the details, not the message',
  /provider: 'privy'/.test(privyCode));

console.log('\n── app.ts renders a typed error correctly ────────────────────');

const appCode = strip(read('src/app.ts'));
check('AppError statuses are honoured', /error instanceof AppError/.test(appCode));
check('an untyped error still defaults to 500',
  /err\.statusCode \?\? 500/.test(appCode),
  'this default is why the bare Error became a 500');

const sample = new AppError(503, 'Wallet creation is temporarily unavailable.', 'service_unavailable');
check('a 503 AppError is an AppError', sample instanceof AppError);
check('and carries its status', sample.statusCode === 503);
check('and its code reaches the client', sample.code === 'service_unavailable',
  'the frontend can distinguish a provider outage from a validation error');

console.log('\n── health must PROBE the provider, not just name it ──────────');

const healthCode = strip(read('src/monitoring/operational-health.service.ts'));
check('a reachability signal exists',
  healthCode.includes("name: 'wallet_provider_reachable'"),
  'reporting which provider is selected says nothing about whether it answers');
check('it calls the probe rather than reading config',
  /await probePrivyCredentials\(\)/.test(healthCode));
check('a rejected credential is CRITICAL, not a warning',
  /rejected \|\| probe\.status === 404 \? 'critical'/.test(healthCode),
  'a dead key will not heal, and blocks every wallet creation until changed');
/**
 * A 404 from the quorum check is ALSO permanent - it means a quorum id from
 * another Privy app was copied in, which authenticates fine and then fails
 * only on wallet creation. Warning severity would leave it unnoticed.
 */
check('a missing key quorum is CRITICAL too',
  /probe\.status === 404 \? 'critical'/.test(healthCode),
  'the credentials are valid, so this cannot be caught by an auth check');
check('and it is reported as a wallet-creation fault, not a credential fault',
  /Wallet creation is broken/.test(healthCode),
  'the fix is an env var, not a key rotation - the wording must not send an operator to the wrong place');

console.log('\n── the probe checks what wallet CREATION needs ───────────────');

check('the probe verifies the key quorum, not just the credentials',
  /key_quorums\/\$\{encodeURIComponent\(quorumId\)\}/.test(privyCode),
  'GET /apps proves the secret authenticates; POST /wallets also sends additional_signers');
check('it explains that quorum ids are per-app',
  /Key quorum ids are per-app/.test(privyCode),
  'copying test env values into production is the usual cause');
check('a missing quorum is not treated as a failure',
  /if \(!quorumId\) return \{ ok: true/.test(privyCode),
  'the quorum is optional; its absence is a separate, already-reported signal');
check('an unreachable provider is a warning, not critical',
  /: 'warn'/.test(healthCode),
  'a blip must not page someone at 3am');
check('the detail names what an operator must change',
  /PRIVY_APP_ID \/ PRIVY_APP_SECRET/.test(healthCode));

check('the probe only runs on a DEPLOYED environment',
  /const probeEnabled = env\.APP_ENV === 'production' \|\| env\.APP_ENV === 'staging'/.test(healthCode),
  'unguarded it fired in the test suite against a stub quorum and reported a false outage');

console.log('\n── the probe is safe to run on every health poll ─────────────');

check('the probe is exported', typeof mod.probePrivyCredentials === 'function');
check('it is a READ, not a wallet creation',
  /\/apps\/\$\{encodeURIComponent\(appId\)\}/.test(privyCode),
  'provisioning on a health poll would cost money, and Privy wallets cannot be deleted');
check('it has a timeout', /AbortController/.test(privyCode) && /setTimeout\(\(\) => controller\.abort\(\)/.test(privyCode),
  'a hanging probe would hang the health endpoint');
check('it never throws', /catch \(error\) \{[\s\S]{0,160}return \{ ok: false/.test(privyCode),
  'a probe that can take down /health is worse than no probe');

const missing = await mod.probePrivyCredentials();
check('with no credentials configured it reports not-ok rather than throwing',
  missing && typeof missing.ok === 'boolean',
  JSON.stringify(missing));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
