/**
 * SIVAN AI MUST ANSWER THE QUESTION IT WAS ASKED.
 *
 * Reported from production, with screenshots: pasting an NGN request id
 * returned a status report about an unrelated buy order, and clicking the
 * "Verification help" chip returned the same thing. Both at confidence: high,
 * both ending "No action is needed right now."
 *
 * Reproduced exactly against the real service before any fix:
 *
 *   ASKED: "ngnt_f17c5017-564e-4fc5-82cc-e29513ead925"
 *   > Your buy order is currently awaiting payment with bridge.
 *   > Request ID: or_17f19d8b-6385-4e14-a491-8f616c7a02df
 *
 * Four separate causes, each covered here:
 *   1. the intent classifier had no verification rule - everything was 'general'
 *   2. 'general' meant "attach the newest transaction", so any question got one
 *   3. ngn_transfer was not a resource type at all, so ngnt_ ids never resolved
 *   4. verification evidence was never gathered, so the model could not answer
 *
 * WHY THE ASSERTIONS CHECK FOR ABSENCE. The dangerous output is not a missing
 * answer, it is a fluent answer about the WRONG record. So the load-bearing
 * assertions are "the reply must not mention or_17f19d8b" - a test that only
 * checked for the presence of good words would pass while the bug was live.
 *
 * Run: npx tsx scripts/test-ace-intent-routing.ts
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.SIVAN_DATA_FILE = '/tmp/ace-intent-test.json';
process.env.DATABASE_FILE = '/tmp/ace-intent-test.json';
process.env.ACE_PROVIDER = 'local';

import fs from 'node:fs';
import { classifyAceMessage, detectReference } from '../src/ace/service/ace-intent.service.js';

let pass = 0;
let fail = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
};

const NOW = new Date().toISOString();
const ORDER_ID = 'or_17f19d8b-6385-4e14-a491-8f616c7a02df';
const NGN_ID = 'ngnt_f17c5017-564e-4fc5-82cc-e29513ead925';
const VA_ID = 'va_deposit-2222-3333';
const BTX_ID = 'btx_9f2c1a84-3b7e-4d21-9c55-0a1b2c3d4e5f';
const SPP_ID = 'spp_7c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f';
const DEP_ID = 'dep_6999232a-578c-4486-aedd-0a4a02d3b43c';
/** Deliberately older, so a fallthrough would NOT pick it - only a real lookup can. */
const OLDER = new Date(Date.now() - 86_400_000).toISOString();

/**
 * The seed reproduces the reporter's account: an NGN payout mid-settlement AND
 * an older buy order. Both must exist - with only one record every lookup
 * resolves to it and the test cannot tell right from wrong.
 */
