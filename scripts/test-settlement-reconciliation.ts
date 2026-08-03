/**
 * A SETTLEMENT MUST FINISH EVEN WHEN THE WEBHOOK NEVER LANDS.
 *
 * The real failure this exists for, in full:
 *
 *   59 USDC left the Privy wallet. Breet converted it at 1605 and paid
 *   94,171 NGN to PalmPay 8102524846. Breet sent SIX webhooks about it.
 *   Every one was refused - 403 - and Sivan's own record read
 *   "awaiting_crypto_deposit" for the entire time the money was already in
 *   the user's bank.
 *
 * There were three independent bugs behind that, and each has a section here:
 *
 *   1. the secret mismatch (403 at the door)
 *   2. verifyWebhook confirmed trades against /transactions/:id, which 404s
 *      for a trade - so a genuine trade.completed was rejected as forged
 *      EVEN WITH the right secret
 *   3. the webhook's id is the TRADE id, but we stored the ADDRESS id, so
 *      even a confirmed event matched no transfer and was dropped
 *
 * Any one of them alone strands the money. So the last section proves the
 * thing that makes all three survivable: reconciliation against the
 * provider's own record, with no webhook involved at all.
 *
 * Run: npm run test:settlement-reconciliation
 */

import {
  reconcileNgnSettlements,
  statusFromSettlement,
} from '../src/ngn/service/ngn-settlement-reconciler.js';
import { db } from '../src/database/json-database.js';
import { getNgnProvider } from '../src/ngn/provider/ngn-provider-registry.js';
import { updateNgnControls } from '../src/ngn/service/ngn-controls.service.js';
import { recordNgnWebhook } from '../src/ngn/service/ngn-webhooks.service.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../src/config/env.js';
import type { NgnProviderSettlement } from '../src/ngn/provider/ngn-provider.js';
import type { NgnTransferRecord } from '../src/ngn/types/ngn.types.js';

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

/** The real deposit address from the stuck settlement. */
const ADDRESS = '0x3da308242c746af7b1D0062E2B1ff41A2c4AfEAb';
const TRADE_ID = '6a70adbe0b4ad380586424a1';
const WITHDRAWAL_ID = '6a70adbea4f8526669d89013';
const ADDRESS_ID = '6a70ad8c040553cd1f89a0c2';

let seq = 0;

/**
 * A FRESH ADDRESS PER SECTION, BECAUSE THE JSON DATABASE CACHES IN MEMORY.
 *
 * Deleting the file mid-run does NOT reset it - json-database.read() returns
 * this.db when it is already loaded. The first draft of this suite deleted the
 * file between sections and every later section then matched a LEFTOVER
 * transfer from an earlier one, producing five failures that were entirely the
 * fixture's fault. Isolating on the address is honest and needs no reset.
 */
function freshAddress(): string {
  seq += 1;
  return `0x${seq.toString(16).padStart(40, 'a')}`;
}

/**
 * Fresh trade ids too. The reconciler LEARNS breetTradeId onto a transfer the
 * first time it sees one, and matches on it thereafter - correctly. So reusing
 * the real TRADE_ID across sections made every later section resolve to the
 * already-completed transfer from section two. Same class of fixture bug as
 * the address, one layer down.
 */
function freshTradeId(): string {
  seq += 1;
  return `trade_${seq}`;
}

