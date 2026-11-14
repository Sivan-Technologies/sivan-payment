/**
 * Transit-claim locks must move the sender's balance.
 *
 * A claim lock sends real funds to the transit vault by calling the wallet
 * provider directly, so it never passed through balance.service and wrote no
 * ledger entries. Available balance is replayed from that ledger and reads no
 * chain state, so the sender stayed credited for money that had already left.
 *
 * These checks run the real ledger engine, not a stub: the same
 * createBalanceLedgerEntry the transfer path calls, and the same
 * getUserBalance the API serves.
 */
import { createBalanceLedgerEntry, getUserBalance } from '../src/balances/balance.service.js';

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label} -> got ${a}, expected ${e}`);
    failures += 1;
  }
}

const USER = `usr_claimledger_${Date.now()}`;
const CLAIM_ID = `clm_${Date.now()}`;
const AMOUNT = '10.000000';

async function usdc() {
  const snapshot = await getUserBalance(USER);
  const row = snapshot.balances.find((b: any) => b.asset === 'usdc');
  return {
    available: Number(row?.available ?? 0),
    held: Number(row?.held ?? 0),
    spent: Number(row?.spent ?? 0),
  };
}

/** Exactly the pair recordClaimLockLedger writes. */
async function writeLock() {
  const base = {
    userId: USER,
    asset: 'usdc' as any,
    amount: AMOUNT,
    sourceType: 'onchain_claim_lock',
    sourceId: CLAIM_ID,
    network: 'near' as any,
    transferId: `clm_lock_${CLAIM_ID}`,
  };
  await createBalanceLedgerEntry(
    { ...base, kind: 'hold', status: 'held', description: 'Hold settled USDC for transit claim on near' },
    { actorType: 'system', actorId: 'claim_lock' }
  );
  await createBalanceLedgerEntry(
    {
      ...base,
      kind: 'debit_transfer',
      status: 'completed',
      description: 'Locked in on-chain transit claim vault on near',
      txHash: 'BiXkugFdRP3VR1Wtbgke7FxFXbs62Gm1RSxYewk28BWG',
    },
    { actorType: 'system', actorId: 'claim_lock' }
  );
}

/** Exactly what recordClaimRefundLedger writes. */
async function writeRefund() {
  await createBalanceLedgerEntry(
    {
      userId: USER,
      asset: 'usdc' as any,
      amount: AMOUNT,
      kind: 'credit_available',
      status: 'available',
      sourceType: 'onchain_claim_refund',
      sourceId: CLAIM_ID,
      network: 'near' as any,
      transferId: `clm_refund_${CLAIM_ID}`,
      description: 'Transit claim cancelled, funds returned from vault',
    },
    { actorType: 'system', actorId: 'claim_refund' }
  );
}

async function main() {
  console.log('\n── a transit claim lock debits the sender ────────────────────');

  await createBalanceLedgerEntry(
    {
      userId: USER,
      asset: 'usdc' as any,
      amount: '40.000000',
      kind: 'credit_available',
      status: 'available',
      sourceType: 'test_seed',
      sourceId: `seed_${CLAIM_ID}`,
      description: 'seed balance',
    },
    { actorType: 'system', actorId: 'test' }
  );

  const seeded = await usdc();
  check('starts with 40 available', seeded.available, 40);
  check('and nothing held', seeded.held, 0);

  await writeLock();
  const locked = await usdc();

  check('locking 10 drops available to 30', locked.available, 30);
  check('the hold is consumed, not left dangling', locked.held, 0);
  check('and 10 is recorded as spent', locked.spent, 10);

  console.log('\n── replaying the same lock cannot debit twice ────────────────');
  await writeLock();
  const replayed = await usdc();
  check('available is unchanged after a replay', replayed.available, 30);
  check('spent is unchanged after a replay', replayed.spent, 10);

  console.log('\n── a returned claim credits the sender back ──────────────────');
  await writeRefund();
  const refunded = await usdc();
  check('available returns to 40', refunded.available, 40);
  check('held stays at zero', refunded.held, 0);

  await writeRefund();
  const refundReplay = await usdc();
  check('a replayed refund does not credit twice', refundReplay.available, 40);

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('all claim-lock ledger checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
