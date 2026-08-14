/**
 * NAIRA MUST LAND IN THE ACCOUNT THE USER CHOSE.
 *
 * A naira off-ramp is an irreversible bank transfer. The single worst outcome
 * in this file is money arriving in the wrong NUBAN, and until now that was
 * reachable without anybody doing anything wrong.
 *
 * WHAT WAS BROKEN.
 *
 * `createNgnQuoteSchema` accepts only userId, direction, sourceCurrency,
 * destinationCurrency, sourceAmount and network. `acceptNgnQuoteSchema` accepts
 * only userId, quoteId, pin and stepUpToken. Neither carries a destination
 * account. The quote instead resolved the bank itself:
 *
 *     const accounts = await db.listNgnPayoutAccounts(input.userId);
 *     const verified = accounts.find((a) => a.status === 'verified');
 *
 * `.find()` returns the FIRST verified row, and listNgnPayoutAccounts applies
 * no ordering - it is raw insertion order. So a user with two verified accounts
 * was always paid into whichever they happened to save first, no matter which
 * one the withdrawal screen showed them. The account number typed into
 * NgnPayoutForm never left the browser.
 *
 * That is not a UI defect. The screen said one account and the rail used
 * another.
 *
 * WHAT THIS ASSERTS.
 *
 * The destination now travels with the request as `payoutAccountId`, and the
 * server treats it as a claim to verify, never as data to trust: it must name
 * a row belonging to THIS user and that row must be `verified`. The tests
 * below drive the real createNgnQuote and read the bank off the quote it
 * writes, because metadata is what breet.provider.ts reads to switch
 * autoSettlement on - a returned flag would prove nothing.
 *
 * Run: npm run test:ngn-payout-destination
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-ngn-payout-destination.json';
process.env.WALLET_PROVIDER = 'mock';
process.env.NGN_PROVIDER = 'mock';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'payout-destination-admin-key';
process.env.USER_JWT_SECRET = 'payout-destination-jwt-secret-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';

import fs from 'node:fs';
fs.rmSync('.data/test-ngn-payout-destination.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { db } = await import('../src/database/json-database.js');
const { createNgnQuote } = await import('../src/ngn/service/ngn-quotes.service.js');

const now = () => new Date().toISOString();

/**
 * TWO verified accounts, saved in a known order. The bug only becomes visible
 * with more than one: with a single saved account `.find()` and an explicit
 * choice agree, which is why this went unnoticed.
 */
const FIRST_SAVED = '1111111111';   // saved first -> what .find() returns
const SECOND_SAVED = '2222222222';  // what the user actually picks below

await db.mutate((d: any) => {
  d.users = [{ id: 'usr_p', email: 'p@t.test', emailVerifiedAt: now(), country: 'NG',
    fullName: 'OGUNMEPON SHARAFA', createdAt: now(), updatedAt: now() }];
  d.ngnPayoutAccounts = [
    { id: 'acct_first', userId: 'usr_p', provider: 'mock', bankId: '1', bankName: 'Access Bank',
      accountNumber: FIRST_SAVED, accountName: 'OGUNMEPON SHARAFA', declaredName: 'OGUNMEPON SHARAFA',
      matchVerdict: 'match', matchScore: 1, resolutionTrustworthy: true,
      status: 'verified', createdAt: now(), updatedAt: now() },
    { id: 'acct_second', userId: 'usr_p', provider: 'mock', bankId: '2', bankName: 'GTBank',
      accountNumber: SECOND_SAVED, accountName: 'OGUNMEPON SHARAFA', declaredName: 'OGUNMEPON SHARAFA',
      matchVerdict: 'match', matchScore: 1, resolutionTrustworthy: true,
      status: 'verified', createdAt: now(), updatedAt: now() },
    // Queued for a human. Must never be payable, however it is asked for.
    { id: 'acct_pending', userId: 'usr_p', provider: 'mock', bankId: '3', bankName: 'Zenith',
      accountNumber: '3333333333', accountName: 'SOMEONE ELSE', declaredName: 'OGUNMEPON SHARAFA',
      matchVerdict: 'review', matchScore: 0.4, resolutionTrustworthy: true,
      status: 'pending_review', createdAt: now(), updatedAt: now() },
  ];
  // A SECOND user, with their own verified account. Nobody may pay into it.
  d.users.push({ id: 'usr_other', email: 'other@t.test', emailVerifiedAt: now(), country: 'NG',
    fullName: 'SOMEBODY ELSE', createdAt: now(), updatedAt: now() });
  d.ngnPayoutAccounts.push({ id: 'acct_stranger', userId: 'usr_other', provider: 'mock', bankId: '4',
    bankName: 'UBA', accountNumber: '9999999999', accountName: 'SOMEBODY ELSE', declaredName: 'SOMEBODY ELSE',
    matchVerdict: 'match', matchScore: 1, resolutionTrustworthy: true,
    status: 'verified', createdAt: now(), updatedAt: now() });
  d.ngnControls = [{ id: 'global', onrampEnabled: true, offrampEnabled: true, mockProviderEnabled: true,
    bankSettlementEnabled: true, virtualAccountEnabled: false, activeProvider: 'mock',
    identityVerificationEnabled: false, externalFundingEnabled: false,
    limitEnforcementOfframp: false, limitEnforcementOnramp: false, limitEnforcementEscrow: false,
    maxTransactionNgn: '5000000', dailyLimitNgn: '20000000', highValueReviewThresholdNgn: '10000000',
    updatedBy: 'seed', updatedAt: now() }];
  return 1;
});

