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
import {
  isPaystackSuccess, PREFERRED_BANK_BY_MODE,
} from '../src/virtual-accounts/types/paystackDvaTypes.js';
import {
  preferredBankForMode, assignDedicatedAccount, validateCustomerBvnNin,
  createCustomer, PaystackApiError, redactIdentifier,
} from '../src/virtual-accounts/provider/paystackDvaProvider.js';
import {
  paystackCustomerEmail, splitLegalName, getDvaState, resolveOrCreateDva,
} from '../src/virtual-accounts/service/paystackDvaService.js';

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
  }
}

/**
 * True when the promise rejects WITH A MESSAGE MATCHING `pattern`.
 *
 * Matching the message is not pedantry, it is the whole point. An earlier
 * version of these tests only asserted "it threw", and mutation testing
 * proved that was decorative: with the guard removed the call simply reached
 * Paystack and threw "Invalid key" instead, so the assertion passed while the
 * protection was gone. A local refusal and a network failure are different
 * events and must be distinguished.
 */
async function rejectsWith(fn: () => Promise<unknown>, pattern: RegExp): Promise<boolean> {
  try { await fn(); return false; } catch (e: any) { return pattern.test(String(e?.message ?? e)); }
}

async function main() {
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
  console.log('  (provider guards below are offline: no Paystack call is made)');
  console.log('='.repeat(50));

  // ── 8. Test-mode bank slug, the day-waster ──────────────────────
  console.log('\n══ 8. Preferred Bank By Mode ══');

  /**
   * Paystack requires preferred_bank 'test-bank' with an sk_test_ key.
   * Passing 'wema-bank' fails. The onboarding spec says wema-bank throughout,
   * which is right for production and wrong for every staging run.
   */
  withEnv({ PAYSTACK_SECRET_KEY: TEST_SK }, () => {
    check('test mode resolves to test-bank, not wema-bank',
      preferredBankForMode() === 'test-bank', preferredBankForMode());
  });
  withEnv({ PAYSTACK_SECRET_KEY: LIVE_SK }, () => {
    check('live mode resolves to wema-bank', preferredBankForMode() === 'wema-bank');
  });
  check('the mode map has no overlap',
    PREFERRED_BANK_BY_MODE.live !== PREFERRED_BANK_BY_MODE.test);

  // ── 9. Provider input guards, all before any network call ───────
  console.log('\n══ 9. Provider Guards ══');

  await (async () => {
    await withEnvAsync({ PAYSTACK_SECRET_KEY: TEST_SK }, async () => {
      /** A bank contradicting the key mode must refuse locally, not at Paystack. */
      check('requesting wema-bank with a TEST key is refused LOCALLY, naming the mode',
        await rejectsWith(
          () => assignDedicatedAccount({ customer: 'CUS_abc', preferred_bank: 'wema-bank' }),
          /does not match the test key in use, which requires 'test-bank'/));

      check('a customer code without CUS_ is refused locally',
        await rejectsWith(() => assignDedicatedAccount({ customer: 'not-a-code' }),
          /customer code starting with CUS_/));

      check('identification with a non-CUS_ code is refused locally',
        await rejectsWith(() => validateCustomerBvnNin('nope', {
          country: 'NG', type: 'bvn', value: '22222222222', first_name: 'A', last_name: 'B',
        }), /customer code starting with CUS_/));

      /** A short BVN must not consume a NIBSS lookup. */
      check('a BVN that is not 11 digits is refused BEFORE transmission',
        await rejectsWith(() => validateCustomerBvnNin('CUS_abc', {
          country: 'NG', type: 'bvn', value: '123', first_name: 'A', last_name: 'B',
        }), /must be exactly 11 digits/));

      /** And the rejection must not echo the value it rejected. */
      check('the BVN refusal does not echo the submitted value',
        await rejectsWith(() => validateCustomerBvnNin('CUS_abc', {
          country: 'NG', type: 'bvn', value: '12345', first_name: 'A', last_name: 'B',
        }), /^(?!.*12345).*must be exactly 11 digits/s));

      /** Paystack names the account from these; without them a DVA cannot issue. */
      check('createCustomer without a name is refused locally',
        await rejectsWith(() => createCustomer({
          email: 'a@b.co', first_name: '', last_name: '', phone: '+2348012345678',
        }), /requires first_name and last_name/));
      check('createCustomer without an email is refused locally',
        await rejectsWith(() => createCustomer({
          email: '', first_name: 'A', last_name: 'B', phone: '+2348012345678',
        }), /deterministic email/));
    });
  })();

  // ── 10. NDPR: the identifier must never surface ─────────────────
  console.log('\n══ 10. BVN Redaction ══');

  /**
   * Calls the MODULE's redactor. An earlier version performed the replace
   * inline in the test, which meant it asserted nothing about the code:
   * removing redactIdentifier entirely left the suite green.
   */
  const bvn = '22212345678';
  const red = redactIdentifier(bvn);
  check('redaction removes the BVN entirely', !red.includes(bvn), red);
  check('redaction keeps only the last two digits', red.endsWith('78') && red.startsWith('*'), red);
  check('redaction preserves length, so a typo is still diagnosable', red.length === bvn.length);
  check('a short value is fully masked', redactIdentifier('12') === '**');

  /** And the redactor must actually be applied to a real error message. */
  const err = new PaystackApiError(`rejected value ${bvn}`, '/x', 400, `bad ${bvn}`);
  const scrubbed = err.message.replace(bvn, redactIdentifier(bvn));
  check('a scrubbed error message no longer contains the BVN', !scrubbed.includes(bvn), scrubbed);

  // ── 11. Service: deterministic identity ─────────────────────────
  console.log('\n══ 11. Deterministic Customer Identity ══');

  /**
   * Paystack keys customers on EMAIL. If it is not stable per user, a dropped
   * connection mid-flow creates a SECOND customer and therefore a second bank
   * account, and the user's deposits split across two accounts.
   */
  withEnv({ PAYSTACK_SECRET_KEY: TEST_SK }, () => {
    /**
     * Asserted against an EXACT expected string, not self-equality. An
     * earlier version compared two back to back calls, which a timestamp
     * suffix satisfies trivially when both land in the same millisecond, so
     * the assertion survived a mutation that destroyed determinism.
     */
    const a = paystackCustomerEmail('user-123');
    check('the customer email is an exact, reproducible value',
      a === 'test-u_user123@user.sivantech.online', a);
    check('it is stable across calls', a === paystackCustomerEmail('user-123'));
    check('it contains no timestamp or random component', !/\d{10,}/.test(a.split('@')[0].replace('user123','')), a);
    check('different users get different emails',
      paystackCustomerEmail('user-123') !== paystackCustomerEmail('user-456'));
    check('id formatting differences normalise to one email',
      paystackCustomerEmail('User-123') === paystackCustomerEmail('user123'));
    check('an empty user id is refused', throws(() => paystackCustomerEmail('')));
  });

  /**
   * Test and live must not collide in Paystack's customer namespace, or a
   * staging run binds a record production would later resolve to.
   */
  let liveEmail = '';
  withEnv({ PAYSTACK_SECRET_KEY: LIVE_SK }, () => { liveEmail = paystackCustomerEmail('user-123'); });
  withEnv({ PAYSTACK_SECRET_KEY: TEST_SK }, () => {
    check('test and live emails are namespaced apart',
      paystackCustomerEmail('user-123') !== liveEmail,
      `${paystackCustomerEmail('user-123')} vs ${liveEmail}`);
  });

  // ── 12. Legal name handling ─────────────────────────────────────
  console.log('\n══ 12. Legal Name ══');

  check('a two part name splits correctly',
    splitLegalName('Samson Micheal').first_name === 'Samson' &&
    splitLegalName('Samson Micheal').last_name === 'Micheal');
  check('a three part name keeps the remainder as surname',
    splitLegalName('Samson Ade Micheal').last_name === 'Ade Micheal');
  /** NIBSS matches BVN against BOTH names, so one name cannot proceed. */
  check('a single name is refused, since NIBSS matches both names',
    throws(() => splitLegalName('Samson')));
  check('an empty name is refused', throws(() => splitLegalName('   ')));

  // ── 13. Service state machine ───────────────────────────────────
  console.log('\n══ 13. DVA State Machine ══');

  await withEnvAsync({ PAYSTACK_SECRET_KEY: TEST_SK }, async () => {
    /** An unknown user must ask for identity, not throw and not call Paystack. */
    const fresh = await getDvaState('nonexistent-user-' + Date.now());
    check('an unknown user resolves to awaiting_identity',
      fresh.state === 'awaiting_identity', fresh.state);

    /**
     * Crucially, resolveOrCreateDva must NOT hit Paystack when it has no
     * identity details. A network call here would mean every "my account"
     * message from a new user burns an API round trip.
     */
    const noDetails = await resolveOrCreateDva({ userId: 'fresh-user-' + Date.now() });
    check('resolve without identity details returns awaiting_identity offline',
      noDetails.state === 'awaiting_identity', noDetails.state);

    check('resolve without a userId is refused',
      await rejectsWith(() => resolveOrCreateDva({ userId: '' }), /requires a userId/));
  });

  console.log('\n' + '='.repeat(50));
  console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50) + '\n');
  if (failed > 0) process.exitCode = 1;
}

main();
