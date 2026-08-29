/**
 * IDENTIFYORG AS THE WORKING BVN PROVIDER.
 *
 * Monnify has no live key issued to this account, and Flutterwave's only
 * working path is v2 - a direct lookup with no consent step. IdentifyOrg is
 * therefore the provider that actually has to carry Level 2, and Level 2
 * raises a user's ceiling to NGN 5,000,000.
 *
 * WHAT THESE ASSERTIONS ARE SHAPED AROUND. The dangerous outcome is a
 * `matched` that should not have been granted - it hands out a limit increase
 * on unverified identity, and the money is gone before anyone reviews it. So
 * the load-bearing checks are the REFUSALS: a weak confidence score, a
 * non-success status, an HTTP error, a missing decision. A suite that only
 * proved "a good BVN returns matched" would pass while every one of those
 * granted Level 2 by mistake.
 *
 * The vendor is stubbed by swapping globalThis.fetch. That is deliberate:
 * these assertions are about OUR mapping of their documented contract, and
 * hitting the live API would spend real NGN per call and cannot produce a
 * confidence score on demand.
 *
 * Run: npx tsx scripts/test-identifyorg-kyc.ts
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.SIVAN_DATA_FILE = '/tmp/identifyorg-test.json';
process.env.DATABASE_FILE = '/tmp/identifyorg-test.json';
process.env.IDENTIFYORG_API_KEY = 'io_test_suite_key';
process.env.IDENTIFYORG_MIN_CONFIDENCE = '80';
process.env.EMAIL_PROVIDER = 'console';

import fs from 'node:fs';

let pass = 0;
let fail = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
};

fs.writeFileSync(process.env.SIVAN_DATA_FILE!, JSON.stringify({
  users: [], customers: [], auditLogs: [], ngnIdentityVerifications: [],
}, null, 2));

const { IdentifyOrgKycLevelProvider } = await import('../src/kyc/providers/identifyorg-kyc-level.provider.js');
const { buildKycProviderChain, FailoverKycLevelProvider } = await import('../src/kyc/providers/failover-kyc-level.provider.js');

const realFetch = globalThis.fetch;
let lastRequest: any = null;

/** Stub the vendor with one canned response. */
function stubVendor(status: number, payload: unknown) {
  globalThis.fetch = (async (url: any, init: any) => {
    lastRequest = {
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: init?.headers,
    };
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    } as any;
  }) as any;
}

const INPUT = {
  bvn: '12345678901',
  firstName: 'Adaeze',
  lastName: 'Okafor',
  dateOfBirth: '1992-04-15',
  mobileNo: '08012345678',
};

const provider = new IdentifyOrgKycLevelProvider();

console.log('\n══ 1. the request we actually send ════════════════════════');

stubVendor(200, { id: 'ver_1', status: 'success', match: true, confidence_score: 98, data: {} });
await provider.verifyBvnIdentity(INPUT);

check('posts to the documented BVN endpoint',
  lastRequest?.url.endsWith('/v1/verify/bvn'), String(lastRequest?.url));
check('authenticates with the X-IdentifyOrg-Key header',
  lastRequest?.headers?.['X-IdentifyOrg-Key'] === 'io_test_suite_key',
  JSON.stringify(lastRequest?.headers));
/** Required on live keys - their upstream rejects the call without it. */
check('sends phone_number, which live keys require',
  lastRequest?.body?.phone_number === '08012345678', JSON.stringify(lastRequest?.body));
check('sends the name and DOB for cross-matching',
  lastRequest?.body?.first_name === 'Adaeze' &&
  lastRequest?.body?.last_name === 'Okafor' &&
  lastRequest?.body?.date_of_birth === '1992-04-15',
  JSON.stringify(lastRequest?.body));

console.log('\n══ 2. a pass is only a pass when it is earned ═════════════');

stubVendor(200, { id: 'ver_2', status: 'success', match: true, confidence_score: 98, data: { date_of_birth: '1992-04-15' } });
const strong = await provider.verifyBvnIdentity(INPUT);
check('a high-confidence match is matched',
  strong.status === 'matched', `${strong.status} - ${strong.message}`);
check('and it records which provider answered',
  strong.provider === 'identifyorg', strong.provider);
check('and only the last four BVN digits are kept',
  strong.bvnLast4 === '8901', strong.bvnLast4);

