/**
 * THE FEE CURVE.
 *
 * Sivan sponsors gas on every crypto-to-crypto send - `sponsor: true` on both
 * the EVM and Solana paths - and charged nothing for it. balance.service.ts
 * contained no fee logic at all; the only economic guard was a minimum send
 * amount. Every transfer was a pure loss.
 *
 * The shape chosen is 0.5%, floor $0.10, cap $1.00. This suite pins the
 * PROPERTIES that make it defensible, not just the arithmetic:
 *
 *   - a $10 sender and a $100 sender pay comparable RATES, which a flat fee
 *     spectacularly fails (5% vs 0.5% at $0.50 flat)
 *   - the curve is CONTINUOUS, so no user is punished for crossing a boundary
 *   - one implementation, and the frontend does not carry a second copy
 *
 * Run: npm run test:transfer-fee-policy
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { quoteTransferFee, DEFAULT_TRANSFER_FEE, DEFAULT_TRANSFER_MIN_SEND } from '../src/balances/transfer-fee-policy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const fee = (amount: number) => Number(quoteTransferFee(amount).fee);
const rate = (amount: number) => Number(quoteTransferFee(amount).effectivePercent);

console.log('\n── the published curve ───────────────────────────────────────');

check('$10 pays $0.10 (the floor)', fee(10) === 0.1, String(fee(10)));
check('$20 pays $0.10 (floor and percent meet here)', fee(20) === 0.1, String(fee(20)));
check('$50 pays $0.25', fee(50) === 0.25, String(fee(50)));
check('$100 pays $0.50', fee(100) === 0.5, String(fee(100)));
check('$200 pays $1.00 (percent and cap meet here)', fee(200) === 1, String(fee(200)));
check('$500 pays $1.00 (the cap)', fee(500) === 1, String(fee(500)));
check('$1000 pays $1.00 (still the cap)', fee(1000) === 1, String(fee(1000)));

console.log('\n── nobody pays a wildly different rate for the same service ──');

/**
 * The whole reason a flat fee was rejected. At $0.50 flat the spread between
 * a $10 and a $100 transfer is 5.00% vs 0.50% - a factor of TEN. Here it is
 * 1.00% vs 0.50%, a factor of two, and only at the very bottom.
 */
check('a $10 sender pays at most 2x the rate of a $100 sender',
  rate(10) / rate(100) <= 2.0,
  `${rate(10)}% vs ${rate(100)}% = ${(rate(10) / rate(100)).toFixed(1)}x`);
check('the worst rate on the curve is at the minimum send amount',
  rate(DEFAULT_TRANSFER_MIN_SEND) >= rate(10) && rate(10) >= rate(100),
  'the rate must fall monotonically as the amount rises');
check('even the smallest allowed transfer stays at or under 2%',
  rate(DEFAULT_TRANSFER_MIN_SEND) <= 2.0,
  `${rate(DEFAULT_TRANSFER_MIN_SEND)}% at $${DEFAULT_TRANSFER_MIN_SEND}`);
check('a large transfer is genuinely cheap',
  rate(1000) <= 0.1, `${rate(1000)}%`);

console.log('\n── the curve is continuous: no cliffs ────────────────────────');

/**
 * A BANDED FIXED STRUCTURE WAS MODELLED AND REJECTED FOR THIS EXACT REASON:
 *
 *     0-25:$0.15 | 25-100:$0.35 | 100-500:$0.75 | 500+:$1.50
 *         $99.99 -> $0.35        $100.01 -> $0.75
 *
 * The fee more than DOUBLES across two cents. A user who notices is being
 * cheated in a way that cannot be defended, and tiers are exactly the shape an
 * admin panel invites someone to add later.
 */
for (const boundary of [20, 200]) {
  const below = fee(boundary - 0.01);
  const above = fee(boundary + 0.01);
  check(`no jump at the $${boundary} boundary`,
    Math.abs(above - below) < 0.01,
    `$${(boundary - 0.01).toFixed(2)} -> $${below} but $${(boundary + 0.01).toFixed(2)} -> $${above}`);
}

// Sweep the whole range: no single cent may change the fee by more than a cent.
let worstJump = 0;
let worstAt = 0;
for (let a = 1; a <= 1000; a += 0.5) {
  const jump = Math.abs(fee(a + 0.5) - fee(a));
  if (jump > worstJump) { worstJump = jump; worstAt = a; }
}
check('no discontinuity anywhere from $1 to $1000',
  worstJump < 0.01,
  `largest jump $${worstJump.toFixed(4)} near $${worstAt}`);

