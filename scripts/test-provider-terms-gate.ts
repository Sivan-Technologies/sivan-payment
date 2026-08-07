/**
 * PROVIDER TERMS: SHOWN, SIGNED, AND ENFORCED.
 *
 * Reported: "Tos should not be hidden and let put it in the verification page
 * as one of the cateria to do so once user finish verification they should
 * sign the Tos as well".
 *
 * THREE SEPARATE FAULTS SAT BEHIND THAT SENTENCE.
 *
 * 1. THE STEP WAS HIDDEN. The Terms row was rendered behind `!isNgnPath`, so a
 *    Nigerian never saw it. That reasoning holds only while a Nigerian has no
 *    Bridge relationship - but the same page carries a "Verify with ID
 *    instead" button, the documented route to USD/GBP/EUR rails, and taking it
 *    creates a Bridge customer with a real terms obligation. The row stayed
 *    hidden and they were refused at withdrawal for a step never shown.
 *
 * 2. THE STEP WAS DEAD. Even where it WAS shown, it rendered through
 *    VerificationStep, whose button is `disabled` by design. Nothing on the
 *    verification page could accept terms. The only live link was buried in a
 *    status card further down.
 *
 * 3. NOTHING ENFORCED IT. `tosStatus` was stored and displayed, and only the
 *    supplier path ever checked it. Withdrawals, payout banks, on-ramp and
 *    virtual accounts all gated on `kycStatus` alone.
 *
 * AND THE TRAP THAT MAKES ENFORCEMENT DANGEROUS:
 *
 *   The stored `tosStatus` GOES STALE, so blocking on it naively locks out
 *   users who HAVE accepted. `refreshKycStatus` read tos only from the
 *   kyc_link and `return`ed early when there was no kycLinkId; the `customer`
 *   webhook updated kycStatus and dropped terms entirely. An admin-imported
 *   customer therefore stayed 'pending' forever. The sync fix and the gate
 *   have to ship together, which is most of what this file pins down.
 *
 * Verified against the REAL Bridge sandbox (customer
 * 1245c57f-9bc2-4942-8776-3bfa6998dcae): `has_accepted_terms_of_service` is
 * true, both endorsements carry terms_of_service_v1/_v2 under
 * `requirements.complete`, and the kyc_link reports tos_status 'approved'.
 *
 * Run: npm run test:terms-gate
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-terms-gate.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.BRIDGE_MOCK_MODE = 'true';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'terms-admin-key';
process.env.USER_JWT_SECRET = 'terms-jwt-secret-value-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.VIRTUAL_ACCOUNT_PROVIDER = 'mock';
process.env.VIRTUAL_ACCOUNTS_ENABLED = 'true';
process.env.VIRTUAL_ACCOUNT_REQUESTS_ENABLED = 'true';

import fs from 'node:fs';
fs.rmSync('.data/test-terms-gate.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { db } = await import('../src/database/json-database.js');
const { bridgeCustomerTermsAccepted } = await import('../src/providers/bridge/bridge-terms.js');
const { customerTermsOutstanding, requireCustomerTerms, TERMS_REQUIRED_MESSAGE } =
  await import('../src/customers/customer-terms.js');
const { AppError } = await import('../src/shared/errors.js');

const now = () => new Date().toISOString();

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 1. reading Bridge\'s answer, including "it did not say" ───');

/**
 * TRI-STATE, AND THE THIRD STATE IS THE WHOLE POINT.
 *
 * Collapsing "Bridge told us nothing" into `false` would let one malformed
 * response revoke a real acceptance and block a verified user from their own
 * money. Every caller that writes or blocks has to distinguish the two.
 */
check('an explicit true is true',
  bridgeCustomerTermsAccepted({ has_accepted_terms_of_service: true }) === true);
check('an explicit false is false',
  bridgeCustomerTermsAccepted({ has_accepted_terms_of_service: false }) === false);
check('a body with no terms information at all is UNDEFINED, not false',
  bridgeCustomerTermsAccepted({ id: 'cus_1', status: 'active' }) === undefined,
  'undefined means "unknown"; false would mean "Bridge denied it"');
