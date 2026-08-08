/**
 * USDT COSTS BRIDGE 0.10% MORE, IN EVERY FLOW - NOT JUST SUPPLIER PAYOUTS.
 *
 * Bridge's pricing: 0.50% on on-ramp and off-ramp volume, "USDT Support:
 * +0.10%". Supplier payouts were priced against that; off-ramp and on-ramp
 * were not. Both charged the USDC rate for USDT, so every USDT transaction
 * earned 0.10% less than the fee tables claimed - thin margin rather than a
 * loss, and completely silent because nothing recorded that USDT cost more.
 *
 * USDT is not hypothetical here: the deployed test API has it enabled
 * (sourceAssets: usdt enabled = true), switched on by sup_ola.
 *
 * Run: npm run test:usdt-surcharge
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-usdt-surcharge.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.BRIDGE_MOCK_MODE = 'true';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'usdt-admin-key';
process.env.RATE_LIMIT_ENABLED = 'false';

import fs from 'node:fs';
fs.rmSync('.data/test-usdt-surcharge.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const {
  usdtSurchargePercentFor, providerCostPercentFor,
  BRIDGE_USDT_SURCHARGE_PERCENT, BRIDGE_OFFRAMP_COST_PERCENT,
} = await import('../src/suppliers/supplier-fee-policy.js');

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 1. one surcharge rule, shared by every flow ──────────────');

check('USDT carries Bridge\'s +0.10%', usdtSurchargePercentFor('usdt') === 0.1);
check('USDC carries nothing', usdtSurchargePercentFor('usdc') === 0);
check('and the rule is case-insensitive', usdtSurchargePercentFor('USDT') === 0.1);
/**
 * `undefined` must be free, not surcharged. Callers that do not yet pass an
 * asset would otherwise start over-charging every USDC user.
 */
check('an unknown or missing asset is not surcharged',
  usdtSurchargePercentFor(undefined) === 0 && usdtSurchargePercentFor('') === 0);
check('the supplier path uses the same rule',
  providerCostPercentFor('usdt') === BRIDGE_OFFRAMP_COST_PERCENT + BRIDGE_USDT_SURCHARGE_PERCENT);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 2. OFF-RAMP: the liquidation address percent ─────────────');

const { getLiquidationAddressFeePercent } = await import('../src/offramp/service/fees.service.js');

const usdcPct = await getLiquidationAddressFeePercent({ destinationCurrency: 'usd' as any, destinationPaymentRail: 'ach', sourceCurrency: 'usdc' });
const usdtPct = await getLiquidationAddressFeePercent({ destinationCurrency: 'usd' as any, destinationPaymentRail: 'ach', sourceCurrency: 'usdt' });

check('a USDC withdrawal keeps the base rate', usdcPct === '1.25', String(usdcPct));
check('a USDT withdrawal is 0.10% higher', usdtPct === '1.35', String(usdtPct));
/**
 * Bridge rejects custom_developer_fee_percent with more than 2 decimals -
 * measured on the real sandbox for developer_fee, and the same limit applies.
 * Floating point makes 1.25 + 0.1 = 1.3499999999999999 without rounding.
 */
check('and it is formatted to 2 decimals, as Bridge requires',
  /^\d+\.\d{2}$/.test(String(usdtPct)), String(usdtPct));

/** Omitting the asset must not silently surcharge. */
const noAsset = await getLiquidationAddressFeePercent({ destinationCurrency: 'usd' as any, destinationPaymentRail: 'ach' });
check('a caller that omits the asset gets the base rate, not a surcharge',
  noAsset === usdcPct, String(noAsset));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 3. ON-RAMP: the quote a buyer is shown ───────────────────');

const { calculateOnrampQuote } = await import('../src/onramp/service/onramp-fees.service.js');

const buyUsdc = await calculateOnrampQuote(1_000, 'usdc');
const buyUsdt = await calculateOnrampQuote(1_000, 'usdt');
check('buying USDT costs more than buying USDC',
  Number(buyUsdt.feeAmount) > Number(buyUsdc.feeAmount),
  `usdc ${buyUsdc.feeAmount} vs usdt ${buyUsdt.feeAmount}`);
check('and the difference is exactly 0.10% of the order',
  Math.abs((Number(buyUsdt.feeAmount) - Number(buyUsdc.feeAmount)) - 1) < 0.01,
  `${(Number(buyUsdt.feeAmount) - Number(buyUsdc.feeAmount)).toFixed(2)} on a $1,000 order`);
check('the USDC quote is unchanged by this work',
  Number(buyUsdc.feeAmount) === 12.5, buyUsdc.feeAmount);

/**
 * THE SURCHARGE MUST SCALE, not be a flat add. 0.10% of $10,000 is $10, not
 * the $1 it was on a $1,000 order.
 */
const bigUsdc = await calculateOnrampQuote(10_000, 'usdc');
const bigUsdt = await calculateOnrampQuote(10_000, 'usdt');
check('the surcharge scales with the order, because it is a percentage',
  Math.abs((Number(bigUsdt.feeAmount) - Number(bigUsdc.feeAmount)) - 10) < 0.05,
  `${(Number(bigUsdt.feeAmount) - Number(bigUsdc.feeAmount)).toFixed(2)} on a $10,000 order`);

const buyNoAsset = await calculateOnrampQuote(1_000);
check('an on-ramp quote with no asset stays at the base rate',
  Number(buyNoAsset.feeAmount) === Number(buyUsdc.feeAmount), buyNoAsset.feeAmount);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 4. the flows actually pass the asset through ─────────────');

/**
 * The helpers above can be perfectly correct while nothing calls them with a
 * real asset - which was exactly the previous state. These assert the wiring.
 */
const wd = fs.readFileSync('src/offramp/service/withdrawals.service.ts', 'utf8');
check('the withdrawal path passes its source asset to the fee',
  /getLiquidationAddressFeePercent\(\{[\s\S]{0,300}?sourceCurrency: input\.sourceCurrency/.test(wd),
  'without this the fee function is correct and never asked the question');

const orders = fs.readFileSync('src/onramp/service/onramp-orders.service.ts', 'utf8');
check('the on-ramp order path passes the destination asset',
  /calculateOnrampQuote\(input\.amount,\s*input\.destinationCurrency\)/.test(orders));

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