check('the fee never decreases as the amount rises',
  (() => {
    for (let a = 1; a < 1000; a += 1) if (fee(a + 1) < fee(a) - 1e-9) return false;
    return true;
  })(),
  'a larger transfer must never cost less in absolute terms');

console.log('\n── which rule applied, for the UI and for support ────────────');

check('$10 is explained by the minimum', quoteTransferFee(10).appliedRule === 'minimum');
check('$100 is explained by the percentage', quoteTransferFee(100).appliedRule === 'percent');
check('$500 is explained by the cap', quoteTransferFee(500).appliedRule === 'maximum');
check('the explanation names a real number',
  /\$0\.10/.test(quoteTransferFee(10).explanation),
  quoteTransferFee(10).explanation);

console.log('\n── the fee is DEDUCTED, not added ────────────────────────────');

const q = quoteTransferFee(100);
check('net = amount - fee', Number(q.netAmount) === 100 - Number(q.fee), q.netAmount);
check('the recipient of a 100 send receives 99.50', Number(q.netAmount) === 99.5, q.netAmount);
check('the amount is echoed unchanged', Number(q.amount) === 100);

console.log('\n── degenerate inputs cannot produce dangerous output ─────────');

check('a zero amount is free', fee(0) === 0);
check('a negative amount is free, not negative', fee(-50) === 0, String(fee(-50)));
check('NaN is free rather than NaN', fee(Number.NaN) === 0, String(fee(Number.NaN)));
check('the fee never exceeds the amount',
  (() => {
    for (const a of [0.01, 0.05, 0.1, 0.5, 1, 2]) if (fee(a) > a) return false;
    return true;
  })(),
  'a $0.05 transfer charged a $0.10 floor would produce a NEGATIVE net');
check('net is never negative',
  [0.01, 0.05, 0.5, 1].every((a) => Number(quoteTransferFee(a).netAmount) >= 0));

console.log('\n── configuration is honoured, and misconfiguration is safe ───');

const zeroed = { percent: 0, minimumUsd: 0, maximumUsd: 0 };
check('a fully zeroed config charges nothing', Number(quoteTransferFee(100, zeroed).fee) === 0,
  'an operator must be able to switch the fee off');
check('a raised cap is honoured',
  Number(quoteTransferFee(1000, { percent: 0.5, minimumUsd: 0.1, maximumUsd: 5 }).fee) === 5);
check('a cap below the floor still caps',
  Number(quoteTransferFee(1, { percent: 0.5, minimumUsd: 1, maximumUsd: 0.5 }).fee) === 0.5,
  'the advertised maximum is the more visible promise, so it wins');

console.log('\n── one implementation only ───────────────────────────────────');

const frontendFiles: string[] = [];
const walk = (dir: string) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(entry.name)) frontendFiles.push(full);
  }
};
walk(path.join(root, 'frontend/src'));

/**
 * The frontend must ASK for a quote, never compute one. A UI that quotes a
 * different fee from the one charged is a support ticket that reads as theft.
 */
const reimplemented = frontendFiles.filter((file) => {
  const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // The signature of the curve: a percentage clamped between two bounds.
  return /Math\.(min|max)\([^)]*0\.1[^)]*\)/.test(src) && /0\.005|\* *0\.5 *\/ *100|percent *\/ *100/.test(src);
});
check('the fee curve is not reimplemented in the frontend',
  reimplemented.length === 0,
  reimplemented.map((f) => path.relative(root, f)).join(', '));

console.log('\n── the minimum send amount agrees with the floor ─────────────');

check('the default minimum is 5',
  DEFAULT_TRANSFER_MIN_SEND === 5,
  `${DEFAULT_TRANSFER_MIN_SEND} - lowered from 10 once transfers were priced`);
check('at the minimum, the fee floor is still defensible',
  rate(DEFAULT_TRANSFER_MIN_SEND) <= 2.0,
  `${rate(DEFAULT_TRANSFER_MIN_SEND)}% - at $1 the floor would be 10%`);
check('the defaults are the published curve',
  DEFAULT_TRANSFER_FEE.percent === 0.5 &&
  DEFAULT_TRANSFER_FEE.minimumUsd === 0.1 &&
  DEFAULT_TRANSFER_FEE.maximumUsd === 1,
  JSON.stringify(DEFAULT_TRANSFER_FEE));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