function seed() {
  fs.writeFileSync(process.env.SIVAN_DATA_FILE!, JSON.stringify({
    users: [{ id: 'usr_1', email: 'a@b.com', fullName: 'Test User', country: 'NG', createdAt: NOW }],
    customers: [{ id: 'cus_1', userId: 'usr_1', kycStatus: 'kyc_approved', createdAt: NOW }],
    withdrawals: [],
    onrampOrders: [{ id: ORDER_ID, userId: 'usr_1', status: 'awaiting_payment', provider: 'bridge', amount: '100', sourceCurrency: 'usd', createdAt: NOW, updatedAt: NOW }],
    ngnTransfers: [{ id: NGN_ID, userId: 'usr_1', quoteId: 'q1', direction: 'offramp', status: 'settlement_processing', provider: 'breet', sourceCurrency: 'usdt', destinationCurrency: 'ngn', sourceAmount: '15', destinationAmount: '24697.89', rate: '1600', feeAmount: '50', metadata: { transferMetadata: { payoutAccountId: 'pa_1' } }, createdAt: NOW, updatedAt: NOW }],
    virtualAccountTransactions: [{ id: VA_ID, userId: 'usr_1', status: 'settled', amount: '500', currency: 'usd', createdAt: OLDER, updatedAt: OLDER }],
    /**
     * The three kinds the activity feed shows but ACE could not answer.
     * All seeded OLDER than the buy order so a fallthrough would pick the
     * WRONG row - only a real lookup can resolve them.
     */
    walletDeposits: [{ id: DEP_ID, userId: 'usr_1', walletId: 'w1', address: '4JStq', chain: 'solana', asset: 'usdc', amount: '19.500000', status: 'confirmed', detectionSource: 'balance_poll', idempotencyKey: 'k1', createdAt: OLDER, updatedAt: OLDER }],
    supplierPayments: [{ id: SPP_ID, userId: 'usr_1', supplierId: 'sup_1', amount: '305', netAmount: '300', destinationCurrency: 'gbp', status: 'processing', externalAccountId: 'ext_1', createdAt: OLDER, updatedAt: OLDER }],
    externalAccounts: [{ id: 'ext_1', userId: 'usr_1', customerId: 'cus_1', provider: 'bridge', providerExternalAccountId: 'p1', currency: 'gbp', accountType: 'gb', bankName: 'Barclays', accountOwnerName: 'ABC Trading Ltd', accountLast4: '4321', paymentRail: 'faster_payments', status: 'active', createdAt: OLDER }],
    ngnPayoutAccounts: [{ id: 'pa_1', userId: 'usr_1', provider: 'breet', bankId: '25', bankName: 'OPay - Paycom', accountNumber: '8079604214', accountName: 'SAMSON MICHEAL OLALEYE', declaredName: 'SAMSON MICHEAL OLALEYE', matchVerdict: 'match', status: 'verified', createdAt: OLDER }],
    supportTickets: [], systemIncidents: [], webhookEvents: [], transactionReferences: [],
    reconciliationFindings: [],
    /* externalAccounts and ngnPayoutAccounts are seeded ABOVE. They were
       redeclared as [] here, and a later duplicate key silently wins in an
       object literal - so the seeded rows vanished and payoutDestinationFor()
       correctly found nothing. The assertion caught it; the bug was the
       fixture, not the resolver. */
    aceSupportSessions: [], aceSupportMessages: [], aceToolCalls: [], aceResolutions: [],
    /** A crypto send lives in the audit trail, not a table - see balanceTransferRows(). */
    auditLogs: [{ id: 'al_1', action: 'balance.transfer_completed', actorType: 'user', actorId: 'usr_1', resourceType: 'balance_transfer', resourceId: BTX_ID, createdAt: OLDER, metadata: { transferId: BTX_ID, userId: 'usr_1', asset: 'usdc', network: 'solana', amount: '80', status: 'completed', destinationAddress: 'HN7cAB', txHash: '5CVfPVMp', createdAt: OLDER, updatedAt: OLDER } }],
  }, null, 2));
}
seed();

const { answerAceSupport } = await import('../src/ace/service/ace-support.service.js');
const ask = async (message: string) => answerAceSupport({ userId: 'usr_1', message, channel: 'web_dashboard' });

console.log('\n1. the intent classifier actually classifies');

check('a verification question is verification, not general',
  classifyAceMessage('I need help with verification.').intent === 'verification',
  classifyAceMessage('I need help with verification.').intent);
check('"kyc" alone is understood',
  classifyAceMessage('kyc').intent === 'verification');
check('NIN and BVN are verification words',
  classifyAceMessage('do you need my BVN?').intent === 'verification');
check('a 2FA question routes to account recovery',
  classifyAceMessage('How do I recover 2FA or account access?').intent === 'account_recovery');
check('a deposit question routes to deposit',
  classifyAceMessage('Why is my virtual account deposit not showing?').intent === 'deposit');
check('a payout question routes to transaction',
  classifyAceMessage('where is my payout').intent === 'transaction');

/**
 * THE PRECEDENCE RULE. A verification question that happens to contain a money
 * word is still a verification question - otherwise the fix reintroduces the
 * original bug through the back door.
 */
check('"cannot withdraw until verified" is a VERIFICATION question',
  classifyAceMessage('I cannot withdraw until my verification is done').intent === 'verification',
  classifyAceMessage('I cannot withdraw until my verification is done').intent);

check('an unrelated greeting is not force-fitted to a topic',
  classifyAceMessage('hello').intent === 'unknown',
  classifyAceMessage('hello').intent);

console.log('\n2. pasted references are detected and routed');

check('an ngnt_ id is recognised as an NGN transfer',
  detectReference(NGN_ID)?.resourceType === 'ngn_transfer',
  String(detectReference(NGN_ID)?.resourceType));
check('an or_ id is recognised as a buy order',
  detectReference(ORDER_ID)?.resourceType === 'onramp_order');
