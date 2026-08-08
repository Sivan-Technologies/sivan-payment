/**
 * THE NAIRA WITHDRAWAL SCREENS QUOTED THREE DIFFERENT FEES FOR ONE WITHDRAWAL.
 *
 * Reported from two screenshots of the same 51 USDC withdrawal:
 *
 *   quote screen   "FEE  ₦1"          and  YOU RECEIVE ₦75,734
 *   confirm screen "SIVAN FEE 1.25%"  and  "ESTIMATED NETWORK FEE $0.0010"
 *
 * 51 USDC at ₦1,500 is ₦76,500 gross. Receiving ₦75,734 means ₦766 was taken -
 * 766x what the fee row claimed, and the actual rate was 1%, not the 1.25%
 * the next screen promised, and not the 1.5% intended once Breet's own 0.5%
 * is counted. Three numbers, none of them right.
 *
 * Run: npm run test:ngn-fee-honesty
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-ngn-fee-honesty.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.BRIDGE_MOCK_MODE = 'true';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'ngn-fee-admin-key';
process.env.RATE_LIMIT_ENABLED = 'false';

import fs from 'node:fs';
fs.rmSync('.data/test-ngn-fee-honesty.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { applySivanMargin } = await import('../src/ngn/service/ngn-margin.js');

const RATE = 1500;
const SEND = 51;

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 1. the provider fee arrives in NAIRA, the gross is USDC ──');

/**
 * THE 751% BUG. breet.provider.ts computes its off-ramp fee on the naira
 * gross:
 *     const gross = source * rate;            // 51 -> 76,500
 *     feeAmount = gross * (feePercent / 100); // 382.50
 * while grossAmount here is 51 USDC. Adding those without converting charged
 * 383 USDC on a 51 USDC withdrawal.
 *
 * Dormant only because the live NGN provider is `mock`, which reports no fee.
 * It would have fired on the first real Breet off-ramp.
 */
const breetFeeNgn = SEND * RATE * 0.005;   // 382.50 NGN, as Breet reports it
const withRate = await applySivanMargin({
  direction: 'offramp', grossAmount: SEND, providerFeeAmount: breetFeeNgn, rate: RATE,
} as any);

check('a naira provider fee is converted into source units',
  Math.abs(withRate.providerFee - 0.255) < 0.001,
  `${withRate.providerFee} USDC (382.50 NGN / 1500)`);
check('so the total is 1.5%, not 751%',
  Math.abs(withRate.effectivePercent - 1.5) < 0.01,
  `${withRate.effectivePercent}%`);
check('and the user keeps almost all of their money',
  (SEND - withRate.totalFee) > 50, `${(SEND - withRate.totalFee).toFixed(4)} USDC left of 51`);

/** The three figures must add up, or an admin screen contradicts itself. */
check('providerFee + sivanMargin === totalFee',
  Math.abs((withRate.providerFee + withRate.sivanMargin) - withRate.totalFee) < 0.000001,
  `${withRate.providerFee} + ${withRate.sivanMargin} vs ${withRate.totalFee}`);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 2. the intended 1.5% = 1% Sivan + 0.5% Breet ─────────────');

check('Sivan takes its configured 1%',
  Math.abs(withRate.sivanMargin - 0.51) < 0.001, `${withRate.sivanMargin} USDC`);
check('Breet takes 0.5%',
  Math.abs(withRate.providerFee - 0.255) < 0.001, `${withRate.providerFee} USDC`);

const ngnTaken = withRate.totalFee * RATE;
check('which is ₦1,148 on a ₦76,500 gross',
  Math.abs(ngnTaken - 1147.5) < 1, `₦${ngnTaken.toFixed(0)}`);

/**
 * THE SCREENSHOT STATE, asserted so the regression is named: with no provider
 * fee the user was charged only Sivan's 1%.
 */
const noProvider = await applySivanMargin({
  direction: 'offramp', grossAmount: SEND, providerFeeAmount: 0, rate: RATE,
} as any);
check('with no provider fee reported it is only 1% - the reported symptom',
  Math.abs(noProvider.effectivePercent - 1) < 0.01, `${noProvider.effectivePercent}%`);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 3. omitting the rate must not silently 1500x the fee ─────');

/**
 * On-ramp and the mock provider both report a fee already in gross units, so
 * `rate` is absent there and the value must pass through untouched.
 */
const noRate = await applySivanMargin({
  direction: 'offramp', grossAmount: SEND, providerFeeAmount: 0.255,
} as any);
check('a fee already in source units is left alone when no rate is given',
  Math.abs(noRate.providerFee - 0.255) < 0.001, `${noRate.providerFee}`);
check('and a zero rate does not divide by zero',
  Number.isFinite((await applySivanMargin({ direction: 'offramp', grossAmount: SEND, providerFeeAmount: 0.255, rate: 0 } as any)).totalFee));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 4. the screens no longer contradict each other ───────────');

/**
 * COMMENTS STRIPPED, and I have now been caught by this twice.
 *
 * The fix's own comment quotes the buggy line verbatim to explain it, so a
 * regex over the raw file matches the explanation and reports the bug as
 * still present. Same trap as the migration-guard assertion: the test was
 * checking that the bug was DESCRIBED, not that it was gone.
 */
