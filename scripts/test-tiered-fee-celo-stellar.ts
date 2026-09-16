/**
 * TIERED FEE SCHEDULE: CELO AND STELLAR MICRO-RAIL VERIFICATION.
 *
 * Sivan Ai introduces a dual-tier fee model:
 *
 *   Standard EVM rail  (Base, BSC, Ethereum, Solana):
 *     0.5%  |  floor $0.25  |  cap $1.00
 *
 *   High-efficiency micro-rail (Celo, Stellar):
 *     0.5%  |  floor $0.10  |  cap $0.75
 *
 * Economic rationale: Celo (CIP-64, feeCurrency in signed tx bytes) and
 * Stellar (Soroban / Classic payment) carry sub-cent on-chain gas costs
 * (~$0.0001 on Celo, ~$0.000001 on Stellar), so Sivan's cost of settlement
 * per transfer is negligible. Lowering the floor to $0.10 on a $5 USDC
 * send still leaves >99.8% gross margin while making the fee 60% cheaper
 * than the standard rail for the everyday African micro-payment case.
 *
 * This suite pins:
 *   1. The exact fee at every sample point from the design document tables.
 *   2. The four invariants the spec mandates.
 *   3. That the standard EVM curve is NOT changed by adding Celo/Stellar.
 *   4. That casing and whitespace in the network name are normalised.
 *   5. That the new-recipient surcharge differs correctly between networks.
 *
 * Run: npm run test:tiered-fee
 */

import {
  quoteTransferFee,
  resolveNetworkFeeConfig,
  DEFAULT_TRANSFER_FEE,
} from '../src/balances/transfer-fee-policy.js';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

const celoConfig   = resolveNetworkFeeConfig('celo');
const stellarConfig = resolveNetworkFeeConfig('stellar');
const defaultConfig = resolveNetworkFeeConfig();  // no network -> EVM default

const fee = (amount: number, network: string) =>
  Number(quoteTransferFee(amount, resolveNetworkFeeConfig(network)).fee);

const rule = (amount: number, network: string) =>
  quoteTransferFee(amount, resolveNetworkFeeConfig(network)).appliedRule;

const net = (amount: number, network: string) =>
  Number(quoteTransferFee(amount, resolveNetworkFeeConfig(network)).netAmount);

// ── 1. resolved config sanity ─────────────────────────────────────────────

console.log('\n══ 1. network config resolution ══════════════════════════════');

check('celo: floor is $0.10',   celoConfig.minimumUsd  === 0.10, String(celoConfig.minimumUsd));
check('celo: cap   is $0.75',   celoConfig.maximumUsd  === 0.75, String(celoConfig.maximumUsd));
check('celo: rate  is 0.5%',    celoConfig.percent     === 0.5,  String(celoConfig.percent));
check('celo: no new-recipient surcharge',  celoConfig.newRecipientUsd === 0.0, String(celoConfig.newRecipientUsd));

check('stellar: floor is $0.10',  stellarConfig.minimumUsd   === 0.10, String(stellarConfig.minimumUsd));
check('stellar: cap   is $0.75',  stellarConfig.maximumUsd   === 0.75, String(stellarConfig.maximumUsd));
check('stellar: rate  is 0.5%',   stellarConfig.percent      === 0.5,  String(stellarConfig.percent));
check('stellar: trustline surcharge is $0.15', stellarConfig.newRecipientUsd === 0.15, String(stellarConfig.newRecipientUsd));

check('default (no network): floor is $0.25', defaultConfig.minimumUsd === 0.25, String(defaultConfig.minimumUsd));
check('default (no network): cap   is $1.00', defaultConfig.maximumUsd === 1.00, String(defaultConfig.maximumUsd));
check('default (no network): matches DEFAULT_TRANSFER_FEE exactly',
  JSON.stringify(defaultConfig) === JSON.stringify(DEFAULT_TRANSFER_FEE));

// ── 2. casing / whitespace normalisation ─────────────────────────────────

console.log('\n══ 2. normalisation ════════════════════════════════════════════');

