/**
 * FLUTTERWAVE BVN — a second identity provider, and the consent trap.
 *
 * Monnify was the only BVN vendor, which made it a single point of failure on
 * the step that gates every Nigerian's limits. This adds Flutterwave beside
 * it behind the same KycLevelProvider interface.
 *
 * THE DANGEROUS PATH, and what most of this file is about.
 *
 * Flutterwave v3 is a CONSENT flow, not a lookup. The first call only returns
 * a URL for the customer to approve on a NIBSS page; the BVN data arrives
 * later. The tempting shortcut - "the API returned 200, call it matched" -
 * would grant Level 2 and a NGN 5,000,000 ceiling to anyone who typed eleven
 * digits, with no consent and no verification at all.
 *
 * So the assertions here are mostly about what must NOT happen: not matched
 * before consent, not matched on a name mismatch, not matched for a
 * watchlisted BVN, and not matched when there is nothing to compare against.
 *
 * Run: npm run test:flutterwave-bvn
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-flutterwave-bvn.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'flw-admin-key';
process.env.USER_JWT_SECRET = 'flw-jwt-secret-value-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.KYC_LEVEL_PROVIDER = 'flutterwave';
process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK_TEST-fake-key-for-tests';
process.env.FLUTTERWAVE_BVN_REDIRECT_URL = 'https://app.sivantech.online/verification';
process.env.FLUTTERWAVE_BVN_ALLOW_V2_DIRECT = 'false';

import fs from 'node:fs';
fs.rmSync('.data/test-flutterwave-bvn.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { decideFlutterwaveStatus, FlutterwaveKycLevelProvider } =
  await import('../src/kyc/providers/flutterwave-kyc-level.provider.js');
const { getKycLevelProvider, isKycLevelProviderConfigured } =
  await import('../src/kyc/providers/kyc-level-provider-registry.js');

/** The real NIBSS record shape, from Flutterwave's own documented sample. */
const NIBSS = {
  bvn: '22222222280',
  firstName: 'Ernest',
  surname: 'Certifier',
  middleName: 'S',
  dateOfBirth: '1976-11-30',
  phoneNumber1: null,
  phoneNumber2: '08169835630',
  watchlisted: null,
};

const claimed = {
  bvn: '22222222280',
  firstName: 'Ernest',
  lastName: 'Certifier',
  dateOfBirth: '30-11-1976',
  mobileNo: '08169835630',
};

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 1. the provider is registered and selectable ─────────────');

const provider = getKycLevelProvider('flutterwave' as any);
check('the registry returns the Flutterwave provider', provider.name === 'flutterwave', provider.name);
check('it satisfies the KycLevelProvider interface',
  typeof provider.verifyBvnIdentity === 'function' && typeof provider.health === 'function');
check('Monnify is still selectable alongside it',
  getKycLevelProvider('monnify' as any).name === 'monnify');
check('an unknown name still falls back to mock',
  getKycLevelProvider('nonsense' as any).name === 'mock');
check('it reports configured with a key and a redirect url', isKycLevelProviderConfigured() === true);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 2. matching against the real NIBSS shape ─────────────────');

const exact = decideFlutterwaveStatus(claimed, NIBSS);
check('an exact match is matched', exact.status === 'matched', JSON.stringify(exact));
check('and every compared field is reported',
  exact.matchedFields.firstName === true && exact.matchedFields.lastName === true,
  JSON.stringify(exact.matchedFields));

// The date formats genuinely differ between NIBSS and Sivan's form.
check('1976-11-30 matches a claimed 30-11-1976',
  exact.matchedFields.dateOfBirth === true, JSON.stringify(exact.matchedFields));

// NIBSS put the number in phoneNumber2 and left phoneNumber1 null.
check('the phone is read from whichever field carries it',
  exact.matchedFields.mobileNo === true, JSON.stringify(exact.matchedFields));

check('+234 and 0 prefixes are the same number',
  decideFlutterwaveStatus({ ...claimed, mobileNo: '+2348169835630' }, NIBSS).matchedFields.mobileNo === true);

check('case and whitespace do not break a name match',
  decideFlutterwaveStatus({ ...claimed, firstName: '  ERNEST ', lastName: 'certifier' }, NIBSS).status === 'matched');

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 3. WHAT MUST NOT PASS ───────────────────────────────────');

check('a different surname FAILS',
  decideFlutterwaveStatus({ ...claimed, lastName: 'Adeyemi' }, NIBSS).status === 'failed');
check('a different first name FAILS',
  decideFlutterwaveStatus({ ...claimed, firstName: 'Michael' }, NIBSS).status === 'failed');

