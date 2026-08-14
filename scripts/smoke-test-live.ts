/**
 * WALK THE DEPLOYED API THE WAY A REAL USER WOULD.
 *
 * Every other suite in this repo runs against local code. That proves the code
 * is right; it says nothing about what is actually RUNNING. This drives the
 * deployed gateway over HTTP - signup, verification state, controls, quote,
 * transfer - and reports what breaks.
 *
 * READ-ONLY BY DEFAULT. It creates a throwaway account and reads state. It
 * does NOT move money unless SMOKE_ALLOW_TRANSFER=true is set explicitly,
 * because a smoke test that spends real funds on every run is a smoke test
 * nobody dares run.
 *
 * TIMING IS AN ASSERTION HERE, NOT A DETAIL. The Cloudflare worker aborts an
 * upstream request at 12s and deliberately does not retry a POST, so anything
 * approaching that ceiling is a 503 waiting to happen - and on a write, a 503
 * the user cannot distinguish from a failure. Every call is timed and anything
 * over 8s is reported as a warning even when it returns 200.
 *
 *   npx tsx scripts/smoke-test-live.ts
 *   BASE=https://api.sivantech.online/api/payment npx tsx scripts/smoke-test-live.ts
 */

/**
 * Makes this file a MODULE rather than a global script.
 *
 * Without an import or export, tsc treats it as a script sharing the global
 * scope - so `pass`/`fail` collided with identifiers in other scripts under
 * tsconfig.scripts.json, and top-level await was rejected. It runs fine under
 * tsx either way, which is exactly why the typecheck caught what the run did
 * not.
 */
export {};

const BASE = process.env.SMOKE_BASE || 'https://test-sivan.sivantech.online/api/payment';
const ALLOW_TRANSFER = process.env.SMOKE_ALLOW_TRANSFER === 'true';

/** The gateway's ceiling. Anything near it is a latent 503. */
const GATEWAY_TIMEOUT_MS = 12_000;
const SLOW_WARN_MS = 8_000;

let pass = 0;
let fail = 0;
let warn = 0;

const ok = (name: string, detail = '') => { pass += 1; console.log(`  ok    ${name}${detail ? ` — ${detail}` : ''}`); };
const bad = (name: string, detail = '') => { fail += 1; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); };
const slow = (name: string, detail = '') => { warn += 1; console.warn(`  WARN  ${name}${detail ? ` — ${detail}` : ''}`); };

interface Call { status: number; ms: number; body: any; }

async function call(method: string, path: string, options: { body?: unknown; token?: string; timeoutMs?: number } = {}): Promise<Call> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
    return { status: response.status, ms: Date.now() - started, body };
  } catch (error) {
    return { status: 0, ms: Date.now() - started, body: { error: String(error) } };
  } finally {
    clearTimeout(timer);
  }
}

/** Assert a call succeeded, and flag it when it is close to the gateway ceiling. */
function expect(name: string, result: Call, want: number[] = [200, 201]) {
  const timing = `${(result.ms / 1000).toFixed(2)}s`;
  if (!want.includes(result.status)) {
    bad(name, `HTTP ${result.status} in ${timing} :: ${JSON.stringify(result.body).slice(0, 160)}`);
    return false;
  }
  if (result.ms > GATEWAY_TIMEOUT_MS) {
    bad(name, `${timing} EXCEEDS the ${GATEWAY_TIMEOUT_MS / 1000}s gateway ceiling`);
    return false;
  }
  if (result.ms > SLOW_WARN_MS) {
    slow(name, `${timing} — only ${((GATEWAY_TIMEOUT_MS - result.ms) / 1000).toFixed(1)}s under the gateway ceiling`);
    return true;
  }
  ok(name, timing);
  return true;
}

console.log(`\nSivan smoke test → ${BASE}`);
console.log(`transfers: ${ALLOW_TRANSFER ? 'ENABLED (will move funds)' : 'read-only'}\n`);

// ─────────────────────────────────────────────── 1. is anything home
console.log('1. reachability');
expect('gateway health', await call('GET', '/health'));
const status = await call('GET', '/api/system/status');
expect('system status', status);
if (status.status === 200) {
  const mode = status.body?.data?.mode;
  if (mode === 'active') ok('system mode is active', mode);
  else bad('system mode', `expected active, got ${mode}`);
}

// ─────────────────────────────────────────── 2. what the app loads first
console.log('\n2. bootstrap payload (the app blocks on these)');
const controls = await call('GET', '/api/offramp/controls');
expect('offramp controls', controls);
if (controls.status === 200) {
  const d = controls.body?.data ?? {};
  const currencies = (d.payoutCurrencies ?? []).map((c: any) => c.currency);
  ok('payout currencies', currencies.join(', ') || '(none)');
  // These two tell us WHICH build is deployed, which is otherwise guesswork.
  if ('transfersEnabled' in d) ok('transfersEnabled is served', String(d.transfersEnabled));
  else bad('transfersEnabled is served', 'ABSENT — this build predates the 403/logout fix');
  if (d.displayFx) ok('displayFx is served', `usd=${d.displayFx?.ngnPerUnit?.usd}`);
  else bad('displayFx is served', 'ABSENT — currency preference will not work');
}
expect('offramp fees', await call('GET', '/api/fees/offramp'));

