/**
 * THE HEALTH SHORTCUT MUST NOT BE AN AUTH BYPASS.
 *
 * Found live on api.sivantech.online while trying to read KYC provider health:
 *
 *   GET /api/admin/ngn/controls           -> 401  (correct)
 *   GET /api/admin/ngn/controls?q=health  -> 200  (auth skipped entirely)
 *
 * The preHandler in app.ts tested `url.includes('health')` - a substring over
 * the WHOLE url, query string included - and returned before the admin key
 * check below it. Six appended characters skipped authentication on any admin
 * route.
 *
 * The second, quieter cost: any real admin route whose path contains "health"
 * could never execute. /api/admin/kyc/ngn/provider-health - the endpoint that
 * reports whether Monnify and Flutterwave can answer a BVN check - returned a
 * hardcoded {"status":"ok"} instead of real provider status. A dead KYC vendor
 * looked healthy.
 *
 * WHY THESE ASSERTIONS ARE SHAPED AS THEY ARE. The dangerous outcome is a 200
 * where a 401 belongs, so the load-bearing checks assert the REFUSAL. A suite
 * that only checked "/health returns 200" would have passed throughout the
 * entire period the bypass was live.
 *
 * Run: npx tsx scripts/test-admin-health-bypass.ts
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.SIVAN_DATA_FILE = '/tmp/health-bypass-test.json';
process.env.DATABASE_FILE = '/tmp/health-bypass-test.json';
process.env.ADMIN_API_KEY = 'test_admin_key_for_bypass_suite';
process.env.EMAIL_PROVIDER = 'console';
process.env.WALLET_PROVIDER = 'mock';
process.env.NGN_PROVIDER = 'mock';

import fs from 'node:fs';

let pass = 0;
let fail = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
};

const NOW = new Date().toISOString();
fs.writeFileSync(process.env.SIVAN_DATA_FILE!, JSON.stringify({
  users: [], customers: [], withdrawals: [], onrampOrders: [], ngnTransfers: [],
  virtualAccountTransactions: [], walletDeposits: [], supplierPayments: [],
  externalAccounts: [], ngnPayoutAccounts: [], supportTickets: [], systemIncidents: [],
  webhookEvents: [], transactionReferences: [], reconciliationFindings: [],
  aceSupportSessions: [], aceSupportMessages: [], aceToolCalls: [], aceResolutions: [],
  auditLogs: [], paymentControls: [], ngnControls: [], systemStatus: [], updatedAt: NOW,
}, null, 2));

const { buildApp } = await import('../src/app.js');
const app = await buildApp();
await app.ready();

const get = async (url: string, headers: Record<string, string> = {}) => {
  const res = await app.inject({ method: 'GET', url, headers });
  return { status: res.statusCode, body: res.body };
};

console.log('\n══ 1. the bypass itself ═══════════════════════════════════');

/**
 * THE REPORTED DEFECT. Identical route, one with "health" in the query.
 * Both must refuse: a query parameter is not a route.
 */
const plain = await get('/api/admin/ngn/controls');
check('an admin route without a key is refused',
  plain.status === 401, `${plain.status} ${plain.body.slice(0, 80)}`);

const withQuery = await get('/api/admin/ngn/controls?q=health');
check('and appending ?q=health does NOT skip the key check',
  withQuery.status === 401,
  `${withQuery.status} - six characters bypassed auth on a live admin route`);

check('the two answers are identical, so the query cannot matter',
  plain.status === withQuery.status, `${plain.status} vs ${withQuery.status}`);

/** The same trick in a path segment rather than the query. */
const inPath = await get('/api/admin/users/health-insurance-corp/limits');
check('a user id containing "health" does not skip the key check',
  inPath.status === 401, `${inPath.status} ${inPath.body.slice(0, 80)}`);

const encoded = await get('/api/admin/ngn/controls?redirect=%2Fhealth');
check('a url-encoded "health" in the query does not skip it either',
  encoded.status === 401, String(encoded.status));

console.log('\n══ 2. real admin health routes are no longer shadowed ═════');

/**
 * These are REGISTERED routes that the substring branch swallowed. They must
 * now reach their own handler, which means they must demand a key like any
 * other admin route - a 401 here is SUCCESS, because it proves the request
 * got past the shortcut and into the auth check.
 */
const providerHealth = await get('/api/admin/kyc/ngn/provider-health');
check('/api/admin/kyc/ngn/provider-health reaches auth, not the shortcut',
  providerHealth.status === 401,
  `${providerHealth.status} ${providerHealth.body.slice(0, 90)} - a 200 here is the fake payload`);
check('and it does NOT return the hardcoded sivan-payments-admin stub',
  !providerHealth.body.includes('sivan-payments-admin'),
  providerHealth.body.slice(0, 90));

const walletsHealth = await get('/api/admin/wallets/health');
check('/api/admin/wallets/health reaches auth, not the shortcut',
  walletsHealth.status === 401, String(walletsHealth.status));

/** With a key, the real handler must actually run. */
const authed = await get('/api/admin/kyc/ngn/provider-health', {
  'x-admin-api-key': process.env.ADMIN_API_KEY!,
});
check('with a valid key the REAL provider-health handler answers',
  authed.status === 200, `${authed.status} ${authed.body.slice(0, 90)}`);
check('and its body is real provider data, not the stub',
  !authed.body.includes('sivan-payments-admin'),
  authed.body.slice(0, 120));

console.log('\n══ 3. genuine health probes still work unauthenticated ════');

/**
 * The shortcut exists for load balancers and uptime monitors. Breaking those
 * to close the hole would be trading one outage for another.
 */
for (const path of ['/health', '/api/admin/health', '/api/admin/payment/health']) {
  const res = await get(path);
  check(`${path} answers 200 without a key`, res.status === 200, String(res.status));
}

/**
 * METHOD MATTERS. The shortcut is for probes, which are GET/HEAD. A POST to a
 * health path is not a probe and must not be waved through.
 */
const posted = await app.inject({ method: 'POST', url: '/api/admin/health' });
check('POST to a health path is not treated as a probe',
  posted.statusCode !== 200, String(posted.statusCode));

console.log('\n══ 4. the allowlist is exact, not a prefix ════════════════');

/**
 * Set.has() is an exact match, but assert it: a future refactor to
 * startsWith() would silently reopen a narrower version of the same hole.
 */
const suffixed = await get('/api/admin/health/../ngn/controls');
check('a path that merely starts with a health path is not waved through',
  suffixed.status !== 200 || !suffixed.body.includes('sivan-payments-admin'),
  `${suffixed.status} ${suffixed.body.slice(0, 80)}`);

const nearMiss = await get('/api/admin/healthz');
check('a near-miss path is not waved through',
  nearMiss.status !== 200 || !nearMiss.body.includes('sivan-payments-admin'),
  `${nearMiss.status} ${nearMiss.body.slice(0, 80)}`);

await app.close();

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (failures.length) console.log(`   ${failures.join('\n   ')}`);
process.exit(fail === 0 ? 0 : 1);