check('"CELO" resolves to micro-rail',   resolveNetworkFeeConfig('CELO').minimumUsd   === 0.10);
check('"Celo" resolves to micro-rail',   resolveNetworkFeeConfig('Celo').minimumUsd   === 0.10);
check('"STELLAR" resolves to micro-rail', resolveNetworkFeeConfig('STELLAR').minimumUsd === 0.10);
check('"Stellar" resolves to micro-rail', resolveNetworkFeeConfig('Stellar').minimumUsd === 0.10);
check('undefined resolves to EVM default', resolveNetworkFeeConfig(undefined).minimumUsd === 0.25);
check('empty string resolves to EVM default', resolveNetworkFeeConfig('').minimumUsd === 0.25);
check('"base" resolves to EVM default',   resolveNetworkFeeConfig('base').minimumUsd   === 0.25);
check('"solana" resolves to EVM default', resolveNetworkFeeConfig('solana').minimumUsd === 0.25);

// ── 3. celo fee curve (from design document Table 2) ─────────────────────

console.log('\n══ 3. celo fee curve (spec Table 2) ════════════════════════════');

/**
 * Fee curve examples from the design document:
 *   $5   -> $0.10 (floor, 2.0%)
 *   $10  -> $0.10 (floor, 1.0%)
 *   $20  -> $0.10 (floor, 0.50%)
 *   $50  -> $0.25 (0.5% nominal)
 *   $100 -> $0.50 (0.5% nominal)
 *   $150 -> $0.75 (cap reached)
 *   $500 -> $0.75 (cap locked)
 */
check('celo $5   -> $0.10 (floor)',   fee(5,   'celo') === 0.10,  String(fee(5,   'celo')));
check('celo $10  -> $0.10 (floor)',   fee(10,  'celo') === 0.10,  String(fee(10,  'celo')));
check('celo $20  -> $0.10 (floor)',   fee(20,  'celo') === 0.10,  String(fee(20,  'celo')));
check('celo $50  -> $0.25 (percent)', fee(50,  'celo') === 0.25,  String(fee(50,  'celo')));
check('celo $100 -> $0.50 (percent)', fee(100, 'celo') === 0.50,  String(fee(100, 'celo')));
check('celo $150 -> $0.75 (cap)',     fee(150, 'celo') === 0.75,  String(fee(150, 'celo')));
check('celo $500 -> $0.75 (cap)',     fee(500, 'celo') === 0.75,  String(fee(500, 'celo')));

check('celo $5  rule: minimum',  rule(5,   'celo') === 'minimum',  rule(5,   'celo'));
check('celo $50 rule: percent',  rule(50,  'celo') === 'percent',  rule(50,  'celo'));
// At $150 on celo: 0.5% of $150 = $0.75 = cap exactly, so percent fires first.
// At $200: 0.5% of $200 = $1.00 > $0.75 cap, so maximum fires unambiguously.
check('celo $200 rule: maximum (cap applies)', rule(200, 'celo') === 'maximum',  rule(200, 'celo'));

// Crossover: 0.5% of amount = 0.10 => amount = $20 exact
check('celo crossover floor->percent at exactly $20',
  fee(19.99, 'celo') === 0.10 && fee(20, 'celo') === 0.10 && fee(20.01, 'celo') > 0.10,
  `$19.99=${fee(19.99,'celo')} $20=${fee(20,'celo')} $20.01=${fee(20.01,'celo')}`);

// ── 4. stellar fee curve (from design document Table 2) ──────────────────

console.log('\n══ 4. stellar fee curve (spec Table 2) ═════════════════════════');

check('stellar $5   -> $0.10 (floor)',   fee(5,   'stellar') === 0.10,  String(fee(5,   'stellar')));
check('stellar $10  -> $0.10 (floor)',   fee(10,  'stellar') === 0.10,  String(fee(10,  'stellar')));
check('stellar $20  -> $0.10 (floor)',   fee(20,  'stellar') === 0.10,  String(fee(20,  'stellar')));
check('stellar $50  -> $0.25 (percent)', fee(50,  'stellar') === 0.25,  String(fee(50,  'stellar')));
check('stellar $100 -> $0.50 (percent)', fee(100, 'stellar') === 0.50,  String(fee(100, 'stellar')));
check('stellar $150 -> $0.75 (cap)',     fee(150, 'stellar') === 0.75,  String(fee(150, 'stellar')));
check('stellar $500 -> $0.75 (cap)',     fee(500, 'stellar') === 0.75,  String(fee(500, 'stellar')));

// Stellar trustline surcharge
const stellarNewRecip = (amount: number) =>
  quoteTransferFee(amount, stellarConfig, { createsRecipientAccount: true });