check('null/garbage is undefined, not false',
  bridgeCustomerTermsAccepted(null) === undefined && bridgeCustomerTermsAccepted('x') === undefined);

// The shape actually returned by the real sandbox.
const realShape = {
  id: 'cus_real',
  status: 'active',
  endorsements: [
    { name: 'base', status: 'approved', requirements: { complete: ['terms_of_service_v1', 'first_name', 'min_age_18'], missing: [], pending: [], issues: [] } },
    { name: 'sepa', status: 'approved', requirements: { complete: ['terms_of_service_v2', 'last_name'], missing: [], pending: [], issues: [] } },
  ],
};
check('terms under requirements.complete read as accepted',
  bridgeCustomerTermsAccepted(realShape) === true);

/**
 * THE FALSE POSITIVE THE OLD IMPLEMENTATION PRODUCED.
 *
 * It was:
 *     const r = JSON.stringify(endorsements);
 *     return /terms_of_service/i.test(r) && /complete/i.test(r);
 *
 * Two INDEPENDENT substring tests over one blob. Terms sitting in `missing`
 * plus literally anything in `complete` satisfied both - so a customer who had
 * NOT accepted read as accepted. On a compliance field.
 */
const termsMissing = {
  id: 'cus_missing',
  endorsements: [
    { name: 'base', requirements: { missing: ['terms_of_service_v1'], complete: ['first_name', 'last_name'], pending: [], issues: [] } },
  ],
};
check('terms in `missing` read as NOT accepted, even with other items complete',
  bridgeCustomerTermsAccepted(termsMissing) === false,
  'the old stringify-and-regex version returned true here');

const termsPending = {
  id: 'cus_pending',
  endorsements: [{ name: 'base', requirements: { pending: ['terms_of_service_v1'], complete: ['email_address'] } }],
};
check('terms in `pending` read as NOT accepted',
  bridgeCustomerTermsAccepted(termsPending) === false);

// Bridge versions its terms. A _v3 must not read as "not accepted" and start
// blocking the entire platform.
check('an unseen future terms version is matched by prefix',
  bridgeCustomerTermsAccepted({ endorsements: [{ requirements: { complete: ['terms_of_service_v3'] } }] }) === true);

check('endorsements that never mention terms are UNDEFINED, not false',
  bridgeCustomerTermsAccepted({ endorsements: [{ requirements: { complete: ['first_name'] } }] }) === undefined,
  'silence is not denial');

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 2. who owes an acceptance at all ─────────────────────────');

check('a bridge customer with pending terms owes one',
  customerTermsOutstanding({ provider: 'bridge', tosStatus: 'pending' } as any) === true);
check('a bridge customer with approved terms does not',
  customerTermsOutstanding({ provider: 'bridge', tosStatus: 'approved' } as any) === false);
/**
 * A Nigerian verifying by bank-name match has no Bridge relationship: no terms
 * document applies and there is no link they could open. Demanding acceptance
 * would demand a step that does not exist.
 */
check('a user with NO customer record owes nothing',
  customerTermsOutstanding(null) === false,
  'the NGN bank path must not be blocked by a Bridge-only obligation');
check('a non-bridge (mock) customer owes nothing',
  customerTermsOutstanding({ provider: 'mock', tosStatus: 'pending' } as any) === false);

const thrown = (() => { try { requireCustomerTerms({ provider: 'bridge', tosStatus: 'pending' } as any); return null; } catch (e) { return e; } })();
/**
 * `statusCode`, not `status`. AppError stores it as statusCode; asserting
 * `.status` reads `undefined === 400` which is false - but the FIRST draft of
 * this test asserted exactly that and I only caught it because the check went
 * red. Had the assertion been `!== 500` it would have passed on undefined and
 * proved nothing.
 */
check('requireCustomerTerms throws a 400, not a 500',
  thrown instanceof AppError && (thrown as any).statusCode === 400,
  `statusCode=${(thrown as any)?.statusCode}`);