const formRaw = fs.readFileSync('frontend/src/components/sell/NgnPayoutForm.tsx', 'utf8');
const form = formRaw
  // Strip /* ... */ blocks wholesale, then line comments. Filtering by
  // leading '*' missed a wrapped line inside a JSX block comment that began
  // with prose, which is exactly where the old code is quoted.
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');
/**
 * The fee row rendered formatPayoutAmount(feeAmount, 'ngn') on a USDC value,
 * printing 0.5107 USDC as "₦1".
 */
check('the quote fee is no longer labelled naira while holding USDC',
  !/formatPayoutAmount\(quote\.feeAmount, 'ngn'\)/.test(form),
  'a USDC fee printed with a ₦ sign understates it by the exchange rate');
/**
 * Rewritten for the itemised rows. The old assertion matched the single-line
 * markup this replaced, so it went red on a change that IMPROVED the thing it
 * was guarding - a test pinned to the shape of the fix rather than to its
 * meaning.
 */
check('and it states the asset it is actually charged in',
  /assetUnit = asset\.toUpperCase\(\)/.test(form) && /\$\{inAsset\}/.test(form),
  'the fee must name USDC, not imply naira');

const sections = fs.readFileSync('frontend/src/components/AppSections.tsx', 'utf8');
check('the confirm screen uses the NAIRA rate, not Bridge\'s',
  /isNgnPayout[\s\S]{0,120}ngnFeePercent/.test(sections),
  'feePolicy.percent is Bridge 1.25%; a naira payout is priced by the NGN rail');
/**
 * Asked for directly: with "Sivan fee" already stated, a $0.0010 gas figure
 * the user does not pay adds a number to reconcile and answers nothing.
 */
check('the network fee row is hidden on naira payouts',
  /estimatedGasUsd !== undefined && !isNgnPayout/.test(sections));
check('but kept for crypto and foreign rails, where it decides the minimum',
  /!isNgnPayout && \(/.test(sections));

// The server must serve the number the UI now reads.
const controls = fs.readFileSync('src/controls/payment-controls.service.ts', 'utf8');
check('the public controls payload carries the NGN off-ramp rate',
  /ngnOfframpFeePercent/.test(controls));
check('and falls back to the Bridge rate exactly as applySivanMargin does',
  /Number\(feeSettings\?\.ngnOfframpFeePercent \?\? 0\) > 0/.test(controls),
  'zero means not-set on both sides, or the shown rate diverges from the charged one');

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 5. the fee is ITEMISED on the quote card ─────────────────');

/**
 * A single opaque number cannot be checked by the person paying it. The
 * server already computed providerFee / sivanMargin / totalFee and put them
 * on metadata.fees, and NOTHING read them - the card had only `feeAmount`,
 * which is how a USDC value came to be printed with a naira sign.
 */
const quoteSrc = fs.readFileSync('src/ngn/service/ngn-quotes.service.ts', 'utf8');
check('the quote returns the breakdown as a top-level field',
  /fees: \{[\s\S]{0,200}sivanMargin/.test(quoteSrc),
  'it existed only on metadata, where the client never looked');

check('the card renders Sivan margin and provider fee separately',
  /label: 'Sivan fee'/.test(form) && /label: 'Provider fee'/.test(form));
/**
 * On the mock provider the provider fee is 0, and a "Provider fee ₦0" row
 * invites a question for no benefit. It appears only when there is one.
 */
check('the provider row is hidden when the provider charges nothing',
  /Number\(fees\.providerFee\) > 0/.test(form),
  'a zero row is noise, not transparency');
check('and a total appears only once there are two things to add up',
  /label: `Total fee/.test(form));

check('naira comes first, the asset second',
  /\$\{naira\} · \$\{inAsset\}/.test(form),
  'every other figure on the card is naira; the fee should not force a conversion');

/**
 * CAUGHT IN A RENDER, NOT IN THE CODE. A 0.5% provider fee on 51 USDC came
 * out as "₦382.5", and the payout as "₦75,352.5". Naira has kobo, but a bank
 * transfer settles in whole naira - a half-kobo cannot exist, and one visible
 * on the card makes every other number look approximate.
 */
check('naira amounts are rounded to whole naira',
  /Math\.round\(amount \* rate\)/.test(form),
  'a half-kobo is a quantity that cannot be paid out');

/**
 * THE ROW MUST RECONCILE. A user subtracts "you receive" from the gross and
 * expects the fee row to match; if it does not, they conclude money went
 * missing. 51 USDC at 1,500 = 76,500 gross, 1% Sivan fee = 765.
 */
const grossNgn = SEND * RATE;
const feeNgnShown = Math.round(noProvider.totalFee * RATE);
const receiveNgn = Math.round((SEND - noProvider.totalFee) * RATE);
check('gross − receive equals the fee row exactly',
  grossNgn - receiveNgn === feeNgnShown,
  `${grossNgn} − ${receiveNgn} = ${grossNgn - receiveNgn}, row shows ${feeNgnShown}`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