const stellarRepeat = (amount: number) =>
  quoteTransferFee(amount, stellarConfig, { createsRecipientAccount: false });

check('stellar new trustline: $5 total = $0.10 + $0.15 = $0.25',
  Number(stellarNewRecip(5).fee) === 0.25,
  String(stellarNewRecip(5).fee));
check('stellar new trustline: $50 total = $0.25 + $0.15 = $0.40',
  Number(stellarNewRecip(50).fee) === 0.40,
  String(stellarNewRecip(50).fee));
check('stellar repeat recipient: $5 = $0.10 (no surcharge)',
  Number(stellarRepeat(5).fee) === 0.10,
  String(stellarRepeat(5).fee));
check('stellar: surcharge sits OUTSIDE the cap ($150 -> $0.75 cap + $0.15 surcharge = $0.90)',
  Number(stellarNewRecip(150).fee) === 0.90,
  String(stellarNewRecip(150).fee));
check('stellar: base fee at cap is still $0.75',
  Number(stellarNewRecip(150).baseFee) === 0.75,
  String(stellarNewRecip(150).baseFee));

// ── 5. celo has ZERO new-recipient surcharge ──────────────────────────────

console.log('\n══ 5. celo new-recipient surcharge = $0.00 ══════════════════════');

const celoNewRecip = (amount: number) =>
  quoteTransferFee(amount, celoConfig, { createsRecipientAccount: true });

check('celo new-recipient flag does not add any surcharge',
  Number(celoNewRecip(20).newRecipientFee) === 0.00,
  String(celoNewRecip(20).newRecipientFee));
check('celo new-recipient total fee equals base fee',
  Number(celoNewRecip(20).fee) === 0.10,
  String(celoNewRecip(20).fee));

// ── 6. standard EVM curve is UNCHANGED ───────────────────────────────────

console.log('\n══ 6. standard EVM curve unchanged ════════════════════════════');

check('base $5   -> $0.25 (floor)',    fee(5,   'base')   === 0.25, String(fee(5,   'base')));
check('solana $5 -> $0.25 (floor)',    fee(5,   'solana') === 0.25, String(fee(5,   'solana')));
check('base $200  -> $1.00 (cap)',     fee(200, 'base')   === 1.00, String(fee(200, 'base')));
check('solana $500 -> $1.00 (cap)',    fee(500, 'solana') === 1.00, String(fee(500, 'solana')));
check('solana crossover at $50 (not $20)',
  fee(49, 'solana') === 0.25 && fee(50, 'solana') === 0.25,
  `$49=${fee(49,'solana')} $50=${fee(50,'solana')}`);

// ── 7. four invariants (spec Section 4.3) ────────────────────────────────

console.log('\n══ 7. four mandatory invariants ════════════════════════════════');

const networks = ['celo', 'stellar', 'base', 'solana', 'ethereum'];
const amounts  = [5, 10, 20, 50, 100, 150, 200, 500];

/**
 * Invariant 1: fee must never exceed the principal transfer amount.
 */
check('INV-1: fee never exceeds principal on any network/amount',
  networks.every((n) =>
    amounts.every((a) => {
      const q = quoteTransferFee(a, resolveNetworkFeeConfig(n));
      return Number(q.fee) <= a;
    })
  ));

/**
 * Invariant 2: net amount = gross amount - fee (conservation of value).
 */
check('INV-2: netAmount + fee = amount on every network/amount',
  networks.every((n) =>
    amounts.every((a) => {
      const q = quoteTransferFee(a, resolveNetworkFeeConfig(n));
      return Math.abs((Number(q.netAmount) + Number(q.fee)) - Number(q.amount)) < 1e-9;
    })
  ));

/**
 * Invariant 3: effective rate falls monotonically as principal increases
 * (verified per network across the realistic test range).
 */
check('INV-3: effective rate falls monotonically on celo',
  [5, 10, 20, 50, 100, 150, 500].every((a, i, arr) =>
    i === 0 || Number(quoteTransferFee(a, celoConfig).effectivePercent) <=
               Number(quoteTransferFee(arr[i - 1], celoConfig).effectivePercent)
  ));
check('INV-3: effective rate falls monotonically on stellar',
  [5, 10, 20, 50, 100, 150, 500].every((a, i, arr) =>
    i === 0 || Number(quoteTransferFee(a, stellarConfig).effectivePercent) <=
               Number(quoteTransferFee(arr[i - 1], stellarConfig).effectivePercent)
  ));

