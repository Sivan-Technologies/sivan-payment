/**
 * A MISCONFIGURED KEY QUORUM MUST NOT SAY "PLEASE TRY AGAIN".
 *
 * Live, reported 2026-08-05 via Sentry (event 5d243213ad1b434983e3466c546c4693,
 * release 3374ead, environment production):
 *
 *     POST /api/users/usr_4a2884af-.../wallets  503
 *     "We could not create your wallet on this network right now.
 *      Please try again or contact support."
 *
 * ROOT CAUSE, established against the real Privy API rather than reasoned about:
 *
 *   1. GET /health/operational on sivan-payments-api-live-cgqi reported
 *        wallet_provider_reachable: CRITICAL
 *        PRIVY_AUTHORIZATION_KEY_QUORUM_ID "4852a189a600d3364dff80f4c1ffa597"
 *        is not usable by this app (404: Key quorum not found)
 *
 *   2. GET /v1/key_quorums/4852a189a600d3364dff80f4c1ffa597 on app
 *      cms5yve2000rv0cl1m2xk4ejo -> 404 "Key quorum not found".
 *      The two documented quorums both -> 200:
 *        l7t1bfi2oudgbebdszhkkt65  "sivan-production"
 *        dx66hdbkkv1tm82jpyort0pq  "sivan-base-e2e"
 *      So the live value is neither. It is not a quorum of this app at all.
 *
 *   3. POST /v1/wallets with that id in additional_signers ->
 *        400 {"error":"Unable to find the specified key quorums for this app...",
 *             "code":"invalid_data"}
 *      which is the exact 4xx the live route was turning into the message above.
 *
 * TWO SEPARATE FAULTS, and the second is the one code can fix:
 *
 *   FAULT A (operational): the env var on live is wrong. Fixed by setting it.
 *   FAULT B (code): a permanent misconfiguration was presented as transient.
 *     "Please try again" is false when the input is an environment variable -
 *     the hundredth attempt fails identically to the first - and the response
 *     carried nothing naming the variable, so retries were the only affordance
 *     offered to user and operator alike.
 *
 * This suite covers FAULT B, and the boot preflight that would have surfaced
 * FAULT A in the deploy log instead of in a user's browser.
 *
 * Run: npm run test:wallet-quorum-misconfiguration
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

// Set BEFORE importing the provider: env.ts snapshots process.env at load.
process.env.PRIVY_APP_ID = 'app_under_test';
process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID = '4852a189a600d3364dff80f4c1ffa597';

const { privyError } = await import('../src/wallets/provider/privy-wallet.provider.js');
const { AppError } = await import('../src/shared/errors.js');

/** Privy's verbatim body, captured from the live API on 2026-08-05. */
const PRIVY_QUORUM_400 =
  'Unable to find the specified key quorums for this app. Please ensure the input(s) '
  + 'is a valid key quorum ID, which can be found in your Privy dashboard.';

console.log('\n── the quorum failure is recognised as its own thing ─────────');

const quorum = privyError(400, PRIVY_QUORUM_400);
const genericBadRequest = privyError(400, 'chain_type must be one of ethereum, solana');

check('it is an AppError, so app.ts will not collapse it into a 500',
  quorum instanceof AppError,
  'a plain Error falls through to `err.statusCode ?? 500`');
check('it is a 503, not a 500 and not a 400',
  quorum.statusCode === 503,
  String(quorum.statusCode));

/**
 * THE CENTRAL ASSERTION.
 *
 * Both are 400s from Privy. One is worth retrying, one can never succeed.
 * If these two produce the same message the fix has not happened.
 */
check('it does NOT reuse the generic 4xx message',
  quorum.message !== genericBadRequest.message,
  `both said: ${quorum.message}`);
check('it does not tell the user to try again',
  !/try again/i.test(quorum.message),
  quorum.message);
check('the generic 4xx still DOES say try again, because that one may pass',
  /try again/i.test(genericBadRequest.message),
  genericBadRequest.message);

console.log('\n── the response names what an operator must change ───────────');

const details = quorum.details as Record<string, unknown>;

check('details name the environment variable',
  details?.misconfiguration === 'PRIVY_AUTHORIZATION_KEY_QUORUM_ID',
  JSON.stringify(details?.misconfiguration));
check('details carry the offending quorum id',
  details?.configuredQuorumId === '4852a189a600d3364dff80f4c1ffa597',
  JSON.stringify(details?.configuredQuorumId));
check('details carry the app id it was rejected by',
  details?.privyAppId === 'app_under_test',
  'a quorum id is only meaningful against an app id - one without the other cannot be diagnosed');
check('details say retrying cannot help',
  /Retrying cannot help/i.test(String(details?.fix ?? '')),
  String(details?.fix));
check('details explain quorum ids are per-app',
  /per-app/i.test(String(details?.fix ?? '')),
  'the usual cause is copying test env values into production');
check("Privy's raw text is preserved for support",
  String(details?.providerMessage ?? '').includes('key quorum'),
  String(details?.providerMessage));

console.log('\n── the user-facing half leaks nothing ────────────────────────');

check('the message does not name Privy',
  !/privy/i.test(quorum.message),
  quorum.message);