/**
 * THE LOAD-BEARING ONE. 79 is below the 80 threshold. Their `match` field says
 * true; trusting it alone would grant a NGN 5,000,000 ceiling on a weak
 * cross-match.
 */
stubVendor(200, { id: 'ver_3', status: 'success', match: true, confidence_score: 79, data: {} });
const weak = await provider.verifyBvnIdentity(INPUT);
check('a match BELOW the confidence threshold is NOT granted',
  weak.status !== 'matched',
  `${weak.status} - match:true at 79% must not grant Level 2`);
check('it is held for review rather than failed',
  weak.status === 'review', weak.status);
check('and the message names the score and the threshold',
  /79/.test(weak.message) && /80/.test(weak.message), weak.message);

/** Exactly at the threshold must pass - an off-by-one here denies real users. */
stubVendor(200, { id: 'ver_4', status: 'success', match: true, confidence_score: 80, data: {} });
check('a score exactly at the threshold passes',
  (await provider.verifyBvnIdentity(INPUT)).status === 'matched');

console.log('\n══ 3. every ambiguous answer refuses ══════════════════════');

stubVendor(200, { id: 'ver_5', status: 'success', match: false, confidence_score: 10, data: {} });
check('an explicit non-match is failed',
  (await provider.verifyBvnIdentity(INPUT)).status === 'failed');

stubVendor(200, { id: 'ver_6', status: 'pending', match: null, data: {} });
const pending = await provider.verifyBvnIdentity(INPUT);
check('a non-success status is review, never matched',
  pending.status === 'review', `${pending.status} - ${pending.message}`);

stubVendor(200, { id: 'ver_7', status: 'success', data: {} });
const noDecision = await provider.verifyBvnIdentity(INPUT);
check('a missing match decision is review, never matched',
  noDecision.status === 'review', `${noDecision.status} - absence of an answer is not an answer`);

/**
 * An HTTP error says nothing about the customer. It must THROW so the chain
 * can try another vendor - returning `failed` would deny a user because our
 * key expired or their balance ran out.
 */
stubVendor(401, { message: 'Invalid API key' });
let threw = false;
try { await provider.verifyBvnIdentity(INPUT); } catch { threw = true; }
check('a 401 throws rather than returning a verdict about the user', threw);

stubVendor(402, { message: 'Insufficient balance' });
threw = false;
try { await provider.verifyBvnIdentity(INPUT); } catch { threw = true; }
check('an out-of-credit 402 throws rather than failing the user', threw);

console.log('\n══ 4. the BVN is never stored in full ═════════════════════');

/**
 * Their response echoes the complete 11-digit BVN. Migration 047 exists
 * because a BVN links every bank account a person owns - it must never be
 * persisted, and `raw` goes into the audit trail.
 */
stubVendor(200, {
  id: 'ver_8', status: 'success', match: true, confidence_score: 95,
  data: { bvn: '12345678901', phone_number: '+2348012345678', date_of_birth: '1992-04-15' },
});
const redacted = await provider.verifyBvnIdentity(INPUT);
check('the full BVN is redacted out of the stored raw payload',
  !JSON.stringify(redacted.raw).includes('12345678901'),
  JSON.stringify(redacted.raw));
check('and the last four survive so support can still match it',
  JSON.stringify(redacted.raw).includes('8901'), JSON.stringify(redacted.raw));

console.log('\n══ 5. cross-match detail is recorded for the operator ═════');

stubVendor(200, {
  id: 'ver_9', status: 'success', match: true, confidence_score: 95,
  data: { date_of_birth: '1992-04-15', phone_number: '+2348012345678' },
});
const fields = (await provider.verifyBvnIdentity(INPUT)).matchedFields;
check('the DOB comparison is recorded',
  fields?.dateOfBirth === true, JSON.stringify(fields));
/**
 * They return +2348012345678 where the user typed 08012345678 - the same
 * number in two formats. A string compare reports a mismatch on every call.
 */
check('a phone in international format still matches the local one',
  fields?.mobileNo === true,
  `${JSON.stringify(fields)} - +234... and 0... are the same number`);

console.log('\n══ 6. what it cannot do, it declines cleanly ══════════════');

check('capabilities() declares no BVN-to-account support',
  provider.capabilities().bvnBankAccount === false && provider.capabilities().bvnIdentity === true,
  JSON.stringify(provider.capabilities()));

