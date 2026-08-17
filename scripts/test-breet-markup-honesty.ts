/**
 * A FAILED MARKUP READ MUST NOT PRICE AS 0%.
 *
 * Live has been in `breet_markup` revenue mode since 2026-08-14, so the whole
 * of Sivan's naira off-ramp revenue is one number read from Breet on every
 * quote. That read was:
 *
 *     try  { ...GET /users/fetch-integration... }
 *     catch { return 0; }
 *
 * A timeout, an auth error and a genuine 0% markup all produced the same
 * answer. The quote then looked completely normal - the user is charged, Breet
 * is paid, Sivan earns nothing, and nothing anywhere records that the read
 * failed. Same shape as the reconciler reporting `checked: 0` while blind.
 *
 * WHAT THIS ASSERTS. Not "the number is right" - that is arithmetic already
 * covered elsewhere - but that the three cases are DISTINGUISHABLE and that
 * the money-losing one is never silent:
 *
 *   provider read works        -> priced from the live value
 *   read fails, cache warm     -> priced from last known, logged, flagged
 *   read fails, no cache       -> refuses to quote rather than earn nothing
 *
 * Run: npm run test:breet-markup-honesty
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-breet-markup-honesty.json';
process.env.SIVAN_DATA_FILE = '.data/test-breet-markup-honesty.json';
process.env.NGN_PROVIDER = 'breet';
process.env.WALLET_PROVIDER = 'mock';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'markup-admin-key';
process.env.BREET_APP_ID = 'test_app_id';
process.env.BREET_APP_SECRET = 'test_app_secret';
process.env.BREET_ENV = 'development';

import fs from 'node:fs';
fs.rmSync('.data/test-breet-markup-honesty.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { db } = await import('../src/database/json-database.js');
const { BreetNgnProvider } = await import('../src/ngn/provider/breet.provider.js');
const { createNgnQuote } = await import('../src/ngn/service/ngn-quotes.service.js');

const now = () => new Date().toISOString();

/**
 * Stubbed at getIntegration - the single call getBreetMarkupDetailed depends
 * on - so the real caching and fallback logic above it is exercised rather
 * than replaced.
 */
let integrationMode: 'ok' | 'throws' = 'ok';
let markupValue = 1;
(BreetNgnProvider as any).prototype.getIntegration = async () => {
  if (integrationMode === 'throws') throw new Error('Breet: wrong app id and secret combination');
  return { markupPercent: markupValue, platformFeePercent: 0.5 };
};

/** Pricing is stubbed: this suite is about the markup, not the rate. */
(BreetNgnProvider as any).prototype.createQuote = async (input: any) => {
  const source = Number(input.sourceAmount);
  const rate = 1500;
  return {
    provider: 'breet', providerQuoteId: 'bq_test',
    sourceAmount: source.toFixed(2),
    destinationAmount: (source * rate).toFixed(2),
    rate: rate.toFixed(2),
    feeAmount: (source * 0.005).toFixed(6),
    metadata: { network: input.network, assetId: 'asset_usdt_sol_dev' },
  };
};

async function seed(revenueMode = 'breet_markup') {
  await db.mutate((d: any) => {
    d.users = [{ id: 'usr_m', email: 'm@t.test', emailVerifiedAt: now(), country: 'NG',
      fullName: 'OGUNMEPON SHARAFA', createdAt: now(), updatedAt: now() }];
    d.ngnPayoutAccounts = [{ id: 'acct_m', userId: 'usr_m', provider: 'breet', bankId: '25',
      bankName: 'OPay - Paycom', accountNumber: '8079604214', accountName: 'OGUNMEPON SHARAFA',
      declaredName: 'OGUNMEPON SHARAFA', matchVerdict: 'match', matchScore: 1,
      resolutionTrustworthy: true, status: 'verified', createdAt: now(), updatedAt: now() }];
    d.ngnControls = [{ id: 'global', onrampEnabled: true, offrampEnabled: true,
      mockProviderEnabled: false, bankSettlementEnabled: true, virtualAccountEnabled: false,
      activeProvider: 'breet', identityVerificationEnabled: false, externalFundingEnabled: false,
      thirdPartyPayoutsEnabled: false, offrampRevenueMode: revenueMode,
      limitEnforcementOfframp: false, limitEnforcementOnramp: false, limitEnforcementEscrow: false,
      maxTransactionNgn: '5000000', dailyLimitNgn: '20000000',
      highValueReviewThresholdNgn: '10000000', updatedBy: 'seed', updatedAt: now() }];
    d.auditLogs = [];
    return 1;
  });
}

const quote = () => createNgnQuote({
  userId: 'usr_m', direction: 'offramp', sourceCurrency: 'usdt',
  destinationCurrency: 'ngn', sourceAmount: '20', network: 'solana',
  payoutAccountId: 'acct_m',
} as any);