/**
 * A WATCHLISTED BVN IS NEVER A PASS, even when every name lines up. NIBSS
 * flags these and it is a compliance stop, not a data-quality hint.
 */
const watch = decideFlutterwaveStatus(claimed, { ...NIBSS, watchlisted: '901.0' });
check('a watchlisted BVN never matches, even on a perfect name match',
  watch.status === 'review', JSON.stringify(watch));
check('and the flag is recorded for the reviewer',
  String(watch.matchedFields.watchlisted) === '901.0', JSON.stringify(watch.matchedFields));

/**
 * An EMPTY record is the case that would be catastrophic to pass: a request
 * that succeeded but returned nothing must never be read as agreement.
 */
check('an empty NIBSS record is review, never matched',
  decideFlutterwaveStatus(claimed, {}).status === 'review');
check('a null record is review, never matched',
  decideFlutterwaveStatus(claimed, null).status === 'review');

// A mismatching DOB with matching names is a review, not an automatic pass.
check('a wrong date of birth downgrades a name match to review',
  decideFlutterwaveStatus({ ...claimed, dateOfBirth: '01-01-1990' }, NIBSS).status === 'review');
check('a wrong phone downgrades a name match to review',
  decideFlutterwaveStatus({ ...claimed, mobileNo: '08000000000' }, NIBSS).status === 'review');

/**
 * MISSING IS NOT MISMATCHED. A field NIBSS did not return must be absent from
 * matchedFields, not reported as false - "we could not check this" and "this
 * disagreed" are different findings and only one of them is evidence.
 */
const partial = decideFlutterwaveStatus(claimed, { firstName: 'Ernest', surname: 'Certifier' });
check('a field NIBSS did not return is absent, not false',
  partial.matchedFields.dateOfBirth === undefined && partial.matchedFields.mobileNo === undefined,
  JSON.stringify(partial.matchedFields));
check('and names alone are still enough to match', partial.status === 'matched', JSON.stringify(partial));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 4. the consent flow never short-circuits ─────────────────');

const flw: any = new FlutterwaveKycLevelProvider();
const realFetch = globalThis.fetch;
let lastUrl = '';
let lastBody: any = null;

/**
 * The FIRST call must not return matched under ANY provider response. This
 * stubs a consent response that looks maximally successful - status success,
 * a reference, HTTP 200 - because that is exactly the shape a careless
 * implementation would read as a pass.
 */
globalThis.fetch = (async (url: any, init: any) => {
  lastUrl = String(url);
  lastBody = init?.body ? JSON.parse(init.body) : null;
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: 'success',
      message: 'Bvn verification initiated',
      data: {
        url: 'https://nibss-bvn-consent-management.myflutterwave.com/cms/BvnConsent?session=abc',
        reference: 'FLW0B0BCB7D3F8A1148C87232',
      },
    }),
  };
}) as any;

const initiated = await flw.verifyBvnIdentity(claimed);
check('initiating consent does NOT return matched', initiated.status !== 'matched', initiated.status);
check('it returns review', initiated.status === 'review', initiated.status);
check('the consent URL is handed back for the customer',
  String(initiated.matchedFields?.consentUrl).includes('BvnConsent'),
  JSON.stringify(initiated.matchedFields));
check('the reference is kept so the result can be collected',
  initiated.providerReference === 'FLW0B0BCB7D3F8A1148C87232', String(initiated.providerReference));
check('only the last 4 BVN digits are surfaced', initiated.bvnLast4 === '2280', initiated.bvnLast4);
check('the request went to the v3 consent endpoint',
  lastUrl.includes('/v3/bvn/verifications'), lastUrl);
check('and carried the redirect url NIBSS sends the customer back to',
  lastBody?.redirect_url === 'https://app.sivantech.online/verification', JSON.stringify(lastBody));
check('the BVN is sent as 11 digits', String(lastBody?.bvn).length === 11, String(lastBody?.bvn));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 5. collecting the result after consent ───────────────────');

globalThis.fetch = (async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    status: 'success',
    data: { status: 'COMPLETED', reference: 'FLWC04A90C093E769B4F6EE1A', bvn_data: NIBSS },
  }),
})) as any;

const completed = await flw.completeBvnConsent('FLWC04A90C093E769B4F6EE1A', claimed);
check('a completed consent with a matching record IS matched',
  completed.status === 'matched', JSON.stringify(completed.matchedFields));