check('and the message tells the user where to go',
  /verification page/i.test(String((thrown as any)?.message)),
  String((thrown as any)?.message));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 3. the gate actually refuses money movement ──────────────');

await db.mutate((d: any) => {
  d.users = [{ id: 'usr_t', email: 'terms@t.test', emailVerifiedAt: now(), country: 'US',
    fullName: 'Terry Onus', createdAt: now(), updatedAt: now() }];
  d.customers = [{ id: 'cus_t', userId: 'usr_t', provider: 'bridge', providerCustomerId: 'bridge_cus_t',
    customerType: 'individual', kycStatus: 'kyc_approved', tosStatus: 'pending',
    createdAt: now(), updatedAt: now() }];
  return 1;
});

/**
 * KYC IS APPROVED IN ALL OF THESE. That is the case that matters - Bridge
 * approves the document check and the terms acceptance independently, so this
 * is a real state a real user sits in, and it is the state where the old code
 * let everything through.
 */
const { checkVirtualAccountEligibility } =
  await import('../src/virtual-accounts/service/virtual-account-eligibility.service.js');

const vaBlocked = await checkVirtualAccountEligibility('usr_t', 'usd');
check('a virtual account is REFUSED while terms are pending',
  vaBlocked.eligible === false, JSON.stringify(vaBlocked.reasons));
check('and the reason names the terms, not something vague',
  vaBlocked.reasons.some((r: string) => /terms/i.test(r)), JSON.stringify(vaBlocked.reasons));
check('the KYC reason is NOT among them - KYC really is approved',
  !vaBlocked.reasons.some((r: string) => /KYC must be approved/i.test(r)),
  JSON.stringify(vaBlocked.reasons));

const { createSupplier } = await import('../src/suppliers/supplier.service.js');
const supplierErr = await createSupplier({
  userId: 'usr_t', name: 'Acme Ltd', accountType: 'us', currency: 'usd',
  bankName: 'Chase', accountOwnerName: 'Acme Ltd',
  account: { account_number: '12345678901', routing_number: '021000021' },
} as any).then(() => null).catch((e: Error) => e);
check('adding a supplier is REFUSED while terms are pending',
  supplierErr instanceof AppError, String(supplierErr));
check('and it uses the shared, actionable message',
  String((supplierErr as any)?.message) === TERMS_REQUIRED_MESSAGE,
  String((supplierErr as any)?.message));

// Now accept the terms, and confirm the SAME call stops being refused. A gate
// that never opens is indistinguishable from a broken feature.
await db.mutate((d: any) => { d.customers[0].tosStatus = 'approved'; return 1; });

const vaAfter = await checkVirtualAccountEligibility('usr_t', 'usd');
check('once terms are accepted the virtual account is no longer refused for terms',
  !vaAfter.reasons.some((r: string) => /terms/i.test(r)), JSON.stringify(vaAfter.reasons));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 4. the summary drives the UI, and counts terms as a step ─');

const { getVerificationSummary } = await import('../src/kyc/service/verification-summary.service.js');

/**
 * THE USER MUST BE OTHERWISE FINISHED, or this section proves nothing.
 *
 * Caught by mutation testing: with `pathComplete` reverted to ignore terms
 * entirely, this whole section still passed. usr_t had no verified payout
 * account, so their level never reached IDENTITY and pathComplete was already
 * false for a completely unrelated reason - the assertion was reading the
 * right value produced by the wrong cause.
 *
 * A verified external account plus approved KYC puts them at IDENTITY, so
 * pathComplete is true on every input EXCEPT the terms. Now the assertion can
 * only be satisfied by the thing it claims to test.
 */
await db.mutate((d: any) => {
  d.customers[0].tosStatus = 'pending';
  d.customers[0].tosLink = 'https://bridge.example/tos/abc';
  d.externalAccounts = [{ id: 'ext_t', userId: 'usr_t', customerId: 'cus_t', provider: 'bridge',
    providerExternalAccountId: 'bridge_ext_t', currency: 'usd', accountType: 'us',
    accountOwnerName: 'Terry Onus', status: 'verified', createdAt: now(), updatedAt: now() }];
  return 1;
});

