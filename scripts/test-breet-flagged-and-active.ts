/**
 * Flagged deposits, and assets Breet has switched off.
 *
 * Two gaps that both end the same way - a user's money somewhere they cannot
 * see and nothing telling them.
 *
 * 1. trade.flagged
 *    A deposit below the asset minimum is confirmed on-chain, HELD, and never
 *    credited; Breet sends `trade.flagged` and charges `flagFeeUSD` to
 *    recover. recordNgnWebhook() stored the event and returned, so the
 *    transfer stayed at `awaiting_crypto_deposit` forever - indistinguishable,
 *    to the user, from a deposit that never arrived. They would send again.
 *
 * 2. isActive
 *    Breet's docs: assets "can be added, removed, or temporarily disabled at
 *    any time", and a disabled asset still appears in the list. Generating a
 *    deposit address for one invites a send Breet will not process.
 *
 *    The subtlety: our sandbox omits `isActive` on all 23 assets. Treating
 *    absent as disabled would turn off the entire rail, so only an explicit
 *    false counts.
 *
 * Run: npm run test:breet-flagged
 */

import { recordNgnWebhook, listNgnWebhooks } from '../src/ngn/service/ngn-webhooks.service.js';
import { db } from '../src/database/json-database.js';
import {
  cacheAssetIds,
  clearAssetIdCache,
  assetIsDisabled,
  assetEconomics,
} from '../src/ngn/provider/breet-networks.js';
import { id } from '../src/shared/id.js';
import type { NgnTransferRecord } from '../src/ngn/types/ngn.types.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const SECRET = process.env.BREET_WEBHOOK_SECRET ?? 'whsec_breet_test';

async function seedTransfer(providerTransferId: string): Promise<NgnTransferRecord> {
  const now = new Date().toISOString();
  const transfer: NgnTransferRecord = {
    id: id('ngnt'),
    quoteId: id('ngnq'),
    userId: 'user_flagged_test',
    direction: 'offramp',
    provider: 'breet',
    sourceCurrency: 'usdc',
    destinationCurrency: 'ngn',
    sourceAmount: '8',
    destinationAmount: '12840',
    rate: '1605',
    feeAmount: '0',
    status: 'awaiting_crypto_deposit',
    providerTransferId,
    depositAddress: 'SoLaNaAddr111111111111111111111111111111111',
    createdAt: now,
    updatedAt: now,
  } as NgnTransferRecord;
  await db.upsertNgnTransferRecord(transfer);
  return transfer;
}