check('a wd_ id is recognised as a withdrawal',
  detectReference('wd_1234abcd-5678')?.resourceType === 'withdrawal');
check('the id itself is extracted, not just the type',
  detectReference(NGN_ID)?.resourceId === NGN_ID,
  String(detectReference(NGN_ID)?.resourceId));
check('a reference inside a sentence is still found',
  detectReference(`please check ${NGN_ID} for me`)?.resourceId === NGN_ID);
check('ordinary prose containing "or" does not match',
  detectReference('should I use naira or dollars') === undefined,
  JSON.stringify(detectReference('should I use naira or dollars')));

console.log('\n3. the answer is about what was asked');

const ngnAnswer = await ask(NGN_ID);
check('pasting an NGN id answers about THAT payout',
  ngnAnswer.answer.includes(NGN_ID), ngnAnswer.answer.slice(0, 90));
/** The load-bearing one: the exact wrong-answer from the bug report. */
check('and never mentions the unrelated buy order',
  !ngnAnswer.answer.includes(ORDER_ID),
  `leaked ${ORDER_ID} - this is the original defect`);
check('an NGN payout is called a naira payout, not a buy order',
  !/buy order/i.test(ngnAnswer.answer), ngnAnswer.answer.slice(0, 90));
check('the naira timeline is used',
  /converted|payout|settlement/i.test(ngnAnswer.answer), ngnAnswer.answer.slice(0, 120));

const verif = await ask('I need help with verification.');
check('a verification question gets a verification answer',
  /verification/i.test(verif.answer) && /level/i.test(verif.answer),
  verif.answer.slice(0, 90));
/** The reported bug, asserted directly. */
check('a verification question does NOT return a transaction report',
  !verif.answer.includes(ORDER_ID) && !verif.answer.includes(NGN_ID),
  'a transaction id leaked into a verification answer');
check('and it does not claim to be a buy order status',
  !/buy order is currently/i.test(verif.answer), verif.answer.slice(0, 90));
check('the real level is quoted from the verification record',
  /Level \d/i.test(verif.answer), verif.answer.slice(0, 90));

/**
 * A COMPLETE USER MUST NOT BE HANDED A LIST OF FAILURES.
 *
 * Caught by reading the rendered answer: the first version said "complete" and
 * then listed four checks as "Still outstanding", because checks that are not
 * on the user's path report `not_started`. A flat contradiction on the one
 * screen where someone is trying to learn whether they are done.
 */
/**
 * Raw object keys must never reach a customer. Caught in a screenshot: the
 * answer listed "proofOfAddress (not started)" and "nin" - database columns,
 * not English.
 */
check('check names are human copy, not field names',
  !/proofOfAddress|sourceOfFunds/.test(verif.answer),
  verif.answer);
