/**
 * PAYSTACK CONFIG AND DVA TYPE GUARDS.
 *
 * Step 1 of the multichain-v2 Paystack path. These are configuration tests,
 * so they run entirely offline: no Paystack call, no key required.
 *
 * The assertions that matter most are the refusals. A live secret key loaded
 * into a staging deployment creates REAL bank accounts against REAL customer
 * BVNs and moves REAL money, and nothing in a Paystack response distinguishes
 * that from a test run. Everything else here is hygiene by comparison.
 */

import {
  paystackSecretKey,
  paystackPublicKey,
  paystackWebhookSecret,
  webhookSecretIsOverridden,
  paystackBaseUrl,
  paystackMode,
  isPaystackLive,
  isPaystackConfigured,
  assertPaystackConfigured,
  assertPaystackModeMatches,
  paystackHeaders,
  PAYSTACK_WEBHOOK_IPS,
} from '../src/config/paystackConfig.js';
import { isPaystackSuccess } from '../src/virtual-accounts/types/paystackDvaTypes.js';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✅ ok - ${name}`);
  } else {
    failed++;
    console.log(`  ❌ FAIL - ${name}${detail ? `  (${detail})` : ''}`);
  }
}

function throws(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}

/** Run fn with a temporary env, always restoring afterwards. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fn(); } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const TEST_SK = 'sk_test_' + 'a'.repeat(40);
const LIVE_SK = 'sk_live_' + 'b'.repeat(40);
const TEST_PK = 'pk_test_' + 'c'.repeat(40);

function main() {
  console.log('\n' + '='.repeat(50));
  console.log('🔷 SIVAN PAYSTACK CONFIG TEST SUITE');
  console.log('='.repeat(50));

  // ── 1. Credentials are required, never defaulted ────────────────
  console.log('\n══ 1. No Hardcoded Credentials ══');

  withEnv({ PAYSTACK_SECRET_KEY: undefined }, () => {
    check('a missing secret key throws rather than defaulting', throws(paystackSecretKey));
    check('isPaystackConfigured() reports false without throwing', isPaystackConfigured() === false);
  });

  withEnv({ PAYSTACK_SECRET_KEY: TEST_SK }, () => {
    check('a valid test secret key is accepted', paystackSecretKey() === TEST_SK);
    check('isPaystackConfigured() reports true', isPaystackConfigured() === true);
  });

  /**
   * Pasting the public key into the secret slot is a common mistake and
   * produces a 401 that reads like a Paystack outage. Named explicitly.
   */
  withEnv({ PAYSTACK_SECRET_KEY: TEST_PK }, () => {
    check('a PUBLIC key in the secret slot is refused', throws(paystackSecretKey));
  });

  /** The reverse is worse: shipping a secret key to a browser. */
  withEnv({ PAYSTACK_PUBLIC_KEY: TEST_SK }, () => {
    check('a SECRET key in the public slot is refused', throws(paystackPublicKey));
  });

  withEnv({ PAYSTACK_SECRET_KEY: 'not-a-key' }, () => {
    check('a malformed secret key is refused', throws(paystackSecretKey));
  });

  // ── 2. Live vs test separation, the money-losing one ────────────
  console.log('\n══ 2. Live and Test Separation ══');

  withEnv({ PAYSTACK_SECRET_KEY: LIVE_SK }, () => {
    check('mode is derived from the key prefix, not a separate flag', paystackMode() === 'live');
    check('isPaystackLive() is true for sk_live_', isPaystackLive() === true);
    /**
     * THE CRITICAL REFUSAL. A live key in a staging deployment creates real
     * bank accounts against real BVNs. Nothing in the API response would
     * reveal the mistake.
     */
    check('a LIVE key in an environment expecting test is REFUSED',
      throws(() => assertPaystackModeMatches('test')));
    check('a LIVE key in an environment expecting live is allowed',
      !throws(() => assertPaystackModeMatches('live')));
  });

  withEnv({ PAYSTACK_SECRET_KEY: TEST_SK }, () => {
    check('mode is test for sk_test_', paystackMode() === 'test');
    check('a TEST key in an environment expecting live is refused',
      throws(() => assertPaystackModeMatches('live')));
  });

  // ── 3. Webhook secret, where the spec was wrong ─────────────────
  console.log('\n══ 3. Webhook Secret ══');

  /**
   * Paystack does NOT issue a separate webhook secret. x-paystack-signature
   * is HMAC SHA512 of the raw body signed with the SECRET KEY. Defaulting to
   * anything else makes every genuine webhook fail verification.
   */
  withEnv({ PAYSTACK_SECRET_KEY: TEST_SK, PAYSTACK_WEBHOOK_SECRET: undefined }, () => {
    check('webhook secret defaults to the SECRET KEY, which is what Paystack signs with',
      paystackWebhookSecret() === TEST_SK);
    check('and reports that it is not overridden', webhookSecretIsOverridden() === false);
  });

  withEnv({ PAYSTACK_SECRET_KEY: TEST_SK, PAYSTACK_WEBHOOK_SECRET: 'internal-relay-secret' }, () => {
    check('an explicit override is honoured for internal service relays',
      paystackWebhookSecret() === 'internal-relay-secret');
    check('and is reported as overridden, so it can be surfaced in health output',
      webhookSecretIsOverridden() === true);
  });

  // ── 4. Base URL ─────────────────────────────────────────────────
  console.log('\n══ 4. Base URL ══');

  withEnv({ PAYSTACK_BASE_URL: undefined }, () => {
    check('defaults to the documented Paystack host', paystackBaseUrl() === 'https://api.paystack.co');
  });
  withEnv({ PAYSTACK_BASE_URL: 'https://sandbox.example.com/' }, () => {
    check('an override wins over the default', paystackBaseUrl().startsWith('https://sandbox.example.com'));
    check('a trailing slash is stripped, since Paystack 404s on a double slash',
      paystackBaseUrl() === 'https://sandbox.example.com');
  });
  withEnv({ PAYSTACK_BASE_URL: 'http://api.paystack.co' }, () => {
    check('a plaintext http base URL is refused', throws(paystackBaseUrl));
  });

  // ── 5. Secrets must not leak ────────────────────────────────────
  console.log('\n══ 5. Secret Hygiene ══');

  withEnv({ PAYSTACK_SECRET_KEY: LIVE_SK, PAYSTACK_BASE_URL: undefined }, () => {
    const summary = assertPaystackConfigured();
    check('the config summary NEVER contains the full key',
      !JSON.stringify(summary).includes(LIVE_SK), JSON.stringify(summary));
    check('the fingerprint is short enough to be useless to a reader',
      summary.secretKeyFingerprint.length < 20, summary.secretKeyFingerprint);
    check('the fingerprint still identifies which key is loaded',
      summary.secretKeyFingerprint.startsWith('sk_live_'));
    check('the summary reports the mode', summary.mode === 'live');

    const h = paystackHeaders();
    check('auth header is a Bearer of the secret key', h.Authorization === `Bearer ${LIVE_SK}`);
    check('content type is set once, centrally', h['Content-Type'] === 'application/json');
  });

  // ── 6. Webhook source IPs ───────────────────────────────────────
  console.log('\n══ 6. Webhook Source IPs ══');
  check('exactly three documented Paystack webhook IPs', PAYSTACK_WEBHOOK_IPS.length === 3);
  check('they are the documented set',
    PAYSTACK_WEBHOOK_IPS.includes('52.31.139.75') &&
    PAYSTACK_WEBHOOK_IPS.includes('52.49.173.169') &&
    PAYSTACK_WEBHOOK_IPS.includes('52.214.14.220'));

  // ── 7. Envelope narrowing ───────────────────────────────────────
  console.log('\n══ 7. Response Envelope ══');
  /**
   * Paystack returns HTTP 200 on business failures with status:false, so the
   * HTTP code alone is not a success signal.
   */
  check('status:true narrows to success', isPaystackSuccess({ status: true, message: 'ok', data: { a: 1 } }));
  check('status:false is NOT success even on HTTP 200',
    !isPaystackSuccess({ status: false, message: 'Invalid key' } as any));

  console.log('\n' + '='.repeat(50));
  console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50) + '\n');
  if (failed > 0) process.exitCode = 1;
}

main();