threw = false;
try {
  await provider.verifyBvnBankAccount({ bvn: '12345678901', bankCode: '058', accountNumber: '0123456789', accountName: 'A O' });
} catch { threw = true; }
check('and calling it refuses rather than inventing an answer', threw);

console.log('\n══ 6b. NIN - the second route to Level 2 ══════════════════');

const NIN_INPUT = { nin: '98765432109', firstName: 'Adaeze', lastName: 'Okafor' };

stubVendor(200, {
  id: 'ver_n1', status: 'success', match: true,
  data: { nin: '98765432109', first_name: 'Adaeze', last_name: 'Okafor', date_of_birth: '1992-04-15' },
});
const nin = await provider.verifyNinIdentity(NIN_INPUT);
check('posts to the documented NIN endpoint',
  lastRequest?.url.endsWith('/v1/verify/nin'), String(lastRequest?.url));
check('a matched NIN verifies',
  nin.status === 'matched', `${nin.status} - ${nin.message}`);
check('and only the last four NIN digits are kept',
  nin.bvnLast4 === '2109', nin.bvnLast4);
check('and the full NIN never reaches the stored payload',
  !JSON.stringify(nin.raw).includes('98765432109'), JSON.stringify(nin.raw));
check('capabilities() declares NIN support',
  provider.capabilities().ninIdentity === true, JSON.stringify(provider.capabilities()));

/**
 * THE LOAD-BEARING NIN ASSERTION.
 *
 * Their API treats names as optional - without them NIMC returns the record on
 * file and there is nothing to compare against, so `match` is meaningless. If
 * we allowed that, anyone typing eleven digits belonging to someone else would
 * be granted a NGN 5,000,000 ceiling.
 */
let ninThrew = false;
try { await provider.verifyNinIdentity({ nin: '98765432109' } as any); } catch { ninThrew = true; }
check('a NIN check WITHOUT names is refused, not treated as a lookup',
  ninThrew, 'no names means no cross-match, so no verification');

stubVendor(200, { id: 'ver_n2', status: 'success', match: false, data: {} });
check('a non-matching NIN is failed',
  (await provider.verifyNinIdentity(NIN_INPUT)).status === 'failed');

stubVendor(200, { id: 'ver_n3', status: 'success', data: {} });
check('a NIN with no match decision is review, never matched',
  (await provider.verifyNinIdentity(NIN_INPUT)).status === 'review');

console.log('\n══ 7. the failover chain ══════════════════════════════════');

const chain = buildKycProviderChain('identifyorg');
check('identifyorg is in the chain when a key is set',
  chain.some((e: any) => e.name === 'identifyorg'), JSON.stringify(chain.map((e: any) => e.name)));
check('and it is tried first when preferred',
  chain[0]?.name === 'identifyorg', JSON.stringify(chain.map((e: any) => e.name)));

/**
 * THE CAPABILITY SKIP. With only IdentifyOrg configured, a bank-account check
 * has no capable provider. It must refuse - and crucially must NOT report that
 * IdentifyOrg was tried and failed, because it was never asked.
 */
const failover = new FailoverKycLevelProvider(chain);
let bankErr: any = null;
try {
  await failover.verifyBvnBankAccount({ bvn: '12345678901', bankCode: '058', accountNumber: '0123456789', accountName: 'A O' });
} catch (error) { bankErr = error; }
check('a bank-account check with no capable provider refuses',
  bankErr !== null, 'it must not silently succeed');

/** An incapable provider must not be reported as a failed attempt. */
const msg = String(bankErr?.message ?? '');
check('and the refusal does not blame identifyorg for an outage',
  !/identifyorg (failed|error|unavailable)/i.test(msg), msg);

/**
 * NIN through the chain. Monnify and Flutterwave do not implement
 * verifyNinIdentity at all, so supports() must skip them by METHOD ABSENCE
 * rather than letting a TypeError surface as a provider outage.
 */
stubVendor(200, { id: 'ver_n4', status: 'success', match: true, data: { first_name: 'Adaeze', last_name: 'Okafor' } });
const chainNin = await (failover as any).verifyNinIdentity(NIN_INPUT);
check('the chain routes a NIN to the one provider that supports it',
  chainNin.status === 'matched' && chainNin.provider === 'identifyorg',
  `${chainNin.status} / ${chainNin.provider}`);

globalThis.fetch = realFetch;

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (failures.length) console.log(`   ${failures.join('\n   ')}`);
process.exit(fail === 0 ? 0 : 1);