console.log('\n── a healthy read prices from the live value ─────────────────');

await seed();
integrationMode = 'ok';
markupValue = 1;
let q: any = await quote();
let fees = (q.metadata as any)?.fees ?? {};

/**
 * `sivanMarginNgn`, not `sivanMargin`. On an off-ramp `sivanMargin` is
 * denominated in the SOURCE ASSET (0.2 USDT), while the naira figure lives in
 * its own field. My first version asserted 300 against the asset number and
 * failed - my arithmetic, not the pricing. Both are checked now, because a
 * mismatch between them is exactly the unit bug this codebase has hit before.
 */
check('the 1% you set in the Breet dashboard reaches the quote',
  Math.abs(Number(fees.sivanMarginNgn) - 300) < 1,
  `sivanMarginNgn=${fees.sivanMarginNgn}, expected ~300 (1% of 30000 NGN)`);
check('and the same margin is reported in the source asset',
  Math.abs(Number(fees.sivanMarginAsset) - 0.2) < 0.01,
  `sivanMarginAsset=${fees.sivanMarginAsset}, expected ~0.2 USDT`);
check('the user receives the gross minus that margin',
  Math.abs(Number(q.destinationAmount) - (30000 - Number(fees.sivanMarginNgn))) < 1,
  `${q.destinationAmount}`);
check('the quote records that the figure came from the provider',
  fees.markupKnown === true && fees.markupSource === 'provider',
  JSON.stringify({ known: fees.markupKnown, source: fees.markupSource }));

console.log('\n── a failed read falls back to last known, and says so ───────');

integrationMode = 'throws';
q = await quote();
fees = (q.metadata as any)?.fees ?? {};

check('pricing survives a Breet outage at the last known markup',
  Math.abs(Number(fees.sivanMarginNgn) - 300) < 1,
  `sivanMarginNgn=${fees.sivanMarginNgn} - falling back to 0 would give the money away`);
check('the quote is flagged as not provider-confirmed',
  fees.markupKnown === false && fees.markupSource === 'last_known',
  JSON.stringify({ known: fees.markupKnown, source: fees.markupSource }));
check('and the explanation says the value was not read, not that it is 0%',
  /could not be read/i.test(String(fees.explanation)),
  String(fees.explanation));

const unavailableLogs = await db.listAuditLogsByActions(['ngn.breet_markup_unavailable']);
check('an error-severity audit log is raised for the failed read',
  unavailableLogs.length >= 1 && unavailableLogs[0].severity === 'error',
  JSON.stringify(unavailableLogs.map((l: any) => [l.action, l.severity])));
check('the log names what it fell back to',
  (unavailableLogs[0]?.metadata as any)?.fellBackTo === 1,
  JSON.stringify(unavailableLogs[0]?.metadata));

console.log('\n── with no cache at all, it refuses rather than earn nothing ─');

/**
 * The first quote after a deploy, during a Breet outage. There is no last
 * known value, so pricing at 0% would be a real revenue loss on a quote that
 * looks entirely normal.
 */
(BreetNgnProvider as any).lastKnownMarkupPercent = undefined;
await seed();
integrationMode = 'throws';

let refusal = '';
try {
  await quote();
} catch (error) {
  refusal = error instanceof Error ? error.message : String(error);
}
check('the quote is refused when the markup is completely unknown',
  refusal.length > 0,
  'pricing at 0% here is Sivan working for free, silently');
check('and the refusal does not leak the provider name to the user',
  !/breet/i.test(refusal),
  refusal);

console.log('\n── a genuine 0% is still honoured ───────────────────────────');

await seed();
integrationMode = 'ok';
markupValue = 0;
q = await quote();
fees = (q.metadata as any)?.fees ?? {};

check('a deliberately configured 0% markup still quotes',
  Boolean(q?.id), 'refusing here would block an operator who wants zero revenue');
check('with no Sivan margin applied',
  Number(fees.sivanMarginNgn) === 0, `${fees.sivanMarginNgn}`);
check('and it is reported as known, not as a failure',
  fees.markupKnown === true,
  JSON.stringify({ known: fees.markupKnown, source: fees.markupSource }));

console.log('\n── the double-charge guard still fires ──────────────────────');

await seed('sivan_fee_wallet');
integrationMode = 'ok';
markupValue = 1;

let doubleCharge = '';
try {
  await quote();
} catch (error) {
  doubleCharge = error instanceof Error ? error.message : String(error);
}
check('a Breet markup while in wallet-fee mode is still refused',
  /markup/i.test(doubleCharge),
  doubleCharge || 'the user would be charged by Breet AND by the Sivan fee wallet');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