// The precondition itself is asserted, so a future change that stops this user
// reaching IDENTITY turns this section red instead of quietly hollowing it out.
const preTerms = await getVerificationSummary('usr_t');
check('PRECONDITION: this user is otherwise complete (identity + payout account)',
  preTerms.level >= 2 && preTerms.hasPayoutAccount === true,
  `level=${preTerms.level} hasPayoutAccount=${preTerms.hasPayoutAccount}`);

const sum = preTerms;
check('the summary reports terms as REQUIRED for a bridge customer',
  sum.terms.required === true, JSON.stringify(sum.terms));
check('and as not yet accepted', sum.terms.accepted === false, JSON.stringify(sum.terms));
check('and hands the UI a link to send the user to',
  sum.terms.link === 'https://bridge.example/tos/abc', JSON.stringify(sum.terms));
/**
 * THE USER'S ACTUAL REQUEST: terms are one of the criteria for being done.
 * pathComplete drives the progress bar and the "Account ready" banner.
 */
check('pathComplete is FALSE while terms are outstanding',
  sum.pathComplete === false,
  'this is the field that decides whether the page says the user is finished');

await db.mutate((d: any) => { d.customers[0].tosStatus = 'approved'; return 1; });
const sumOk = await getVerificationSummary('usr_t');
check('accepted terms are reported accepted', sumOk.terms.accepted === true);
/**
 * THE OTHER HALF, and the one that makes the assertion above mean something:
 * accepting the terms - and changing NOTHING else - flips pathComplete to
 * true. Without this pair, "false while outstanding" is satisfied by a
 * pathComplete that is simply always false.
 */
check('and accepting the terms - alone - completes the path',
  sumOk.pathComplete === true,
  `pathComplete=${sumOk.pathComplete}; only tosStatus changed between the two reads`);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 5. a user who owes nothing is not held back by the step ──');

await db.mutate((d: any) => {
  d.users.push({ id: 'usr_ng', email: 'ng@t.test', emailVerifiedAt: now(), country: 'NG',
    fullName: 'Ngozi Bank', createdAt: now(), updatedAt: now() });
  d.ngnPayoutAccounts = [{ id: 'ngn_1', userId: 'usr_ng', accountNumber: '0123456789',
    bankCode: '058', bankName: 'GTB', accountName: 'Ngozi Bank', status: 'verified',
    createdAt: now(), updatedAt: now() }];
  return 1;
});

const ngSum = await getVerificationSummary('usr_ng');
check('a Nigerian with no Bridge customer is told terms are NOT required',
  ngSum.terms.required === false, JSON.stringify(ngSum.terms));
check('and their path still completes - the step cannot strand them at 99%',
  ngSum.pathComplete === true,
  'hiding the row was the OLD fix for this; the row is now shown only when owed');

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 6. the staleness that would lock out real users ──────────');

/**
 * THE DANGEROUS HALF.
 *
 * `tosStatus` is only as good as what keeps it fresh. Before this change:
 *
 *   - refreshKycStatus() read tos ONLY from the kyc_link, and `return`ed
 *     early when there was no kycLinkId. An admin-imported customer has no
 *     kycLinkId, so it fetched nothing and the field stayed 'pending'.
 *   - the `customer` webhook wrote kycStatus and dropped terms on the floor.
 *     Only a `kyc_link` event could ever move it.
 *
 * Either one, combined with the new gate, refuses withdrawals to a user who
 * accepted Bridge's terms months ago. So both are fixed, and both are pinned
 * here.
 */
const { __applyBridgeWebhookEffectsForTest } = await import('../src/webhooks/webhooks.service.js') as any;

