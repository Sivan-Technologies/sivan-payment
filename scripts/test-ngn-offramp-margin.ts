/**
 * THE OFF-RAMP MARGIN MUST BE DENOMINATED IN NAIRA.
 *
 * A real $51.20 Solana off-ramp through Breet sandbox is what exposed this.
 * The quote came back at rate 1895 and the fee block read:
 *
 *     providerFee 485.12, sivanMargin 0.512, totalFee 485.632,
 *     effectivePercent 948.5
 *
 * Sivan's 1% of $51.20 is NGN 970.24. It collected NGN 0.51, because
 * applySivanMargin was handed the CRYPTO source amount - so it returned dollars
 * - and ngn-quotes.service.ts then subtracted that dollar figure straight off a
 * naira payout. The margin was not merely small, it was divided by the exchange
 * rate on every off-ramp Sivan has ever priced. That is the same "every naira
 * transaction ran at cost" failure the margin was introduced to fix, so it is
 * worth a test that fails loudly rather than a comment.
 *
 * The assertions correspond to the three ways the bug showed:
 *   1. the margin is naira, not dollars
 *   2. the user's payout is actually reduced by that naira margin
 *   3. totalFee is coherent and effectivePercent is believable, not 948%
 *
 * Runs against the MOCK provider - the arithmetic under test is Sivan's, not
 * Breet's, and a test that needs a live provider key is a test nobody runs.
 */

import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { signUserJwt } from '../src/auth/jwt.js';
import { db } from '../src/database/json-database.js';

const now = new Date().toISOString();
const app = await buildApp();

