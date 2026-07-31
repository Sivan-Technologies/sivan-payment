/**
 * The Sivan ledger.
 *
 * The cases that matter are the ones that lose money:
 *
 *   - a webhook delivered twice, CONCURRENTLY, crediting a user twice
 *   - an unbalanced posting creating value out of nothing
 *   - escrow-held funds being spent as though they were available
 *   - float arithmetic drifting a balance
 *
 * Two of these were measured as real defects in the existing balance.service
 * ledger before this module was written. See the notes on the relevant tests.
 *
 * Run: npm run test:kyc-ledger
 */

import { db } from '../src/database/json-database.js';
import {
  postToLedger,
  getBalance,
  trialBalance,
  canSpend,
  validatePosting,
  depositPosting,
  escrowHoldPosting,
  escrowReleasePosting,
  withdrawalPosting,
  LedgerError,
  type PostingInput,
} from '../src/kyc/service/ledger.js';

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

async function reset() {
  await db.mutate((data: any) => {
    data.ledgerPostings = [];
  });
}

function threw(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error: any) {
    return String(error?.code ?? error?.message ?? error);
  }
}

async function main() {
  console.log('\na posting must balance');
  {
    await reset();
    const unbalanced: PostingInput = {
      idempotencyKey: 'k1',
      kind: 'deposit',
      legs: [
        { account: 'external', asset: 'usdc', amount: '-100' },
        { account: 'user_available', userId: 'u1', asset: 'usdc', amount: '150' },
      ],
    };
    check('legs that do not sum to zero are refused',
      threw(() => validatePosting(unbalanced)) === 'unbalanced');

    // The existing balance.service ledger accepted a single unbacked debit of
    // -999,999 and left the user at -999,599. Value appeared from nowhere.
    const singleLeg: PostingInput = {
      idempotencyKey: 'k2',
      kind: 'adjustment',
      legs: [{ account: 'user_available', userId: 'u1', asset: 'usdc', amount: '-999999' }],
    };
    check('a single unbacked leg is refused', threw(() => validatePosting(singleLeg)) === 'single_leg');

    // Cross-asset legs summing to zero are still incoherent.
    const crossAsset: PostingInput = {
      idempotencyKey: 'k3',
      kind: 'deposit',
      legs: [
        { account: 'external', asset: 'usdc', amount: '-100' },
        { account: 'user_available', userId: 'u1', asset: 'ngn', amount: '100' },
      ],
    };
    check('balance is checked PER ASSET, not overall',
      threw(() => validatePosting(crossAsset)) === 'unbalanced');
  }

  console.log('\nminor units only - no float drift');
  {
    const fractional: PostingInput = {
      idempotencyKey: 'k4',
      kind: 'deposit',
      legs: [
        { account: 'external', asset: 'usdc', amount: '-0.1' },
        { account: 'user_available', userId: 'u1', asset: 'usdc', amount: '0.1' },
      ],
    };
    check('a fractional amount is refused', threw(() => validatePosting(fractional)) === 'invalid_amount');

    // 0.1 + 0.2 !== 0.3 in floating point. Ten thousand of those is a ledger
    // that will not reconcile.
    await reset();
    for (let i = 0; i < 1000; i += 1) {
      await postToLedger(depositPosting({
        idempotencyKey: `drift_${i}`, userId: 'u_drift', asset: 'usdc', minorAmount: 1,
      }));
    }
    const drift = await getBalance('u_drift', 'usdc');
    check('1000 credits of 1 minor unit sum to exactly 1000', drift.available === 1000,
      `got ${drift.available}`);
  }

  console.log('\nCONCURRENT duplicates - the webhook retry case');
  {
    await reset();
    // MEASURED DEFECT in balance.service: three simultaneous identical writes
    // produced 3 entries. Its check reads, awaits, then writes, so two retries
    // arriving together both see "nothing there" and both insert.
    const posting = depositPosting({
      idempotencyKey: 'webhook_evt_123', userId: 'u2', asset: 'usdc', minorAmount: 500,
    });

    const results = await Promise.all([
      postToLedger(posting),
      postToLedger(posting),
      postToLedger(posting),
      postToLedger(posting),
      postToLedger(posting),
    ]);

    const data = await db.read();
    const stored = ((data as any).ledgerPostings ?? []).filter(
      (p: any) => p.idempotencyKey === 'webhook_evt_123'
    );
    check('5 concurrent identical postings store exactly 1', stored.length === 1,
      `stored ${stored.length}`);

    const duplicates = results.filter((r) => r.duplicate).length;
    check('4 of the 5 are reported as duplicates', duplicates === 4, `got ${duplicates}`);

    const balance = await getBalance('u2', 'usdc');
    check('the user is credited once, not five times', balance.available === 500,
      `balance ${balance.available}`);

    check('all five callers get the same postingId',
      new Set(results.map((r) => r.posting.postingId)).size === 1);
  }

  console.log('\nheld funds are not spendable');
  {
    await reset();
    await postToLedger(depositPosting({
      idempotencyKey: 'd1', userId: 'u3', asset: 'usdc', minorAmount: 1000,
    }));
    check('deposit is available', (await getBalance('u3', 'usdc')).available === 1000);

    await postToLedger(escrowHoldPosting({
      idempotencyKey: 'h1', userId: 'u3', asset: 'usdc', minorAmount: 600,
    }));
    const afterHold = await getBalance('u3', 'usdc');
    check('holding moves 600 out of available', afterHold.available === 400,
      `available ${afterHold.available}`);
    check('and into held', afterHold.held === 600, `held ${afterHold.held}`);
    check('total is unchanged - nothing entered or left', afterHold.total === 1000);

    // This is the state no chain query can express: the tokens are all at the
    // same address, but only 400 are spendable.
    check('spending 400 is allowed', await canSpend('u3', 'usdc', 400));
    check('spending 500 is refused - held funds are not available',
      !(await canSpend('u3', 'usdc', 500)));
  }

  console.log('\nescrow release moves held funds and takes the fee');
  {
    await reset();
    await postToLedger(depositPosting({ idempotencyKey: 'd2', userId: 'buyer', asset: 'usdc', minorAmount: 10_000 }));
    await postToLedger(escrowHoldPosting({ idempotencyKey: 'h2', userId: 'buyer', asset: 'usdc', minorAmount: 10_000 }));
    await postToLedger(escrowReleasePosting({
      idempotencyKey: 'r1', fromUserId: 'buyer', toUserId: 'seller',
      asset: 'usdc', minorAmount: 10_000, feeMinorAmount: 125,
    }));

    const buyer = await getBalance('buyer', 'usdc');
    const seller = await getBalance('seller', 'usdc');
    check('buyer holds nothing afterwards', buyer.held === 0 && buyer.available === 0,
      `available ${buyer.available} held ${buyer.held}`);
    check('seller receives amount minus fee', seller.available === 9_875,
      `seller ${seller.available}`);

    const trial = await trialBalance();
    check('revenue captured the fee', trial.byAccount['revenue:usdc'] === 125,
      `revenue ${trial.byAccount['revenue:usdc']}`);
    check('the books balance to exactly zero', trial.byAsset.usdc === 0,
      `usdc total ${trial.byAsset.usdc}`);

    const feeTooBig = threw(() => escrowReleasePosting({
      idempotencyKey: 'r2', fromUserId: 'a', toUserId: 'b',
      asset: 'usdc', minorAmount: 100, feeMinorAmount: 200,
    }));
    check('a fee larger than the amount is refused', feeTooBig === 'fee_exceeds_amount');
  }

  console.log('\nwithdrawal leaves the system and balances');
  {
    await reset();
    await postToLedger(depositPosting({ idempotencyKey: 'd3', userId: 'u4', asset: 'usdc', minorAmount: 5_000 }));
    await postToLedger(withdrawalPosting({
      idempotencyKey: 'w1', userId: 'u4', asset: 'usdc', minorAmount: 2_000, feeMinorAmount: 25,
    }));

    const balance = await getBalance('u4', 'usdc');
    check('the full amount leaves the user', balance.available === 3_000, `got ${balance.available}`);

    const trial = await trialBalance();
    check('fee went to revenue', trial.byAccount['revenue:usdc'] === 25);
    check('net left via external', trial.byAccount['external:usdc'] === -5_000 + 1_975,
      `external ${trial.byAccount['external:usdc']}`);
    check('books still sum to zero', trial.byAsset.usdc === 0);
  }

  console.log('\na different key is a different posting');
  {
    await reset();
    await postToLedger(depositPosting({ idempotencyKey: 'a1', userId: 'u5', asset: 'usdc', minorAmount: 100 }));
    await postToLedger(depositPosting({ idempotencyKey: 'a2', userId: 'u5', asset: 'usdc', minorAmount: 100 }));
    check('two genuine deposits both count', (await getBalance('u5', 'usdc')).available === 200);
  }

  console.log('\nassets do not leak into each other');
  {
    await reset();
    await postToLedger(depositPosting({ idempotencyKey: 'm1', userId: 'u6', asset: 'usdc', minorAmount: 100 }));
    await postToLedger(depositPosting({ idempotencyKey: 'm2', userId: 'u6', asset: 'usdt', minorAmount: 700 }));
    await postToLedger(depositPosting({ idempotencyKey: 'm3', userId: 'u6', asset: 'ngn', minorAmount: 50_000 }));
    check('usdc is separate', (await getBalance('u6', 'usdc')).available === 100);
    check('usdt is separate', (await getBalance('u6', 'usdt')).available === 700);
    check('ngn is separate', (await getBalance('u6', 'ngn')).available === 50_000);

    const trial = await trialBalance();
    check('every asset balances independently',
      trial.byAsset.usdc === 0 && trial.byAsset.usdt === 0 && trial.byAsset.ngn === 0);
  }

  console.log('\nbad input is refused');
  {
    check('an empty idempotency key is refused',
      threw(() => validatePosting({ idempotencyKey: '  ', kind: 'deposit', legs: [] })) === 'missing_key');
    check('a zero leg is refused', threw(() => validatePosting({
      idempotencyKey: 'z', kind: 'deposit',
      legs: [
        { account: 'external', asset: 'usdc', amount: '0' },
        { account: 'user_available', userId: 'u', asset: 'usdc', amount: '0' },
      ],
    })) === 'zero_leg');
    check('a user leg without a userId is refused', threw(() => validatePosting({
      idempotencyKey: 'nu', kind: 'deposit',
      legs: [
        { account: 'external', asset: 'usdc', amount: '-5' },
        { account: 'user_available', asset: 'usdc', amount: '5' },
      ],
    })) === 'missing_user');
    check('canSpend refuses a non-integer amount', !(await canSpend('u1', 'usdc', 1.5)));
    check('canSpend refuses zero', !(await canSpend('u1', 'usdc', 0)));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