check('the message does not quote the quorum id',
  !quorum.message.includes('4852a189'),
  'an env var id on a consumer screen is noise to the user and a hint to everyone else');
check('the message says the team is notified, since the user can do nothing',
  /notified/i.test(quorum.message),
  quorum.message);

console.log('\n── it does not swallow the fault by dropping the signer ──────');

/**
 * The tempting "fix" is to retry without additional_signers so the user gets
 * SOMETHING. That is far worse: a signer cannot be attached after creation
 * (PATCH requires the owner's signature, which Sivan does not hold), so every
 * wallet minted during the outage would be permanently undelegatable and no
 * off-ramp could ever sign for it. A loud failure is recoverable; a silent
 * one mints unusable wallets that cost money and cannot be deleted.
 */
const providerCode = strip(read('src/wallets/provider/privy-wallet.provider.ts'));
const createBody = providerCode.slice(
  providerCode.indexOf('async createWallet'),
  providerCode.indexOf('async ensurePrivyUser')
);
check('createWallet has exactly one POST /wallets call',
  (createBody.match(/privyRequest<any>\('\/wallets'/g) ?? []).length === 1,
  'a second one would be a silent retry without the signer');
check('additional_signers is included whenever a quorum is configured',
  /\.\.\.\(quorumId \? \{ additional_signers/.test(createBody));

console.log('\n── boot preflight: the deploy log says it before a user does ──');

const serverCode = strip(read('src/server.ts'));

check('server.ts probes the wallet provider at startup',
  /probePrivyCredentials/.test(serverCode),
  'the fact was available at boot via one authenticated GET; nothing asked until a user did');
check('a failed preflight is reported to Sentry',
  /captureError\(new Error\(detail\), \{ source: 'startup_wallet_preflight'/.test(serverCode),
  'a deploy log scrolls away');
check('the preflight only runs when privy is the active provider',
  /resolveActiveWalletProvider\(\)\) !== 'privy'\) return/.test(serverCode));
check('the preflight cannot crash the process',
  /catch \(error\) \{[\s\S]{0,200}preflight itself failed/.test(serverCode));

/**
 * NON-FATAL IS A BEHAVIOUR, NOT A COMMENT.
 *
 * Asserted by booting the real server with a quorum id that does not exist and
 * confirming it still serves traffic. A source-level check would pass even if
 * the preflight threw before listen().
 */
const port = 4171;
const child = spawn(
  process.execPath,
  ['--import', 'tsx', path.join(root, 'src/server.ts')],
  {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      APP_ENV: 'staging',
      DATABASE_PROVIDER: 'json',
      DATABASE_FILE: '.data/test-quorum-misconfig.json',
      EMAIL_PROVIDER: 'console',
      SUPPORT_UPLOAD_PROVIDER: 'mock',
      WALLET_PROVIDER: 'privy',
      ADMIN_API_KEY: 'quorum-misconfig-admin-key',
      USER_JWT_SECRET: 'quorum-misconfig-jwt-secret-value-long-enough',
      RATE_LIMIT_ENABLED: 'false',
      PRIVY_APP_ID: 'app_that_does_not_exist',
      PRIVY_APP_SECRET: 'secret_that_does_not_authenticate',
      PRIVY_AUTHORIZATION_KEY_QUORUM_ID: '4852a189a600d3364dff80f4c1ffa597',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);

let output = '';
child.stdout.on('data', (chunk) => { output += String(chunk); });
child.stderr.on('data', (chunk) => { output += String(chunk); });

async function waitForListen(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ping`);
      if (response.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

let exited: number | null = null;
child.on('exit', (code) => { exited = code ?? -1; });

const listening = await waitForListen(45_000);
check('the API boots and serves traffic with an unusable quorum',
  listening,
  'refusing to boot would take NGN, balances and support down over a fault in ONE route');

if (listening) {
  // Give the fire-and-forget preflight a moment to land.
  await new Promise((resolve) => setTimeout(resolve, 5000));

  check('the boot log names wallet creation as broken',
    /WALLET CREATION WILL FAIL/.test(output),
    output.split('\n').filter((line) => /startup\.wallet_provider/.test(line)).join(' | ') || '(no preflight line)');

  /**
   * MEASURED AFTER THE PREFLIGHT HAS RUN, not before.
   *
   * The first version of this suite asserted only that the server reached a
   * listening state, and that assertion survived a mutation that added
   * `process.exit(1)` to the failure path - because listen() wins the race
   * against a network probe every time. It reported a healthy result for a
   * server that had already killed itself, which is precisely the class of
   * decorative test this file exists to avoid.
   *
   * So: assert liveness on the far side of the preflight, and assert it
   * against the process AND the socket. A crash-looping Render service over
   * a fault in one route is the outcome being prevented.
   */
  check('the process is still alive after the preflight failed',
    exited === null,
    `exited with code ${exited}`);

  let stillServing = false;
  try {
    stillServing = (await fetch(`http://127.0.0.1:${port}/ping`)).ok;
  } catch { stillServing = false; }
  check('and it is still serving requests unrelated to wallets',
    stillServing,
    'the other routes must not be taken down by a wallet misconfiguration');
}

child.kill('SIGKILL');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