function quoteInput(extra: Record<string, unknown> = {}) {
  return {
    userId: 'usr_p', direction: 'offramp', sourceCurrency: 'usdc',
    destinationCurrency: 'ngn', sourceAmount: '20', network: 'solana', ...extra,
  } as any;
}

/** The bank that breet.provider.ts will actually read off the quote. */
function bankOn(quote: any) {
  const m = (quote?.metadata ?? {}) as any;
  return { bankId: m.bankId, accountNumber: m.accountNumber, accountName: m.accountName };
}

console.log('\n── the chosen account is the one that gets paid ──────────────');

const chosen = await createNgnQuote(quoteInput({ payoutAccountId: 'acct_second' }));
const chosenBank = bankOn(chosen);

check('the quote carries the account the user picked',
  chosenBank.accountNumber === SECOND_SAVED,
  `carried ${chosenBank.accountNumber}, user picked ${SECOND_SAVED}`);
check('and NOT merely the first one on file',
  chosenBank.accountNumber !== FIRST_SAVED,
  `carried ${FIRST_SAVED}, which is the .find() answer and the bug`);
check('the bank id travels with it',
  chosenBank.bankId === '2',
  `${chosenBank.bankId} - a right number at the wrong bank is still a failed payout`);

console.log('\n── an unspecified destination still works, and is unambiguous ─');

/**
 * Omitting the field must keep older clients working, but "the first row we
 * happen to find" is not a defensible default for a bank transfer. With
 * exactly one verified account there is no ambiguity; with several there is,
 * and the honest answer is to refuse rather than guess.
 */
let ambiguousError = '';
try {
  await createNgnQuote(quoteInput());
} catch (error) {
  ambiguousError = (error as Error).message;
}
check('two verified accounts and no choice is REFUSED, not guessed',
  ambiguousError.length > 0,
  'silently picking one is how money reaches the wrong bank');
check('and the refusal tells the user what to do',
  /choose|select|which/i.test(ambiguousError),
  ambiguousError);

console.log('\n── a destination the user does not own is refused ────────────');

let strangerError = '';
try {
  await createNgnQuote(quoteInput({ payoutAccountId: 'acct_stranger' }));
} catch (error) {
  strangerError = (error as Error).message;
}
check("another user's account cannot be named as the destination",
  strangerError.length > 0,
  'a client-supplied id must be a claim to verify, never a lookup key to trust');
check('and the refusal does not confirm the account exists',
  !/somebody else|9999999999/i.test(strangerError),
  `${strangerError} - leaking whether an id is real turns this into an enumeration oracle`);

console.log('\n── a pending-review account cannot be paid ───────────────────');

let pendingError = '';
try {
  await createNgnQuote(quoteInput({ payoutAccountId: 'acct_pending' }));
} catch (error) {
  pendingError = (error as Error).message;
}
check('an account queued for human review is refused',
  pendingError.length > 0,
  'auto-paying it would defeat the review queue entirely');

console.log('\n── an id that does not exist is refused ──────────────────────');

let missingError = '';
try {
  await createNgnQuote(quoteInput({ payoutAccountId: 'acct_does_not_exist' }));
} catch (error) {
  missingError = (error as Error).message;
}
check('an unknown account id is refused', missingError.length > 0, missingError);

console.log('\n── one verified account: no choice needed ────────────────────');

await db.mutate((d: any) => {
  d.ngnPayoutAccounts = d.ngnPayoutAccounts.filter((a: any) => a.id !== 'acct_second');
  return 1;
});

const soleQuote = await createNgnQuote(quoteInput());
check('with a single verified account the quote still prices',
  Boolean(soleQuote?.id),
  'a first-time user must not be blocked by a choice they cannot make');
check('and it uses that account',
  bankOn(soleQuote).accountNumber === FIRST_SAVED,
  JSON.stringify(bankOn(soleQuote)));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