async function req(path: string, options: any = {}, expected = 200) {
  const response = await app.inject({
    method: options.method || 'GET',
    url: path,
    payload: options.body,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const json = JSON.parse(response.payload || '{}');
  assert.equal(
    response.statusCode,
    expected,
    `${path} expected ${expected}, got ${response.statusCode}: ${JSON.stringify(json)}`
  );
  return json.data ?? json;
}

const token = signUserJwt({ userId: 'usr_margin', email: 'margin@sivan.test' });
const authHeaders = { Authorization: `Bearer ${token}` };

await db.mutate((data) => {
  data.users = [{ id: 'usr_margin', email: 'margin@sivan.test', fullName: 'Margin User', role: 'user', createdAt: now, updatedAt: now } as any];
  data.customers = [{ id: 'cus_margin', userId: 'usr_margin', provider: 'bridge', providerCustomerId: 'bridge_cus_margin', kycStatus: 'kyc_approved', tosStatus: 'approved', createdAt: now, updatedAt: now } as any];
  data.externalAccounts = [{ id: 'ext_margin', userId: 'usr_margin', customerId: 'cus_margin', provider: 'bridge', providerExternalAccountId: 'bridge_ext_margin', currency: 'ngn', status: 'verified', createdAt: now, updatedAt: now } as any];
  /**
   * A Solana wallet, because an off-ramp with no on-chain wallet is refused at
   * the quote - see the credit-only guard in createNgnQuote.
   */
  data.userWallets = [{
    id: 'uw_margin', userId: 'usr_margin', customerId: 'cus_margin', provider: 'mock',
    providerWalletId: 'mock_margin', chain: 'solana',
    address: 'EevL5P2e3j6p8vEkdxmaFPKf1pKrjigHBF3BGiD39nWm',
    status: 'active', custodial: false, createdAt: now, updatedAt: now,
  } as any];
  /**
   * Off-ramp enabled explicitly. An empty controls list defaults to DISABLED -
   * correctly, a rail nobody has switched on should not price - so the quote
   * comes back 403 without this.
   */
  data.ngnControls = [{
    id: 'global', onrampEnabled: true, offrampEnabled: true, mockProviderEnabled: true,
    bankSettlementEnabled: false, virtualAccountEnabled: false, activeProvider: 'mock',
    maxTransactionNgn: '10000000', updatedBy: 'margin-test', createdAt: now, updatedAt: now,
  } as any];
  data.ngnQuotes = [];
  data.ngnTransfers = [];
  data.ngnWebhooks = [];
  data.virtualAccountTransactions = [];
});

// The exact amount from the live Breet run, so the numbers here can be compared
// against the sandbox quote in the investigation directly.
const quote = await req(
  '/api/ngn/quote?userId=usr_margin&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=51.20&network=solana',
  { headers: authHeaders }
);

const rate = Number(quote.rate);
const source = Number(quote.sourceAmount);
const fees = quote.metadata.fees;
const grossNgn = source * rate;

assert.ok(rate > 0, `quote must carry a rate, got ${quote.rate}`);
assert.equal(fees.revenueMode, 'sivan_fee_wallet', `expected wallet-fee revenue mode, got ${fees.revenueMode}`);

/**
 * 1. THE MARGIN HAS EXPLICIT UNITS.
 *
 * Derived from the percentage the quote says it applied rather than hardcoded,
 * so the test still holds when an admin changes the off-ramp rate. Before the
 * fix the API had one opaque `totalFee` and the UI treated a mixed number as
 * USDC, multiplying a naira-scale figure by the rate and showing a giant fee.
 */
const expectedMarginNgn = grossNgn * 0.01;
assert.ok(
  Math.abs(Number(fees.sivanMarginNgn) - expectedMarginNgn) < 1,
  `sivanMarginNgn should be naira (~${expectedMarginNgn.toFixed(2)}), got ${fees.sivanMarginNgn}.`
);
assert.ok(
  Math.abs(Number(fees.sivanMarginAsset) - (Number(fees.sivanMarginNgn) / rate)) < 0.000001,
  `sivanMarginAsset ${fees.sivanMarginAsset} should equal sivanMarginNgn / rate`
);

/**
 * 2. THE USER'S PAYOUT IS REDUCED BY A NAIRA-SCALE AMOUNT.
 *
 * The user-facing half of the same bug. Deliberately NOT reconstructed as
 * `gross - providerFee - destination`, because that assumes the provider's fee
 * is naira and only Breet guarantees that - see the note below. What holds for
 * ANY provider is that the payout is short of the naira gross by at least the
 * margin, and that the shortfall is a naira-scale number rather than dust.
 *
 * Before the fix the shortfall was 0.51 on a 97,024 gross. The floor here is
 * the margin itself, so this fails on any regression that re-denominates it.
 */
const shortfall = grossNgn - Number(quote.destinationAmount);
assert.ok(
  shortfall >= Number(fees.sivanMarginNgn) - 1,
  `payout is short of gross by only ${shortfall.toFixed(2)} NGN, which is less than the ` +
  `${fees.sivanMarginNgn} NGN margin - the margin is not reaching the destination`
);
assert.ok(
  shortfall > 1,
  `Sivan kept ${shortfall.toFixed(4)} NGN on a ${grossNgn.toFixed(2)} NGN off-ramp - that is ` +
  `the currency-mismatch bug, where the margin shrinks by the exchange rate`
);

/**
 * 3. totalFee AND effectivePercent ARE COHERENT IN BOTH UNITS.
 *
 * totalFee summed a naira provider fee with a dollar margin, and
 * effectivePercent divided that mixed total by a DOLLAR gross - which is how it
 * came out at 948.5% on a transaction whose real cost was about 1.5%.
 */
assert.ok(
  Math.abs(Number(fees.totalFee) - (Number(fees.providerFee) + Number(fees.sivanMargin))) < 0.02,
  `totalFee ${fees.totalFee} should be providerFee + sivanMargin in the source asset`
);
assert.ok(
  Math.abs(Number(fees.totalFeeNgn) - (Number(fees.providerFeeNgn) + Number(fees.sivanMarginNgn))) < 0.02,
  `totalFeeNgn ${fees.totalFeeNgn} should be providerFeeNgn + sivanMarginNgn`
);
assert.ok(
  Math.abs(Number(fees.totalFeeAsset) - (Number(fees.providerFeeAsset) + Number(fees.sivanMarginAsset))) < 0.000001,
  `totalFeeAsset ${fees.totalFeeAsset} should be providerFeeAsset + sivanMarginAsset`
);
assert.ok(
  Math.abs(Number(fees.effectivePercent) - ((Number(fees.totalFeeNgn) / grossNgn) * 100)) < 0.0001,
  `effectivePercent ${fees.effectivePercent} should equal totalFeeNgn / grossNgn`
);
assert.ok(
  Math.abs(Number(quote.feeAmount) - Number(fees.totalFeeAsset)) < 0.000001,
  `quote.feeAmount ${quote.feeAmount} should be the source-asset total ${fees.totalFeeAsset}`
);
assert.ok(
  Number(fees.effectivePercent) > 0 && Number(fees.effectivePercent) < 20,
  `effectivePercent ${fees.effectivePercent} is not a believable fee percentage`
);

await db.mutate((data) => {
  data.ngnControls[0].offrampRevenueMode = 'disabled';
});
const noRevenueQuote = await req(
  '/api/ngn/quote?userId=usr_margin&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=51.20&network=solana',
  { headers: authHeaders }
);
assert.equal(noRevenueQuote.metadata.fees.revenueMode, 'disabled');
assert.equal(Number(noRevenueQuote.metadata.fees.sivanMarginAsset), 0);
assert.equal(Number(noRevenueQuote.metadata.fees.sivanMarginNgn), 0);

console.log('ngn off-ramp margin:');
console.log(`  gross            ${grossNgn.toFixed(2)} NGN  (${source} @ ${rate})`);
console.log(`  provider fee     ${Number(fees.providerFeeNgn).toFixed(2)} NGN / ${Number(fees.providerFeeAsset).toFixed(6)} asset`);
console.log(`  sivan margin     ${Number(fees.sivanMarginNgn).toFixed(2)} NGN / ${Number(fees.sivanMarginAsset).toFixed(6)} asset`);
console.log(`  total fee        ${Number(fees.totalFeeNgn).toFixed(2)} NGN / ${Number(fees.totalFeeAsset).toFixed(6)} asset`);
console.log(`  user receives    ${Number(quote.destinationAmount).toFixed(2)} NGN`);
console.log(`  effective        ${fees.effectivePercent}%`);
console.log('PASS test:ngn-offramp-margin (9 assertions)');

await app.close();