check('and the NIN acronym is expanded',
  !/⏳ nin \(|✅ nin \(/.test(verif.answer), verif.answer);

check('a complete user is not told things are outstanding',
  !(/complete/i.test(verif.answer) && /Still outstanding/i.test(verif.answer)),
  verif.answer);

const recovery = await ask('How do I recover 2FA or account access?');
check('a 2FA question is escalated to a human',
  recovery.needsHuman === true, `needsHuman=${recovery.needsHuman}`);
check('and it does not describe a transaction',
  !recovery.answer.includes(ORDER_ID) && !recovery.answer.includes(NGN_ID),
  recovery.answer.slice(0, 90));

console.log('\n4. it asks rather than guessing');

const vague = await ask('hello');
check('an open question does not attach a transaction',
  !vague.answer.includes(ORDER_ID) && !vague.answer.includes(NGN_ID),
  `guessed a transaction for "hello": ${vague.answer.slice(0, 90)}`);
check('and it asks the user what they mean',
  /which|tell me|what.*mean|Request ID/i.test(vague.answer), vague.answer.slice(0, 90));
check('an open question is not reported as high confidence',
  vague.confidence !== 'high', vague.confidence);

const missing = await ask('ngnt_does-not-exist-999999');
check('an unknown reference is named as not found',
  /could not find/i.test(missing.answer) && missing.answer.includes('ngnt_does-not-exist-999999'),
  missing.answer.slice(0, 120));
check('an unknown reference does not fall back to another transaction',
  !missing.answer.includes(ORDER_ID) && !missing.answer.includes(NGN_ID),
  'substituted a different transaction for one that was not found');

console.log('\n4b. every declared resource type has a lookup');

/**
 * virtual_account_transaction was DECLARED in AceResourceType and routed to by
 * detectReference, but findTransaction had no branch for it - so it fell into
 * the transaction_lookup race and returned the newest record of any kind.
 *
 * Measured before the fix: pasting va_deposit-2222-3333 returned
 * "Your buy order is currently awaiting payment with bridge."
 *
 * The VA row is seeded OLDER than the buy order on purpose. If the lookup were
 * still falling through, the newest record wins and the assertion fails; a
 * same-age fixture would pass either way.
 */
const vaAnswer = await ask(VA_ID);
check('a va_ reference resolves to that deposit',
  vaAnswer.answer.includes(VA_ID), vaAnswer.answer.slice(0, 100));
check('and a va_ reference never returns the buy order',
  !vaAnswer.answer.includes(ORDER_ID),
  `leaked ${ORDER_ID} - virtual_account_transaction has no lookup branch`);
check('a deposit is called a deposit, not a buy order',
  !/buy order/i.test(vaAnswer.answer), vaAnswer.answer.slice(0, 100));

const vaMissing = await ask('va_not-real-999999');
check('an unknown va_ reference is reported as not found',
  /could not find/i.test(vaMissing.answer), vaMissing.answer.slice(0, 100));
check('and does not substitute another transaction',
  !vaMissing.answer.includes(ORDER_ID) && !vaMissing.answer.includes(NGN_ID),
  vaMissing.answer.slice(0, 100));

console.log('\n4c. the three kinds the activity feed shows but ACE could not answer');

/**
 * activityFeed.ts emits seven kinds; AceResourceType carried four. A user who
 * opened a crypto send, supplier payout or wallet deposit and pressed "Ask
 * Sivan about this transaction" was told the reference could not be found -
 * worse than no button, because it reads as "your transaction is missing".
 *
 * Each is seeded OLDER than the buy order deliberately: if the lookup were
 * still falling through to "newest of any kind", these would resolve to
 * ORDER_ID and the assertions below would fail. A same-age fixture would pass
 * either way.
 */
for (const [label, id, prefixKind] of [
  ['a crypto send', BTX_ID, 'crypto send'],
  ['a supplier payment', SPP_ID, 'supplier payment'],
  ['a wallet deposit', DEP_ID, 'wallet deposit'],
] as const) {
  const answer = await ask(id);
  check(`${label} resolves to itself`, answer.answer.includes(id), answer.answer.slice(0, 100));
  check(`${label} never returns the buy order`,
    !answer.answer.includes(ORDER_ID),
    `leaked ${ORDER_ID} - the lookup fell through`);
  check(`${label} is named correctly, not "buy order"`,
    answer.answer.toLowerCase().includes(prefixKind),
    answer.answer.slice(0, 100));
}

console.log('\n4d. the payout destination, masked');

/**
 * "Which account was I paid into" is the commonest follow-up on a payout, and
 * the bundle carried no destination at all. It is included MASKED because
 * evidenceItems ships to an external model - a full NUBAN beside an account
 * name is a social-engineering kit.
 */
const ngnAnswerWithBank = await ask(NGN_ID);
check('a naira payout names the bank it was sent to',
  /OPay/i.test(ngnAnswerWithBank.answer), ngnAnswerWithBank.answer.slice(-220));
check('and shows only the last four digits',
  ngnAnswerWithBank.answer.includes('4214'), ngnAnswerWithBank.answer.slice(-220));
/** THE LOAD-BEARING ONE. The full NUBAN must never appear. */
check('and NEVER the full account number',
  !ngnAnswerWithBank.answer.includes('8079604214'),
  'the unmasked NUBAN leaked into an answer that is shipped to an external model');

console.log('\n5. transaction questions still work');

const tx = await ask('where is my transaction?');
check('an unspecified transaction question still resolves to the latest',
  Boolean(tx.answer.includes(NGN_ID) || tx.answer.includes(ORDER_ID)),
  tx.answer.slice(0, 90));
check('and it reports a real status',
  /currently/i.test(tx.answer), tx.answer.slice(0, 90));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (failures.length) console.log(`   ${failures.join('\n   ')}`);
process.exit(fail === 0 ? 0 : 1);