async function main() {
  console.log('\nISACTIVE: ABSENT IS NOT DISABLED');
  {
    clearAssetIdCache();

    // Exactly what our sandbox returns: no isActive field at all.
    cacheAssetIds([
      { id: 'aaa', identifier: 'SOL_USDC_JKVK', minimum: 50, flagFeeUSD: 1 },
    ]);
    check('an asset with no isActive is NOT treated as disabled',
      !assetIsDisabled('SOL_USDC_JKVK'),
      'absent was read as disabled - this would turn off the whole rail');
    check('isActive is recorded as undefined, not coerced to false',
      assetEconomics('SOL_USDC_JKVK')?.isActive === undefined,
      String(assetEconomics('SOL_USDC_JKVK')?.isActive));

    // Explicitly disabled by Breet.
    cacheAssetIds([
      { id: 'bbb', identifier: 'USDC_ARB_3SBJ', minimum: 15, flagFeeUSD: 1, isActive: false },
    ]);
    check('an explicitly inactive asset IS disabled', assetIsDisabled('USDC_ARB_3SBJ'));

    cacheAssetIds([
      { id: 'ccc', identifier: 'USDC_BASECHAIN_ETH_5I5C', minimum: 15, flagFeeUSD: 1, isActive: true },
    ]);
    check('an explicitly active asset is not disabled', !assetIsDisabled('USDC_BASECHAIN_ETH_5I5C'));

    check('an asset never seen is not disabled', !assetIsDisabled('NEVER_LOADED'),
      'unknown must not read as disabled');

    clearAssetIdCache();
  }

  console.log('\nTRADE.FLAGGED MOVES THE TRANSFER OUT OF LIMBO');
  {
    const providerRef = `breet_tx_${Date.now()}`;
    const seeded = await seedTransfer(providerRef);
    check('transfer starts awaiting a deposit', seeded.status === 'awaiting_crypto_deposit');

    await recordNgnWebhook('breet', {
      event: 'trade.flagged',
      id: providerRef,
      status: 'flagged',
      amountInUSD: 8,
      minimum: 15,
    }, { 'x-webhook-secret': SECRET });

    const after = (await db.listNgnTransfers()).find((t) => t.id === seeded.id);
    check('the transfer is no longer awaiting a deposit',
      after?.status !== 'awaiting_crypto_deposit', String(after?.status));

    // requires_review, NOT failed: Breet is holding the funds and support can
    // recover them. Calling it failed tells the user their money is gone.
    check('it is marked requires_review, not failed',
      after?.status === 'requires_review', String(after?.status));

    const meta = after?.metadata as any;
    check('the flag is recorded on the transfer', meta?.flagged === true);
    check('the amount and minimum are captured',
      meta?.flaggedAmountUsd === 8 && meta?.flaggedMinimumUsd === 15,
      JSON.stringify({ a: meta?.flaggedAmountUsd, m: meta?.flaggedMinimumUsd }));
    check('a user-facing reason exists', typeof meta?.flaggedReason === 'string' && meta.flaggedReason.length > 20);
    check('the reason names both numbers',
      meta?.flaggedReason?.includes('8') && meta?.flaggedReason?.includes('15'),
      meta?.flaggedReason);
    check('the reason says the funds are held, not lost',
      /holding|held/i.test(meta?.flaggedReason ?? ''), meta?.flaggedReason);
    console.log(`       "${meta?.flaggedReason}"`);
  }

  console.log('\nA FLAGGED STATUS COUNTS EVEN WITHOUT THE FLAGGED EVENT NAME');
  {
    // Breet may express it as a status on an ordinary trade event, so keying
    // only on the event name would miss it.
    const providerRef = `breet_tx_status_${Date.now()}`;
    const seeded = await seedTransfer(providerRef);

    await recordNgnWebhook('breet', {
      event: 'trade.updated',
      id: providerRef,
      status: 'flagged',
      amountInUSD: 9,
      minimum: 15,
    }, { 'x-webhook-secret': SECRET });

    const after = (await db.listNgnTransfers()).find((t) => t.id === seeded.id);
    check('a flagged STATUS on another event still applies',
      after?.status === 'requires_review', String(after?.status));
  }

  console.log('\nORDINARY EVENTS DO NOT MARK ANYTHING FLAGGED');
  {
    const providerRef = `breet_tx_ok_${Date.now()}`;
    const seeded = await seedTransfer(providerRef);

    await recordNgnWebhook('breet', {
      event: 'trade.completed',
      id: providerRef,
      status: 'completed',
      amountInUSD: 100,
    }, { 'x-webhook-secret': SECRET });

    const after = (await db.listNgnTransfers()).find((t) => t.id === seeded.id);
    check('a completed trade is not marked requires_review',
      after?.status !== 'requires_review', String(after?.status));
    check('it is not falsely flagged', (after?.metadata as any)?.flagged !== true);
  }

  console.log('\nAN UNKNOWN TRANSFER IS RECORDED, NOT REJECTED');
  {
    // Breet retries non-2xx for 24 hours then gives up permanently. Throwing
    // on an event we have no row for would burn a real delivery.
    const before = (await listNgnWebhooks()).length;
    let threw: string | undefined;
    try {
      await recordNgnWebhook('breet', {
        event: 'trade.flagged',
        id: `breet_unknown_${Date.now()}`,
        status: 'flagged',
      }, { 'x-webhook-secret': SECRET });
    } catch (e: any) { threw = String(e?.message ?? e); }

    check('it does not throw', threw === undefined, threw);
    check('the event is still stored', (await listNgnWebhooks()).length > before);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
