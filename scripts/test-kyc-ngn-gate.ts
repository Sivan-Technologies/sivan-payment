/**
 * The NGN quote gate, end to end against a real database.
 *
 * Before this change, createNgnQuote() required a Bridge customer with
 * kycStatus 'kyc_approved' before ANY naira transfer. Bridge charges $2 per
 * KYC, and Bridge is not in the NGN path at all - naira moves bank -> NGN
 * provider -> bank. So Sivan was spending $2 of real money to authorise
 * transactions Bridge never saw, and refusing every user who had not paid it.
 *
 * What must now be true:
 *
 *   1. a user with NO Bridge customer can transact on NGN rails
 *   2. their ceiling is their Sivan level, applied cumulatively
 *   3. an unverified user still cannot move anything
 *   4. Bridge is never consulted for a naira quote
 *
 * Run: npm run test:kyc-ngn-gate
 */

import { db } from '../src/database/json-database.js';
import { createNgnQuote } from '../src/ngn/service/ngn-quotes.service.js';
import { getVerificationState, getCumulativeNgnVolume } from '../src/kyc/service/verification-state.js';
import { VerificationLevel, VOLUME_WINDOW_DAYS } from '../src/kyc/types/verification.types.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function quoteFails(userId: string, amount: string, direction: 'onramp' | 'offramp' = 'onramp') {
  try {
    await createNgnQuote({
      userId,
      direction,
      sourceCurrency: direction === 'onramp' ? 'ngn' : 'usdc',
      destinationCurrency: direction === 'onramp' ? 'usdc' : 'ngn',
      sourceAmount: amount,
    });
    return undefined;
  } catch (error: any) {
    return String(error?.message ?? error);
  }
}

async function seed() {
  await db.mutate((data: any) => {
  data.users = [
    { id: 'usr_none', email: 'none@test.ng', createdAt: new Date().toISOString() },
    { id: 'usr_bank', email: 'bank@test.ng', createdAt: new Date().toISOString() },
  ] as any;

  // NO customers at all. Under the old gate this alone blocked everything.
  data.customers = [] as any;

  data.externalAccounts = [
    {
      id: 'ext_1',
      userId: 'usr_bank',
      status: 'verified',
      currency: 'ngn',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ] as any;

  data.ngnTransfers = [] as any;
  data.ngnQuotes = [] as any;

  // NGN rails are disabled by default and capped per transaction. Those are
  // separate operational controls; this test is about the KYC gate, so turn
  // them on and lift the per-transaction cap above the tiers being exercised.
  (data.ngnControls as any) = [{
    id: 'global',
    onrampEnabled: true,
    offrampEnabled: true,
    mockProviderEnabled: true,
    bankSettlementEnabled: false,
    virtualAccountEnabled: false,
    activeProvider: 'mock',
    maxTransactionNgn: '100000000',
    dailyLimitNgn: '100000000',
    highValueReviewThresholdNgn: '100000000',
    updatedBy: 'test',
    updatedAt: new Date().toISOString(),
  }];
  });
}

async function main() {
  await seed();

  console.log('\nverification state derives from evidence, not from a Bridge row');
  {
    const none = await getVerificationState('usr_none');
    check('a user with no bank and no Bridge customer is Level 0',
      none.level === VerificationLevel.NONE, `level ${none.level}`);
    check('and does NOT error just because Bridge has never seen them',
      none.bridgeKycStatus === undefined);

    const bank = await getVerificationState('usr_bank');
    check('a verified payout account alone reaches Level 1',
      bank.level === VerificationLevel.BANK, `level ${bank.level}`);
  }

  console.log('\nthe old blocker is gone: no Bridge customer, naira still moves');
  {
    const err = await quoteFails('usr_bank', '50000');
    check('NGN 50,000 on-ramp succeeds with NO Bridge customer', err === undefined, err);
    check('and the error is definitely not the old KYC gate',
      !/KYC must be approved|Complete verification before using NGN/.test(err ?? ''), err);
  }

  console.log('\nan unverified user is still stopped');
  {
    const err = await quoteFails('usr_none', '1000');
    check('Level 0 cannot create a quote', err !== undefined);
    check('and is told to confirm a payout account, not to complete Bridge KYC',
      /payout bank account/i.test(err ?? ''), err);
  }

  console.log('\nthe ceiling is cumulative, not per-transaction');
  {
    // Bank level on-ramp ceiling is NGN 100,000.
    const first = await quoteFails('usr_bank', '99000');
    check('first NGN 99,000 passes', first === undefined, first);

    // Record it as completed volume, as a settled transfer would.
    await db.mutate((data: any) => {
    (data.ngnTransfers as any) = [
      {
        id: 'ngnt_1',
        quoteId: 'q1',
        userId: 'usr_bank',
        direction: 'onramp',
        provider: 'paj',
        sourceCurrency: 'ngn',
        destinationCurrency: 'usdc',
        sourceAmount: '99000',
        destinationAmount: '60',
        rate: '1650',
        feeAmount: '0',
        status: 'completed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    });

    const volume = await getCumulativeNgnVolume('usr_bank', VOLUME_WINDOW_DAYS);
    check('completed volume is counted', volume === 99_000, `got ${volume}`);

    const second = await quoteFails('usr_bank', '99000');
    check('a second NGN 99,000 is refused - slicing does not work',
      second !== undefined, 'it was allowed');
    check('and the message names the remaining headroom',
      /1,000/.test(second ?? ''), second);

    const small = await quoteFails('usr_bank', '900');
    check('but NGN 900 still fits in the remaining headroom', small === undefined, small);
  }

  console.log('\noff-ramp is held tighter than on-ramp at the same level');
  {
    await db.mutate((data: any) => { (data.ngnTransfers as any) = []; });

    // Off-ramp ceiling at BANK is NGN 50,000; on-ramp is NGN 100,000.
    //
    // NOTE the units. An off-ramp's SOURCE is USDC, so these amounts are USDC
    // and the naira figure that gets measured is the destination. At the mock
    // rate (~1650) 24 USDC is roughly NGN 40,000 and 48 USDC roughly NGN 80,000.
    // Passing '40000' here would be 40,000 USDC - about NGN 66 million - which
    // is exactly the confusion that hid the bug this test caught.
    const offOk = await quoteFails('usr_bank', '24', 'offramp');
    check('~NGN 40,000 off-ramp passes', offOk === undefined, offOk);

    const offOver = await quoteFails('usr_bank', '48', 'offramp');
    check('~NGN 80,000 off-ramp is refused', offOver !== undefined, 'it was allowed');

    const onOk = await quoteFails('usr_bank', '80000', 'onramp');
    check('while NGN 80,000 on-ramp is allowed', onOk === undefined, onOk);
  }

  console.log('\nBridge is never consulted for a naira quote');
  {
    const data = await db.read();
    check('no Bridge customer was created by any of the above',
      (data.customers ?? []).length === 0,
      `${(data.customers ?? []).length} customers exist`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