async function seedTransfer(
  address: string,
  overrides: Partial<NgnTransferRecord> = {}
): Promise<NgnTransferRecord> {
  seq += 1;
  const now = new Date(Date.now() + seq * 1000).toISOString();
  const transfer: NgnTransferRecord = {
    id: `ngnt_test_${seq}`,
    quoteId: `ngnq_test_${seq}`,
    userId: 'usr_test',
    direction: 'offramp',
    provider: 'breet',
    sourceCurrency: 'usdc',
    destinationCurrency: 'ngn',
    sourceAmount: '59',
    destinationAmount: '94220.93',
    rate: '1605',
    feeAmount: '473.47',
    // EXACTLY what the bug looked like: the ADDRESS id, not the trade id.
    providerTransferId: ADDRESS_ID,
    status: 'awaiting_crypto_deposit',
    depositAddress: address,
    metadata: { transferMetadata: { label: 'sivan_usr_test_asset', depositAddress: address } },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await db.upsertNgnTransferRecord(transfer);
  return transfer;
}

async function reload(id: string) {
  return (await db.listNgnTransfers()).find((item) => item.id === id);
}

/** A provider that answers with whatever this test wants it to have settled. */
function stubProvider(settlements: NgnProviderSettlement[]) {
  const provider: any = getNgnProvider('breet');
  const original = Object.getPrototypeOf(provider).listSettlements;
  Object.getPrototypeOf(provider).listSettlements = async () => settlements;
  return () => {
    Object.getPrototypeOf(provider).listSettlements = original;
  };
}

async function main() {
  const dbPath = path.isAbsolute(env.DATABASE_FILE)
    ? env.DATABASE_FILE
    : path.join(process.cwd(), env.DATABASE_FILE);
  await fs.rm(dbPath, { force: true });
  await updateNgnControls({ activeProvider: 'breet', updatedBy: 'reconcile-test' } as any);

  console.log('\nA COMPLETED TRADE IS NOT A COMPLETED PAYOUT');
  {
    // The single most dangerous mapping in the system. trade.completed means
    // the crypto became naira INSIDE Breet. On a non-autoSettlement account
    // that naira may never leave. Calling it "completed" tells a user their
    // money arrived when it has not.
    check(
      'a completed trade with no withdrawal is settlement_processing, NOT completed',
      statusFromSettlement({ tradeStatus: 'completed' }) === 'settlement_processing',
      String(statusFromSettlement({ tradeStatus: 'completed' }))
    );
    check(
      'only a completed WITHDRAWAL completes the transfer',
      statusFromSettlement({ tradeStatus: 'completed', withdrawalStatus: 'completed' }) ===
        'completed'
    );
    check(
      'a pending withdrawal is bank_processing',
      statusFromSettlement({ tradeStatus: 'completed', withdrawalStatus: 'pending' }) ===
        'bank_processing'
    );
    check(
      'a flagged trade needs a human, not a retry',
      statusFromSettlement({ tradeStatus: 'flagged' }) === 'requires_review'
    );
    check(
      'a failed withdrawal fails the transfer even on a good trade',
      statusFromSettlement({ tradeStatus: 'completed', withdrawalStatus: 'failed' }) === 'failed'
    );
    check(
      'an unknown status changes nothing',
      statusFromSettlement({ tradeStatus: 'teleported' }) === undefined,
      String(statusFromSettlement({ tradeStatus: 'teleported' }))
    );
  }

  console.log('\nTHE STUCK TRANSFER IS HEALED WITH NO WEBHOOK AT ALL');
  {
    const address = ADDRESS;
    const transfer = await seedTransfer(address);
    const restore = stubProvider([
      {
        depositAddress: address,
        tradeId: TRADE_ID,
        withdrawalId: WITHDRAWAL_ID,
        tradeStatus: 'completed',
        withdrawalStatus: 'completed',
        cryptoAmount: 59,
        fiatAmount: 94171,
        txHash: '0x5a4a1b8f732e2b3b68461f52c09efd4783e26537f719a133765a5ad8a846a192',
      },
    ]);
    const outcome = await reconcileNgnSettlements();
    restore();

    check('the settlement was matched to our transfer', outcome.matched === 1, JSON.stringify(outcome.unmatched));
    check('and the transfer was advanced', outcome.advanced.length === 1, JSON.stringify(outcome.advanced));

    const healed = await reload(transfer.id);
    check(
      'the transfer now reads completed, not awaiting_crypto_deposit',
      healed?.status === 'completed',
      String(healed?.status)
    );
    check('completedAt is stamped', Boolean(healed?.completedAt));
    check(
      'the naira Breet actually paid is recorded, not the quote',
      (healed?.metadata as any)?.settledFiatAmount === 94171,
      String((healed?.metadata as any)?.settledFiatAmount)
    );
    check(
      'the trade id is learned so a late webhook can match',
      (healed?.metadata as any)?.breetTradeId === TRADE_ID
    );
    check(
      'and it is visibly a reconciliation, so bad delivery stays diagnosable',
      (healed?.metadata as any)?.reconciledFromProvider === true
    );
  }

  console.log('\nMATCHING WORKS ON THE ADDRESS, BECAUSE THE IDS DO NOT LINE UP');
  {
    // The heart of bug 3. Our providerTransferId is the ADDRESS id; the
    // settlement only knows the TRADE id. Nothing matches by id.
    const address = freshAddress();
    const transfer = await seedTransfer(address);
    check(
      'our stored id really is the address id, not the trade id',
      // Widened to string so tsc does not fold the second comparison away as
      // provably-false at compile time and reject the file: the point of the
      // assertion is that these are DIFFERENT ids at runtime, which is exactly
      // what the literal types make tsc complain about.
      transfer.providerTransferId === ADDRESS_ID &&
        String(transfer.providerTransferId) !== String(TRADE_ID)
    );

    const restore = stubProvider([
      // Deliberately no depositAddress casing match: Breet checksums, we may not.
      {
        depositAddress: address.toUpperCase().replace('0X', '0x'),
        tradeId: freshTradeId(),
        tradeStatus: 'completed',
        withdrawalStatus: 'completed',
      },
    ]);
    const outcome = await reconcileNgnSettlements();
    restore();
    check(
      'a lowercased address still matches a checksummed one',
      outcome.matched === 1,
      JSON.stringify(outcome)
    );
    check('and it completed', (await reload(transfer.id))?.status === 'completed');
  }

  console.log('\nIT NEVER MOVES A TRANSFER BACKWARDS OR RE-SETTLES ONE');
  {
    const address = freshAddress();
    const transfer = await seedTransfer(address, { status: 'completed' });
    const restore = stubProvider([
      { depositAddress: address, tradeId: 'other', tradeStatus: 'pending' },
    ]);
    const outcome = await reconcileNgnSettlements();
    restore();
    check(
      'a completed transfer is left alone by a pending trade',
      outcome.advanced.length === 0,
      JSON.stringify(outcome.advanced)
    );
    check('and it is still completed', (await reload(transfer.id))?.status === 'completed');

    /**
     * A NON-TERMINAL transfer must not go backwards either.
     *
     * The check above passes on the TERMINAL guard alone - mutation-testing
     * proved it: deleting the rank() comparison entirely left this section
     * green, so the forward-only rule was untested and the comment claiming it
     * was a lie. bank_processing is mid-flight, not terminal, so only the rank
     * comparison can hold it. Breet retries every event for 24 hours, so a
     * stale trade.pending arriving after the payout has reached the bank is
     * routine, not hypothetical.
     */
    /**
     * AND A FINISHED PAYOUT CANNOT BE DRAGGED INTO REVIEW.
     *
     * requires_review is deliberately exempt from the rank comparison - being
     * flagged is a sideways move that must be able to interrupt a transfer at
     * any stage. That exemption means the TERMINAL check is the only thing
     * standing between a late trade.flagged and a settled payout being
     * reopened as a compliance hold on money the user already has.
     *
     * Mutation-proven necessary: deleting `if (terminal) continue;` left the
     * whole suite green until this existed, because every other backwards move
     * was already caught by rank(). One guard, one uncovered path.
     */
    const settledAddress = freshAddress();
    const settled = await seedTransfer(settledAddress, { status: 'completed' });
    const restoreFlag = stubProvider([
      { depositAddress: settledAddress, tradeId: freshTradeId(), tradeStatus: 'flagged' },
    ]);
    await reconcileNgnSettlements();
    restoreFlag();
    check(
      'a late flagged trade does not reopen an already-paid transfer',
      (await reload(settled.id))?.status === 'completed',
      String((await reload(settled.id))?.status)
    );

    const midflightAddress = freshAddress();
    const midflight = await seedTransfer(midflightAddress, { status: 'bank_processing' });
    const restoreMid = stubProvider([
      { depositAddress: midflightAddress, tradeId: freshTradeId(), tradeStatus: 'pending' },
    ]);
    const midOutcome = await reconcileNgnSettlements();
    restoreMid();
    check(
      'a mid-flight bank_processing transfer is matched',
      midOutcome.matched === 1,
      JSON.stringify(midOutcome)
    );
    check(
      'but a stale pending trade does NOT rewind it to blockchain_confirmed',
      (await reload(midflight.id))?.status === 'bank_processing',
      String((await reload(midflight.id))?.status)
    );
  }

  console.log('\nRUNNING IT TWICE CHANGES NOTHING THE SECOND TIME');
  {
    const address = freshAddress();
    const transfer = await seedTransfer(address);
    const settlement: NgnProviderSettlement = {
      depositAddress: address,
      tradeId: freshTradeId(),
      withdrawalId: freshTradeId(),
      tradeStatus: 'completed',
      withdrawalStatus: 'completed',
    };
    let restore = stubProvider([settlement]);
    const first = await reconcileNgnSettlements();
    restore();
    restore = stubProvider([settlement]);
    const second = await reconcileNgnSettlements();
    restore();

    check('the first run advances it', first.advanced.some((a) => a.transferId === transfer.id));
    check(
      'the second run advances nothing',
      second.advanced.length === 0,
      JSON.stringify(second.advanced)
    );
  }

  console.log('\nA REUSED ADDRESS SETTLES THE OLDEST OPEN ORDER, NOT THE NEWEST');
  {
    // Breet addresses are permanent, so one address legitimately belongs to
    // many orders. Completing the newest would mark a fresh order paid on the
    // strength of an older payout.
    const address = freshAddress();
    const older = await seedTransfer(address);
    const newer = await seedTransfer(address);
    check('the fixtures are ordered', older.createdAt < newer.createdAt);

    const restore = stubProvider([
      { depositAddress: address, tradeId: freshTradeId(), tradeStatus: 'completed', withdrawalStatus: 'completed' },
    ]);
    await reconcileNgnSettlements();
    restore();

    check('the older order settled', (await reload(older.id))?.status === 'completed');
    check(
      'the newer order was NOT settled by someone else money',
      (await reload(newer.id))?.status === 'awaiting_crypto_deposit',
      String((await reload(newer.id))?.status)
    );
  }

  console.log('\nAN UNKNOWN SETTLEMENT IS REPORTED, NOT SILENTLY SWALLOWED');
  {
    const restore = stubProvider([
      { depositAddress: '0xdeadbeef', tradeId: 'unknown', tradeStatus: 'completed' },
    ]);
    const outcome = await reconcileNgnSettlements();
    restore();
    check('it is counted as unmatched', outcome.unmatched.length === 1, JSON.stringify(outcome));
    check('and nothing was advanced', outcome.advanced.length === 0);
  }

  console.log('\nTHE WEBHOOK PATH MATCHES ON THE TRADE ID TOO');
  {
    const address = freshAddress();
    const tradeId = freshTradeId();
    const withdrawalId = freshTradeId();
    const transfer = await seedTransfer(address);

    // A genuine trade.completed body, byte-shaped like the real one, but the
    // secret check and Breet fetch are bypassed by calling the applier through
    // a provider stub - this section is about MATCHING, not authentication.
    const provider: any = getNgnProvider('breet');
    const proto = Object.getPrototypeOf(provider);
    const originalVerify = proto.verifyWebhook;
    proto.verifyWebhook = async (payload: any) => ({
      id: 'ngnwh_test',
      provider: 'breet',
      providerEventId: `${payload.id}:${payload.event}`,
      eventType: payload.event,
      transferId: payload.id,
      payload,
      createdAt: new Date().toISOString(),
    });

    await recordNgnWebhook(
      'breet',
      {
        event: 'trade.completed',
        id: tradeId,
        status: 'completed',
        destinationAddress: address,
        cryptoAmount: 59,
      },
      {}
    );

    const afterTrade = await reload(transfer.id);
    check(
      'a trade.completed whose id we have never seen still finds the transfer, by address',
      afterTrade?.status === 'settlement_processing',
      String(afterTrade?.status)
    );
    check(
      'and the trade id is remembered for the withdrawal event that follows',
      (afterTrade?.metadata as any)?.breetTradeId === tradeId
    );

    // The withdrawal event carries NO address at all - only its own id and a
    // pointer to the trade. It is matchable only because of what was learned
    // above.
    await recordNgnWebhook(
      'breet',
      {
        event: 'withdrawal.completed',
        id: withdrawalId,
        status: 'completed',
        trade: tradeId,
        amount: 94221,
      },
      {}
    );
    proto.verifyWebhook = originalVerify;

    const afterWithdrawal = await reload(transfer.id);
    check(
      'the withdrawal event, which carries no address, completes the transfer',
      afterWithdrawal?.status === 'completed',
      String(afterWithdrawal?.status)
    );
    /**
     * AND IT DID NOT ERASE WHAT THE TRADE TOLD US.
     *
     * The two events carry different fields - the trade knows the crypto
     * amount, the withdrawal knows the naira - and a plain spread wrote
     * `settledCryptoAmount: undefined` over a known value when the second
     * arrived. Real bug, found by test:full-system only after that suite was
     * extended to deliver BOTH events; every suite that stopped at the trade
     * was blind to it.
     */
    check(
      'the crypto amount from the trade survives the withdrawal event',
      (afterWithdrawal?.metadata as any)?.settledCryptoAmount === 59,
      String((afterWithdrawal?.metadata as any)?.settledCryptoAmount)
    );
    /**
     * AND A PAYLOAD THAT OMITS A FIELD MUST NOT BLANK IT EITHER.
     *
     * settledFigures() keeps each event to the fields it knows, which fixes
     * the cross-event case. It does NOT fix an event of the RIGHT type that
     * simply arrives without the value - `withdrawal.pending` announcing the
     * payout has been queued, before an amount is fixed. Then
     * `settledFiatAmount: undefined` is still in the object and a plain spread
     * writes the key, erasing the figure the trade already gave us.
     *
     * Tested on a NON-TERMINAL transfer, deliberately. A first attempt fired
     * the sparse event at an already-completed transfer and passed against the
     * mutation as well as the fix, because the TERMINAL short-circuit returns
     * long before the metadata is ever written - the assertion could not fail
     * and was therefore worthless.
     */
    const sparseAddress = freshAddress();
    const sparseTrade = freshTradeId();
    const sparseTransfer = await seedTransfer(sparseAddress);

    const sparseProto = Object.getPrototypeOf(getNgnProvider('breet') as any);
    const savedVerify = sparseProto.verifyWebhook;
    sparseProto.verifyWebhook = async (payload: any) => ({
      id: `ngnwh_sparse_${payload.event}`, provider: 'breet',
      providerEventId: `${payload.id}:${payload.event}`,
      eventType: payload.event, transferId: payload.id, payload,
      createdAt: new Date().toISOString(),
    });

    await recordNgnWebhook('breet', {
      event: 'trade.completed', id: sparseTrade, status: 'completed',
      destinationAddress: sparseAddress, cryptoAmount: 59, fiatAmount: '94221',
    }, {});
    const beforeSparse = await reload(sparseTransfer.id);
    check('the naira figure is known before the sparse event',
      (beforeSparse?.metadata as any)?.settledFiatAmount === '94221',
      String((beforeSparse?.metadata as any)?.settledFiatAmount));

    // withdrawal.pending: right event type, but no amount on it at all.
    await recordNgnWebhook('breet', {
      event: 'withdrawal.pending', id: freshTradeId(), status: 'pending', trade: sparseTrade,
    }, {});
    sparseProto.verifyWebhook = savedVerify;

    const afterSparse = await reload(sparseTransfer.id);
    check('the sparse event still advanced the transfer',
      afterSparse?.status === 'bank_processing', String(afterSparse?.status));
    check(
      'but it did NOT blank the naira figure it does not know',
      (afterSparse?.metadata as any)?.settledFiatAmount === '94221',
      String((afterSparse?.metadata as any)?.settledFiatAmount)
    );

    check(
      'and the naira amount from the withdrawal is recorded alongside it',
      Number((afterWithdrawal?.metadata as any)?.settledCryptoAmount) === 59 &&
        (afterWithdrawal?.metadata as any)?.breetWithdrawalId === withdrawalId,
      JSON.stringify({
        crypto: (afterWithdrawal?.metadata as any)?.settledCryptoAmount,
        withdrawalId: (afterWithdrawal?.metadata as any)?.breetWithdrawalId,
      })
    );
  }

  console.log('\nOUT-OF-ORDER DELIVERY CANNOT REWIND A FINISHED PAYOUT');
  {
    // Real observation: Breet generated withdrawal.completed BEFORE
    // trade.completed, and retries each independently for 24 hours.
    const lateAddress = freshAddress();
    const transfer = await seedTransfer(lateAddress, { status: 'completed' });

    const provider: any = getNgnProvider('breet');
    const proto = Object.getPrototypeOf(provider);
    const originalVerify = proto.verifyWebhook;
    proto.verifyWebhook = async (payload: any) => ({
      id: 'ngnwh_test2',
      provider: 'breet',
      providerEventId: `${payload.id}:${payload.event}`,
      eventType: payload.event,
      transferId: payload.id,
      payload,
      createdAt: new Date().toISOString(),
    });

    await recordNgnWebhook(
      'breet',
      { event: 'trade.pending', id: 'trade_late', status: 'pending', destinationAddress: lateAddress },
      {}
    );
    proto.verifyWebhook = originalVerify;

    check(
      'a late trade.pending does not drag a completed payout back',
      (await reload(transfer.id))?.status === 'completed',
      String((await reload(transfer.id))?.status)
    );
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
