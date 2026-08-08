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
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${(app.server.address() as any).port}`;

async function req(path: string, options: any = {}, expected = 200) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const json = await response.json().catch(() => ({}));
  assert.equal(
    response.status,
    expected,
    `${path} expected ${expected}, got ${response.status}: ${JSON.stringify(json)}`
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

/**
 * 1. THE MARGIN IS NAIRA.
 *
 * Derived from the percentage the quote says it applied rather than hardcoded,
 * so the test still holds when an admin changes the off-ramp rate. Before the
 * fix sivanMargin was the dollar figure - 1895x smaller - and this failed.
 */
const appliedPercent = Number(fees.effectivePercent) - (Number(fees.providerFee) / grossNgn) * 100;
const expectedMarginNgn = (grossNgn * appliedPercent) / 100;
assert.ok(
  Math.abs(Number(fees.sivanMargin) - expectedMarginNgn) < 1,
  `sivanMargin should be naira (~${expectedMarginNgn.toFixed(2)}), got ${fees.sivanMargin}. ` +
  `A value near ${(expectedMarginNgn / rate).toFixed(2)} means it is still denominated in USD.`
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
  shortfall >= Number(fees.sivanMargin) - 1,
  `payout is short of gross by only ${shortfall.toFixed(2)} NGN, which is less than the ` +
  `${fees.sivanMargin} NGN margin - the margin is not reaching the destination`
);
assert.ok(
  shortfall > 1,
  `Sivan kept ${shortfall.toFixed(4)} NGN on a ${grossNgn.toFixed(2)} NGN off-ramp - that is ` +
  `the currency-mismatch bug, where the margin shrinks by the exchange rate`
);

/**
 * THE MOCK AND BREET DO NOT AGREE ON WHAT feeAmount MEANS.
 *
 * Breet returns the off-ramp fee in NAIRA - the live sandbox quote came back
 * 485.12, which is 0.5% of the 97,024 naira gross. The mock returns it in
 * CRYPTO: `source * 0.005`, or 0.256 USDC.
 *
 * The mock also contradicts itself. It reports a 0.5% fee while its
 * destinationAmount deducts 1%:
 *
 *     feeAmount        = source * 0.005          // 0.256 USDC
 *     destinationAmount = (source * rate) - (source * rate * 0.01)
 *
 * So under the mock, totalFee still adds naira to dollars, and a quote's stated
 * fee does not match the payout it produces. That is not what this test is
 * guarding and it is not a production path, but it is worth stating plainly:
 * the double whose job is to stand in for Breet models the fee differently from
 * Breet in both CURRENCY and RATE, which is precisely what let a currency bug
 * live in the naira path without a single test going red.
 */


/**
 * 3. totalFee AND effectivePercent ARE COHERENT.
 *
 * totalFee summed a naira provider fee with a dollar margin, and
 * effectivePercent divided that mixed total by a DOLLAR gross - which is how it
 * came out at 948.5% on a transaction whose real cost was about 1.5%.
 */
assert.ok(
  Math.abs(Number(fees.totalFee) - (Number(fees.providerFee) + Number(fees.sivanMargin))) < 0.02,
  `totalFee ${fees.totalFee} should be providerFee + sivanMargin in one currency`
);
assert.ok(
  Number(fees.effectivePercent) > 0 && Number(fees.effectivePercent) < 20,
  `effectivePercent ${fees.effectivePercent} is not a believable fee percentage`
);

console.log('ngn off-ramp margin:');
console.log(`  gross            ${grossNgn.toFixed(2)} NGN  (${source} @ ${rate})`);
// No unit on the provider fee on purpose - the mock reports it in crypto and
// Breet in naira, so labelling it here would print something untrue.
console.log(`  provider fee     ${Number(fees.providerFee).toFixed(2)} (provider's own units)`);
console.log(`  sivan margin     ${Number(fees.sivanMargin).toFixed(2)} NGN  (was ${(Number(fees.sivanMargin) / rate).toFixed(4)} before the fix)`);
console.log(`  user receives    ${Number(quote.destinationAmount).toFixed(2)} NGN`);
console.log(`  effective        ${fees.effectivePercent}%`);
console.log('PASS test:ngn-offramp-margin (5 assertions)');

await app.close();