if (typeof __applyBridgeWebhookEffectsForTest === 'function') {
  await db.mutate((d: any) => { d.customers[0].tosStatus = 'pending'; return 1; });
  const data = await db.read();
  await __applyBridgeWebhookEffectsForTest(data, {
    event_category: 'customer',
    event_object_status: 'active',
    event_object: { id: 'bridge_cus_t', status: 'active', has_accepted_terms_of_service: true },
  });
  const after = (await db.read()).customers.find((c: any) => c.id === 'cus_t');
  check('a `customer` webhook carrying terms acceptance now records it',
    after?.tosStatus === 'approved',
    'previously ONLY a kyc_link event could move this field');

  // And it must never move backwards.
  const data2 = await db.read();
  await __applyBridgeWebhookEffectsForTest(data2, {
    event_category: 'customer',
    event_object_status: 'active',
    event_object: { id: 'bridge_cus_t', status: 'active' },
  });
  const after2 = (await db.read()).customers.find((c: any) => c.id === 'cus_t');
  check('a later webhook that OMITS the field does not revoke the acceptance',
    after2?.tosStatus === 'approved',
    'a missing field is "no information", not "they un-accepted"');
} else {
  console.log('  --   webhook effects not exported for test; covered via refreshKycStatus below');
}

/**
 * The customer-object read path, with NO kycLinkId - the case that used to
 * return early and sync nothing.
 */
const { refreshKycStatus } = await import('../src/customers/customers.service.js');
const { MockBridgeProvider } = await import('../src/providers/bridge/mock-bridge.provider.js');

/**
 * PATCHED ON THE PROTOTYPE, not on the provider-registry module.
 *
 * The first attempt reassigned `registry.getOfframpProvider` and died with
 * "Cannot assign to read only property of object '[object Module]'" - ESM
 * namespace objects are frozen. getOfframpProvider() returns `new
 * MockBridgeProvider()` under BRIDGE_MOCK_MODE, so the prototype is the real
 * seam and it needs no production code bent to accommodate the test.
 */
const originalGetCustomer = (MockBridgeProvider as any).prototype.getCustomer;
const originalGetKycLink = (MockBridgeProvider as any).prototype.getKycLink;

await db.mutate((d: any) => {
  d.customers[0].tosStatus = 'pending';
  delete d.customers[0].kycLinkId;
  return 1;
});

const calls = { getCustomer: 0 };
(MockBridgeProvider as any).prototype.getKycLink = async () => {
  throw new Error('must not be called - there is no kycLinkId');
};
(MockBridgeProvider as any).prototype.getCustomer = async (customerId: string) => {
  calls.getCustomer += 1;
  return { id: customerId, status: 'active', tosAccepted: true, raw: {} };
};

const refreshed = await refreshKycStatus('usr_t').catch((e: Error) => e);
check('a customer with NO kycLinkId still gets its terms synced',
  calls.getCustomer > 0,
  'this path used to `return` before fetching anything');
check('and the accepted terms are persisted',
  (refreshed as any)?.tosStatus === 'approved', JSON.stringify(refreshed));

/**
 * A provider blip must not un-accept anyone. This runs on the page-load
 * refresh path, so it fires constantly.
 */
await db.mutate((d: any) => { d.customers[0].tosStatus = 'approved'; return 1; });
(MockBridgeProvider as any).prototype.getCustomer = async () => { throw new Error('Bridge 503'); };
const afterBlip = await refreshKycStatus('usr_t').catch((e: Error) => e);
check('a Bridge outage during refresh does not revoke accepted terms',
  (afterBlip as any)?.tosStatus === 'approved', JSON.stringify(afterBlip));
check('and the outage does not surface as an error to the user',
  !(afterBlip instanceof Error), String(afterBlip));

/**
 * AND THE CONVERSE: a customer object that says terms are NOT accepted must
 * not silently upgrade anyone either.
 */
await db.mutate((d: any) => { d.customers[0].tosStatus = 'pending'; return 1; });
(MockBridgeProvider as any).prototype.getCustomer = async (customerId: string) =>
  ({ id: customerId, status: 'active', tosAccepted: false, raw: {} });
const stillPending = await refreshKycStatus('usr_t').catch((e: Error) => e);
check('a customer Bridge says has NOT accepted stays pending',
  (stillPending as any)?.tosStatus === 'pending', JSON.stringify(stillPending));

(MockBridgeProvider as any).prototype.getCustomer = originalGetCustomer;
(MockBridgeProvider as any).prototype.getKycLink = originalGetKycLink;

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
