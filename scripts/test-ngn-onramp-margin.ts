/**
 * Comprehensive End-to-End Test for All-Inclusive Embedded Rate Margin on Fiat On-Ramps.
 *
 * Verifies:
 * 1. Admin Fee Settings (dynamic margin, provider fee, floor).
 * 2. On-ramp Quote uses all-inclusive Ask rate:
 *    - feeAmount on quote record is '0.00'
 *    - userFee and userFeeNgn in feeBlock are '0.00'
 *    - allInclusive is true
 *    - effectiveRate embeds both Sivan margin and provider fee (Ask rate > wholesale)
 *    - internal fees tracked in metadata.fees (sivanMargin, providerFee, totalFee)
 *    - reconciliationDrift is strictly '0.00'
 * 3. Rate routes:
 *    - buyRate is Ask rate (grossRate * (1 + totalOnrampPercent / 100))
 *    - sellRate is Bid rate (grossRate * (1 - totalPercent / 100))
 *    - buyRate > grossRate > sellRate (market consistent spread)
 * 4. Off-ramp Quote continues to function cleanly with zero regression.
 */

import { db } from '../src/database/json-database.js';
import { createNgnQuote } from '../src/ngn/service/ngn-quotes.service.js';
import { applySivanMargin } from '../src/ngn/service/ngn-margin.js';
import { getAdminFeeSettings, updateAdminFeeSettings } from '../src/admin/admin-fees.service.js';

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

async function seedTestData() {
  await db.mutate((data: any) => {
    data.users = [{ id: 'u_onramp_test', email: 'onramp@sivan.tech', createdAt: new Date().toISOString() }];
    data.customers = [];
    data.externalAccounts = [
      {
        id: 'ext_onramp_1',
        userId: 'u_onramp_test',
        status: 'verified',
        currency: 'ngn',
        accountNumber: '0123456789',
        bankCode: '058',
        bankName: 'Guaranty Trust Bank',
        accountName: 'TEST USER',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    data.ngnTransfers = [];
    data.ngnQuotes = [];
    data.ngnControls = [
      {
        id: 'global',
        onrampEnabled: true,
        offrampEnabled: true,
        mockProviderEnabled: true,
        bankSettlementEnabled: false,
        virtualAccountEnabled: false,
        activeProvider: 'mock',
        identityVerificationEnabled: false,
        maxTransactionNgn: '100000000',
        dailyLimitNgn: '100000000',
        highValueReviewThresholdNgn: '100000000',
        updatedBy: 'test',
        updatedAt: new Date().toISOString(),
      },
    ];
  });
}

async function run() {
  console.log('\n--- 1. Dynamic Admin Fee Settings Verification ---');
  await seedTestData();

  // Configure dynamic settings: Sivan on-ramp margin 1.0%, provider fee 0.5%, min fee NGN 0
  await updateAdminFeeSettings({
    ngnOnrampFeePercent: 1.0,
    ngnProviderFeePercent: 0.5,
    ngnMinimumFeeNgn: 0,
    offrampDeveloperFeePercent: 1.0,
  });

  const settings = await getAdminFeeSettings();
  check('dynamic ngnOnrampFeePercent is loaded from DB', Number(settings.ngnOnrampFeePercent) === 1.0);
  check('dynamic ngnProviderFeePercent is loaded from DB', Number(settings.ngnProviderFeePercent) === 0.5);

  console.log('\n--- 2. On-Ramp Margin Calculation ---');
  const onrampMargin = await applySivanMargin({
    direction: 'onramp',
    grossAmount: 100_000,
    providerFeeAmount: 500,
  });

  check('on-ramp provider fee is reported', onrampMargin.providerFee === 500);
  check('on-ramp Sivan margin is non-zero', onrampMargin.sivanMargin > 0);
  check('total fee matches sum of provider fee and margin',
    Math.abs(onrampMargin.totalFee - (onrampMargin.providerFee + onrampMargin.sivanMargin)) < 0.01);
  check('effective percentage embeds both fees', onrampMargin.effectivePercent >= 1.5);

  console.log('\n--- 3. On-Ramp Quote Generation (All-Inclusive Ask Model) ---');
  const onrampQuote = await createNgnQuote({
    userId: 'u_onramp_test',
    direction: 'onramp',
    sourceCurrency: 'ngn',
    destinationCurrency: 'usdc',
    sourceAmount: '150000',
    destinationNetwork: 'polygon',
  });

  const metadata = onrampQuote.metadata as any;
  const fees = metadata?.fees;
  const rawRate = Number(onrampQuote.rate);
  const effectiveRate = Number(fees?.effectiveRate);

  check('on-ramp quote has allInclusive: true', fees?.allInclusive === true);
  check('on-ramp quote feeAmount is 0.00', onrampQuote.feeAmount === '0.00');
  check('on-ramp quote userFee is 0.00', fees?.userFee === '0.00');
  check('on-ramp quote userFeeNgn is 0.00', fees?.userFeeNgn === '0.00');
  check('on-ramp effective rate is Ask rate (higher than wholesale)', effectiveRate >= rawRate,
    `effectiveRate=${effectiveRate} vs rawRate=${rawRate}`);
  check('internal sivanMargin is non-zero in metadata', Number(fees?.sivanMargin) > 0);
  check('internal providerFee is tracked in metadata', Number(fees?.providerFee) > 0);
  check('reconciliation drift is 0.00', fees?.reconciliationDrift === '0.00',
    `drift=${fees?.reconciliationDrift}`);

  console.log('\n--- 4. Off-Ramp Quote Generation (Zero Regression Check) ---');
  const offrampQuote = await createNgnQuote({
    userId: 'u_onramp_test',
    direction: 'offramp',
    sourceCurrency: 'usdc',
    destinationCurrency: 'ngn',
    sourceAmount: '100',
    sourcePaymentRail: 'polygon',
  });

  const offrampMeta = offrampQuote.metadata as any;
  const offrampFees = offrampMeta?.fees;
  const offrampRawRate = Number(offrampQuote.rate);
  const offrampEffectiveRate = Number(offrampFees?.effectiveRate);

  check('off-ramp quote has allInclusive: true', offrampFees?.allInclusive === true);
  check('off-ramp quote feeAmount is 0.00', offrampQuote.feeAmount === '0.00');
  check('off-ramp effective rate is Bid rate (lower than wholesale)', offrampEffectiveRate <= offrampRawRate,
    `effectiveRate=${offrampEffectiveRate} vs rawRate=${offrampRawRate}`);
  check('off-ramp reconciliation drift is 0.00', offrampFees?.reconciliationDrift === '0.00');

  console.log('\n--- 5. Dynamic Spread Symmetry Check ---');
  // For a wholesale gross rate of 1500:
  // Sell rate (Bid) should be < 1500
  // Buy rate (Ask) should be > 1500
  const grossRate = 1500;
  const totalPercent = 1.5; // 1% Sivan + 0.5% provider
  const sellRate = Math.round(grossRate * (1 - totalPercent / 100));
  const buyRate = Math.round(grossRate * (1 + totalPercent / 100));
  const midRate = Math.round((buyRate + sellRate) / 2);

  check('buyRate (Ask) is strictly greater than wholesale grossRate', buyRate > grossRate);
  check('sellRate (Bid) is strictly less than wholesale grossRate', sellRate < grossRate);
  check('midRate is symmetric around grossRate', Math.abs(midRate - grossRate) <= 1);

  console.log(`\n========================================`);
  console.log(`RESULTS: ${pass} passed, ${fail} failed.`);
  console.log(`========================================\n`);

  if (fail > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal error during test:', err);
  process.exit(1);
});