/**
 * Invariant 4: fee is positive (Sivan always collects something above the
 * configured floor once the amount exceeds it).
 */
check('INV-4: celo fee >= $0.10 for amounts >= $0.10',
  [5, 10, 20, 50, 100].every((a) => fee(a, 'celo') >= 0.10));
check('INV-4: stellar fee >= $0.10 for amounts >= $0.10',
  [5, 10, 20, 50, 100].every((a) => fee(a, 'stellar') >= 0.10));

// ── 8. curve continuity on celo ───────────────────────────────────────────

console.log('\n══ 8. curve continuity on celo and stellar ══════════════════════');

/**
 * No single $0.01 step in amount should ever move the fee by more than $0.01.
 * Guarantees there are no band cliffs anywhere in the 1-500 range.
 */
let maxJumpCelo = 0;
let maxJumpCeloAt = 0;
for (let a = 1; a <= 500; a += 0.5) {
  const delta = Math.abs(fee(a + 0.5, 'celo') - fee(a, 'celo'));
  if (delta > maxJumpCelo) { maxJumpCelo = delta; maxJumpCeloAt = a; }
}
check('celo curve has no discontinuity from $1 to $500',
  maxJumpCelo < 0.01,
  `largest jump ${maxJumpCelo.toFixed(5)} near $${maxJumpCeloAt}`);

let maxJumpStellar = 0;
let maxJumpStellarAt = 0;
for (let a = 1; a <= 500; a += 0.5) {
  const delta = Math.abs(fee(a + 0.5, 'stellar') - fee(a, 'stellar'));
  if (delta > maxJumpStellar) { maxJumpStellar = delta; maxJumpStellarAt = a; }
}
check('stellar curve has no discontinuity from $1 to $500',
  maxJumpStellar < 0.01,
  `largest jump ${maxJumpStellar.toFixed(5)} near $${maxJumpStellarAt}`);

// ── 9. competitive positioning checks ────────────────────────────────────

console.log('\n══ 9. competitive positioning ══════════════════════════════════');

/**
 * Key claim from the design doc: "Send $5 for just 10 cents."
 * The $5 celo fee must be exactly $0.10, not a penny more.
 */
check('marketing claim holds: $5 transfer costs exactly $0.10 on celo',
  fee(5, 'celo') === 0.10, String(fee(5, 'celo')));

/**
 * 60% cheaper claim: celo $5 fee ($0.10) vs standard $5 fee ($0.25).
 * 1 - 0.10/0.25 = 0.60 exactly.
 */
const saving = 1 - (fee(5, 'celo') / fee(5, 'base'));
check('celo saves >= 55% vs standard rail on $5 transfer (60% claimed)',
  saving >= 0.55,
  `saving=${(saving * 100).toFixed(1)}%`);

/**
 * Gross margin check: on the worst case ($5 celo, $0.10 fee), margin must
 * exceed 99% once the sub-cent on-chain cost is accounted for.
 * On-chain Celo gas: ~$0.00015. Net = $0.10 - $0.00015 = $0.09985.
 */
const celoGasCost = 0.00015;
const margin = (fee(5, 'celo') - celoGasCost) / fee(5, 'celo');
check('gross margin on $5 celo transfer exceeds 99%',
  margin > 0.99,
  `margin=${(margin * 100).toFixed(3)}%`);

// ── 10. degenerate and edge inputs ────────────────────────────────────────

console.log('\n══ 10. degenerate inputs ════════════════════════════════════════');

check('celo zero amount -> zero fee', fee(0, 'celo') === 0);
check('stellar zero amount -> zero fee', fee(0, 'stellar') === 0);
check('celo negative -> zero fee', fee(-10, 'celo') === 0, String(fee(-10, 'celo')));
check('celo NaN -> zero fee', fee(Number.NaN, 'celo') === 0, String(fee(Number.NaN, 'celo')));

check('celo net is never negative',
  [0.01, 0.05, 0.10, 1, 5].every((a) => net(a, 'celo') >= 0));
check('stellar net is never negative',
  [0.01, 0.05, 0.10, 1, 5].every((a) => net(a, 'stellar') >= 0));

// ── summary ───────────────────────────────────────────────────────────────

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nFailed assertions:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