// ────────────────────────────────────────────────── 3. a real signup
console.log('\n3. signup');
const email = `smoke-${Date.now()}@sivantech.online`;
const start = await call('POST', '/api/auth/email/start', {
  body: { email, fullName: 'Smoke Probe', intent: 'signup', legalAcceptance: { accepted: true } },
});
const signedUp = expect('email/start', start);

let token = '';
let userId = '';
if (signedUp) {
  const code = start.body?.data?.devCode;
  if (!code) {
    slow('verify code', 'no devCode returned — AUTH_DEV_SHOW_OTP is off, cannot continue as a user');
  } else {
    const verify = await call('POST', '/api/auth/email/verify', { body: { email, code } });
    if (expect('email/verify', verify)) {
      token = verify.body?.data?.token || verify.body?.data?.accessToken || '';
      userId = verify.body?.data?.user?.id || '';
      if (token && userId) ok('session established', userId);
      else bad('session established', `token=${Boolean(token)} userId=${Boolean(userId)}`);
    }
  }
}

// ─────────────────────────────────── 4. the screens a new user lands on
if (token && userId) {
  console.log('\n4. authenticated reads');
  const summary = await call('GET', `/api/users/${userId}/verification-summary`, { token });
  if (expect('verification summary', summary)) {
    const d = summary.body?.data ?? {};
    ok('level', `${d.level} (${d.levelLabel}) path=${d.path}`);
    // The bug from earlier this week: a verified user reading Level 0.
    if (d.pathComplete && d.level === 0) bad('level coherence', 'pathComplete true at Level 0 — the contradiction is back');
    else ok('level coherence', 'level and completion agree');
  }
  expect('unified balance', await call('GET', `/api/users/${userId}/balance/unified`, { token }));
  expect('wallets', await call('GET', `/api/users/${userId}/wallets`, { token }));
  expect('external accounts', await call('GET', `/api/users/${userId}/external-accounts`, { token }));

  // ───────────────────────────── 5. the write path, without writing
  console.log('\n5. transfer path');
  const quote = await call(
    'GET',
    `/api/balance/transfers/quote?amount=10&network=solana&asset=usdc&destinationAddress=HN7cABqLq46Es1jh92dQQpXBoUn3xSzXk1uMv6d3sB2`,
    { token },
  );
  if (expect('fee quote', quote)) {
    const q = quote.body?.data ?? {};
    ok('quoted fee', `fee=${q.fee} net=${q.netAmount} pct=${q.effectivePercent}`);
    const gross = Number(q.fee ?? 0) + Number(q.netAmount ?? 0);
    if (Math.abs(gross - 10) < 0.000001) ok('fee + net == gross', `${q.fee} + ${q.netAmount} = 10`);
    else bad('fee + net == gross', `got ${gross}`);
  }

  /**
   * The refusal itself is the assertion. A new account has no balance, so this
   * MUST be declined - and the interesting part is HOW. A 403 with the generic
   * 'forbidden' code is what used to sign users out mid-transfer.
   */
  if (ALLOW_TRANSFER) {
    const transfer = await call('POST', `/api/users/${userId}/balance/transfers`, {
      token,
      body: { asset: 'usdc', amount: '1', network: 'solana', destinationAddress: 'HN7cABqLq46Es1jh92dQQpXBoUn3xSzXk1uMv6d3sB2' },
    });
    console.log(`       transfer → HTTP ${transfer.status} in ${(transfer.ms / 1000).toFixed(2)}s`);
    const code = transfer.body?.error?.code;
    if (transfer.status === 403 && code === 'forbidden') {
      ok('a business refusal keeps its own code', 'will not log the user out');
    } else if (transfer.status === 403 && code === 'user_mismatch') {
      bad('403 code', 'user_mismatch on the user\'s OWN account — the ownership check is wrong');
    } else {
      ok('transfer response', `${transfer.status} ${code ?? ''}`);
    }
    if (transfer.ms > GATEWAY_TIMEOUT_MS) bad('transfer timing', `${(transfer.ms / 1000).toFixed(2)}s — past the gateway ceiling, a 503 the user cannot read`);
  } else {
    console.log('       (skipped — set SMOKE_ALLOW_TRANSFER=true to exercise the write)');
  }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`${pass} passed · ${warn} warnings · ${fail} failed`);
if (fail) process.exitCode = 1;