// PENDING must not read as a rejection - the customer simply has not finished.
globalThis.fetch = (async () => ({
  ok: true, status: 200,
  json: async () => ({ status: 'success', data: { status: 'PENDING', reference: 'r', bvn_data: {} } }),
})) as any;
const pending = await flw.completeBvnConsent('r', claimed);
check('a PENDING consent is review, not failed', pending.status === 'review', pending.status);
check('and it does not claim the BVN was wrong',
  !/not match|failed/i.test(pending.message), pending.message);

// A webhook has the reference but not the submitted form. Data without a
// comparison is not a verification.
globalThis.fetch = (async () => ({
  ok: true, status: 200,
  json: async () => ({ status: 'success', data: { status: 'COMPLETED', reference: 'r2', bvn_data: NIBSS } }),
})) as any;
const noClaim = await flw.completeBvnConsent('r2');
check('completed data with nothing to compare against is review',
  noClaim.status === 'review', noClaim.status);
check('and it says so explicitly',
  noClaim.matchedFields?.comparedAgainstSubmission === false,
  JSON.stringify(noClaim.matchedFields));

/**
 * A returning customer who has consented before gets a NULL url, and must be
 * taken straight to the result rather than sent to a page that does not exist.
 */
let calls = 0;
globalThis.fetch = (async (url: any) => {
  calls += 1;
  if (String(url).includes('/v3/bvn/verifications/')) {
    return { ok: true, status: 200, json: async () => ({ data: { status: 'COMPLETED', reference: 'r3', bvn_data: NIBSS } }) };
  }
  return { ok: true, status: 200, json: async () => ({ data: { url: null, reference: 'r3' } }) };
}) as any;
const returning = await flw.verifyBvnIdentity(claimed);
check('a returning customer with prior consent resolves immediately',
  returning.status === 'matched', returning.status);
check('without being sent to a consent page', calls === 2, `fetch calls=${calls}`);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 6. refusals that protect money and compliance ────────────');

globalThis.fetch = realFetch;

const shortBvn = await flw.verifyBvnIdentity({ ...claimed, bvn: '123' }).then(() => null).catch((e: Error) => e.message);
check('a BVN that is not 11 digits is refused before any paid call',
  /11 digits/i.test(String(shortBvn)), String(shortBvn));

const acct = await flw.verifyBvnBankAccount({
  bvn: '22222222280', bankCode: '044', accountNumber: '0690000031', accountName: 'Ernest Certifier',
} as any).then(() => null).catch((e: Error) => e.message);
check('BVN-to-account matching is refused, not faked',
  /does not offer/i.test(String(acct)), String(acct));
check('and it names the provider that can do it',
  /monnify/i.test(String(acct)), String(acct));

const health = await flw.health();
check('health reports live mode', health.mode === 'live' && health.available === true, JSON.stringify(health));
check('and confirms the consent path is in use',
  /consent/i.test(String(health.message)), String(health.message));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 7. the v2 no-consent path is OFF unless asked for ────────');

check('v2 is disabled by default', process.env.FLUTTERWAVE_BVN_ALLOW_V2_DIRECT === 'false');

// Selected explicitly, it must still mark that consent was NOT obtained -
// a compliance fact the audit trail has to carry.
const { env } = await import('../src/config/env.js');
(env as any).FLUTTERWAVE_BVN_ALLOW_V2_DIRECT = true;
globalThis.fetch = (async (url: any) => {
  lastUrl = String(url);
  return {
    ok: true, status: 200,
    json: async () => ({
      status: 'success', message: 'BVN-DETAILS',
      data: { bvn: '22222222280', first_name: 'Ernest', last_name: 'Certifier', date_of_birth: '30-11-1976', phone_number: '08169835630' },
    }),
  };
}) as any;
const v2 = await flw.verifyBvnIdentity(claimed);
check('the v2 direct lookup can match', v2.status === 'matched', JSON.stringify(v2.matchedFields));
check('it records that no consent was obtained',
  v2.matchedFields?.consentObtained === false, JSON.stringify(v2.matchedFields));
check('and which API version answered', v2.matchedFields?.apiVersion === 'v2');
check('it reads the snake_case v2 shape too',
  v2.matchedFields?.firstName === true && v2.matchedFields?.lastName === true,
  JSON.stringify(v2.matchedFields));
check('the v2 request went to the ravepay host', /ravepay|v2\/kyc\/bvn/.test(lastUrl), lastUrl);

const warnHealth = await flw.health();
check('health WARNS while consent is being skipped',
  /WARNING/.test(String(warnHealth.message)), String(warnHealth.message));

(env as any).FLUTTERWAVE_BVN_ALLOW_V2_DIRECT = false;
globalThis.fetch = realFetch;

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
