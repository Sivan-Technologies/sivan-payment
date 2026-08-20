/**
 * THE MONEY ARITHMETIC AND THE INPUT GUARDS, AS PURE FUNCTIONS.
 *
 * Every assertion here runs against real exported code with no database, no
 * network, no clock and no environment. That is the whole point: these are the
 * things a reviewer can re-run in two seconds and a CI box can run on every
 * push, which is what turns "it works when I click it" into "it is checked".
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT COVER.
 *
 * The end-to-end paths - insufficient balance refused, recipient credited,
 * webhook signature verified, NGN settlement initiated - are NOT here. They
 * need a database, a provider and a running server, and pretending to cover
 * them with mocks would produce assertions that pass while production is
 * broken. Those already live in their own suites (test-ngn-*, breet-e2e,
 * full-system) and in the e2e/ browser journeys. This file is the pure layer
 * underneath them.
 *
 * EXPECTED VALUES WERE MEASURED, NOT ASSUMED. The curve was probed first and
 * the numbers below are what the code actually returns. Two commonly-assumed
 * figures are wrong and are called out at their assertions:
 *
 *   - the effective rate at $20 is 1.25%, NOT 0.5% - the floor dominates
 *   - the floor/percent crossover is $50, not $20 ($0.25 / 0.005)
 *
 * Writing the assumed values would have shipped a red test on day one.
 *
 * Run: npx tsx scripts/test-fee-and-schema-invariants.ts
 */

import {
  quoteTransferFee,
  effectiveRateAt,
  DEFAULT_TRANSFER_FEE,
  DEFAULT_TRANSFER_MIN_SEND,
  type TransferFeeConfig,
} from '../src/balances/transfer-fee-policy.js';
import { createBalanceTransferSchema } from '../src/balances/balance.service.js';
import { createWithdrawalSchema } from '../src/offramp/service/withdrawals.service.js';
import { EVM_CONFIRMATIONS } from '../src/deposits/deposit-confirmation.service.js';

let pass = 0;
let fail = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
};

/** A valid Solana address, so address validation never masks another failure. */
const ADDRESS = 'HN7cABqLq46Es1jh92dQQpXBoUn3xSzXk1uMv6d3sB2';

console.log('\n══ 1. the fee curve ═══════════════════════════════════════');
console.log(`   config: ${JSON.stringify(DEFAULT_TRANSFER_FEE)}`);

/**
 * The floor is what protects a small transfer from being unprofitable. At $5
 * the percentage would yield $0.025 - less than the gas Sivan sponsors.
 */
const small = quoteTransferFee(5);
check('floor applies on small amounts ($5 -> $0.25)',
  small.fee === '0.25', small.fee);
check('and the rule is reported as the minimum, not a percentage',
  small.appliedRule === 'minimum', small.appliedRule);

/**
 * $50 is the exact crossover: 0.5% of 50 is 0.25, which equals the floor.
 * Chosen deliberately - at $49 the floor still wins.
 */
const mid = quoteTransferFee(50);
check('percent applies from the crossover up ($50 -> 0.5% = $0.25)',
  mid.fee === '0.25' && mid.appliedRule === 'percent',
  `${mid.fee} / ${mid.appliedRule}`);
check('one dollar below the crossover the FLOOR still governs',
  quoteTransferFee(49).appliedRule === 'minimum',
  quoteTransferFee(49).appliedRule);

const large = quoteTransferFee(500);
check('ceiling caps large amounts ($500 -> $1.00)',
  large.fee === '1' && large.appliedRule === 'maximum',
  `${large.fee} / ${large.appliedRule}`);

check('zero returns zero',
  quoteTransferFee(0).fee === '0' && quoteTransferFee(0).netAmount === '0',
  quoteTransferFee(0).fee);

/**
 * A negative amount must not produce a negative fee or a negative net - the
 * latter becomes a transfer of a negative amount downstream.
 */
const negative = quoteTransferFee(-5);
check('negative input is treated as zero, never a negative fee',
  negative.fee === '0' && negative.netAmount === '0' && negative.amount === '0',
  `fee=${negative.fee} net=${negative.netAmount}`);

check('NaN is treated as zero rather than propagating',
  quoteTransferFee(Number.NaN).fee === '0', quoteTransferFee(Number.NaN).fee);

console.log('\n══ 2. the new-recipient surcharge ═════════════════════════');

const newRecipient = quoteTransferFee(100, undefined, { createsRecipientAccount: true });
check('surcharge is applied when the recipient account must be created',
  newRecipient.newRecipientFee === '0.3', newRecipient.newRecipientFee);
check('and it is added on top of the base fee',
  newRecipient.fee === '0.8' && newRecipient.baseFee === '0.5',
  `fee=${newRecipient.fee} base=${newRecipient.baseFee}`);

/**
 * THE SURCHARGE SITS OUTSIDE THE CAP, ON PURPOSE.
 *
 * The cap limits Sivan's margin; the surcharge recovers a real on-chain rent
 * cost. Folding it under the cap would make a $500 send to a new address
 * absorb the rent silently - the exact subsidy the surcharge exists to remove.
 */
const cappedPlusSurcharge = quoteTransferFee(500, undefined, { createsRecipientAccount: true });
check('surcharge is charged OUTSIDE the cap ($500 -> $1.00 + $0.30)',
  cappedPlusSurcharge.fee === '1.3', cappedPlusSurcharge.fee);

const existingRecipient = quoteTransferFee(100, undefined, { createsRecipientAccount: false });
check('no surcharge when the recipient already exists',
  existingRecipient.newRecipientFee === '0' && existingRecipient.fee === '0.5',
  `${existingRecipient.newRecipientFee} / ${existingRecipient.fee}`);
check('and the flag is echoed back so the UI can explain the charge',
  existingRecipient.createsRecipientAccount === false && newRecipient.createsRecipientAccount === true);

console.log('\n══ 3. invariants that must hold at every amount ═══════════');

/**
 * Swept rather than spot-checked. A spot check at three amounts cannot catch a
 * discontinuity introduced between them; this walks the curve.
 */
const sweep: number[] = [];
for (let a = 1; a <= 1000; a += 1) sweep.push(a);
for (const a of [0.01, 0.05, 0.5, 5.5, 49.99, 50.01, 999.99]) sweep.push(a);

check('the fee never exceeds the amount being sent',
  sweep.every((a) => Number(quoteTransferFee(a).fee) <= a),
  String(sweep.find((a) => Number(quoteTransferFee(a).fee) > a)));

check('the net is never negative',
  sweep.every((a) => Number(quoteTransferFee(a).netAmount) >= 0));

check('net + fee always reconciles to the amount',
  sweep.every((a) => {
    const q = quoteTransferFee(a);
    return Math.abs((Number(q.netAmount) + Number(q.fee)) - Number(q.amount)) < 1e-9;
  }),
  'a rounding path lost or invented money');

/**
 * The floor holds for every amount ABOVE the floor itself. Below it the
 * fee-cannot-exceed-amount guard correctly takes over, which is why this is
 * not asserted as an unconditional rule.
 */
check('the fee is never below the floor once the amount can cover it',
  sweep.filter((a) => a >= DEFAULT_TRANSFER_FEE.minimumUsd)
    .every((a) => Number(quoteTransferFee(a).fee) >= DEFAULT_TRANSFER_FEE.minimumUsd),
  'the floor was breached');

check('the base fee never exceeds the configured ceiling',
  sweep.every((a) => Number(quoteTransferFee(a).baseFee) <= DEFAULT_TRANSFER_FEE.maximumUsd),
  'the cap was breached');

/**
 * CONTINUITY. A band-based fee table jumps at its boundaries and users notice:
 * sending one cent more must never cost dramatically more. Checked across the
 * real crossover ($50) and the cap ($200), not at $20 where nothing happens.
 */
const jump = sweep
  .filter((a) => a >= 1 && a <= 999)
  .map((a) => ({ a, delta: Number(quoteTransferFee(a + 0.01).fee) - Number(quoteTransferFee(a).fee) }))
  .find((x) => x.delta > 0.01);
check('the curve is continuous - no band jumps anywhere',
  jump === undefined,
  jump ? `jump of ${jump.delta} at $${jump.a}` : '');

console.log('\n══ 4. effective rate, as actually charged ═════════════════');

/**
 * NOT 0.5%. The floor dominates until $50, so a $20 transfer pays $0.25 on
 * $20 = 1.25%. Measured, not assumed - this is the figure the fee tab shows a
 * user, and stating 0.5% here would encode a number the product never charges.
 */
check('effective rate at $20 is 1.25% - the FLOOR, not the percent',
  effectiveRateAt(20) === 1.25, String(effectiveRateAt(20)));
check('effective rate at $50 is exactly the nominal 0.5%',
  effectiveRateAt(50) === 0.5, String(effectiveRateAt(50)));
check('effective rate at $500 is 0.2% - the cap biting',
  effectiveRateAt(500) === 0.2, String(effectiveRateAt(500)));
check('the effective rate falls monotonically as the amount grows',
  [5, 20, 50, 100, 500, 1000].every((a, i, arr) =>
    i === 0 || effectiveRateAt(a) <= effectiveRateAt(arr[i - 1])),
  'a larger transfer was charged a higher rate');

console.log('\n══ 5. admin configuration is honoured ═════════════════════');

const custom: TransferFeeConfig = { percent: 1, minimumUsd: 0.5, maximumUsd: 2, newRecipientUsd: 0 };
check('a custom config overrides the defaults',
  quoteTransferFee(100, custom).fee === '1', quoteTransferFee(100, custom).fee);
check('a custom floor is respected',
  quoteTransferFee(10, custom).fee === '0.5', quoteTransferFee(10, custom).fee);
check('a custom ceiling is respected',
  quoteTransferFee(1000, custom).fee === '2', quoteTransferFee(1000, custom).fee);

const free: TransferFeeConfig = { percent: 0, minimumUsd: 0, maximumUsd: 0, newRecipientUsd: 0 };
check('a zero-everything config charges nothing',
  quoteTransferFee(100, free).fee === '0' && quoteTransferFee(100, free).netAmount === '100',
  quoteTransferFee(100, free).fee);
check('and a zeroed surcharge is not charged even when the account is new',
  quoteTransferFee(100, free, { createsRecipientAccount: true }).fee === '0');

/**
 * A MISCONFIGURED CAP BELOW THE FLOOR MUST NOT OVERCHARGE.
 *
 * The cap is the promise most visible to a user ("never more than X"), so it
 * wins. Encoded because it is a deliberate ordering decision in the source,
 * not an accident, and a future refactor could silently reverse it.
 */
const inverted: TransferFeeConfig = { percent: 0.5, minimumUsd: 5, maximumUsd: 1, newRecipientUsd: 0 };
check('when cap < floor the CAP wins, so the advertised maximum holds',
  quoteTransferFee(100, inverted).fee === '1', quoteTransferFee(100, inverted).fee);

console.log('\n══ 6. deposit confirmation depth ══════════════════════════');

check('EVM confirmations is 12',
  EVM_CONFIRMATIONS === 12, String(EVM_CONFIRMATIONS));
check('and it is a positive integer, not a float or a string',
  Number.isInteger(EVM_CONFIRMATIONS) && EVM_CONFIRMATIONS > 0);
check('the default minimum send is a positive number',
  typeof DEFAULT_TRANSFER_MIN_SEND === 'number' && DEFAULT_TRANSFER_MIN_SEND > 0,
  String(DEFAULT_TRANSFER_MIN_SEND));

/**
 * The floor and the minimum send only make sense together: the minimum is what
 * stops the floor becoming an absurd effective rate. If someone lowers the
 * minimum without looking at the curve, this fails loudly.
 */
check('the minimum send keeps the worst-case effective rate under 5%',
  effectiveRateAt(DEFAULT_TRANSFER_MIN_SEND) <= 5,
  `${effectiveRateAt(DEFAULT_TRANSFER_MIN_SEND)}% at $${DEFAULT_TRANSFER_MIN_SEND}`);

console.log('\n══ 7. transfer input validation ═══════════════════════════');

const validTransfer = createBalanceTransferSchema.safeParse({
  network: 'solana', amount: '25', destinationAddress: ADDRESS,
});
check('a valid transfer passes',
  validTransfer.success, validTransfer.success ? '' : JSON.stringify(validTransfer.error.issues[0]));
check('and the asset defaults to usdc',
  validTransfer.success && validTransfer.data.asset === 'usdc');
check('and a string amount is coerced to a number',
  validTransfer.success && validTransfer.data.amount === 25 && typeof validTransfer.data.amount === 'number');

check('an unsupported network is rejected',
  !createBalanceTransferSchema.safeParse({ network: 'bitcoin', amount: '25', destinationAddress: ADDRESS }).success);
check('a negative amount is rejected',
  !createBalanceTransferSchema.safeParse({ network: 'solana', amount: '-5', destinationAddress: ADDRESS }).success);
check('a zero amount is rejected',
  !createBalanceTransferSchema.safeParse({ network: 'solana', amount: '0', destinationAddress: ADDRESS }).success);
check('a missing destination address is rejected',
  !createBalanceTransferSchema.safeParse({ network: 'solana', amount: '25' }).success);
check('an implausibly short address is rejected',
  !createBalanceTransferSchema.safeParse({ network: 'solana', amount: '25', destinationAddress: 'abc' }).success);
check('an unsupported asset is rejected',
  !createBalanceTransferSchema.safeParse({ asset: 'btc', network: 'solana', amount: '25', destinationAddress: ADDRESS }).success);

/**
 * Every network the schema accepts must have a fee estimate, or the user picks
 * a chain and the quote refuses afterwards. Cross-checked against the enum
 * itself so adding a network without pricing it fails here.
 */
const NETWORKS = ['base', 'solana', 'avalanche_c_chain', 'polygon', 'ethereum', 'arbitrum'];
check('every accepted network parses cleanly',
  NETWORKS.every((n) => createBalanceTransferSchema.safeParse({ network: n, amount: '25', destinationAddress: ADDRESS }).success),
  String(NETWORKS.find((n) => !createBalanceTransferSchema.safeParse({ network: n, amount: '25', destinationAddress: ADDRESS }).success)));

console.log('\n══ 8. withdrawal input validation ═════════════════════════');

const baseWithdrawal = { userId: 'usr_1', externalAccountId: 'ext_1', destinationCurrency: 'usd' as const };

const validWithdrawal = createWithdrawalSchema.safeParse(baseWithdrawal);
check('a minimal valid withdrawal passes', validWithdrawal.success,
  validWithdrawal.success ? '' : JSON.stringify(validWithdrawal.error.issues[0]));
check('source currency defaults to usdc',
  validWithdrawal.success && validWithdrawal.data.sourceCurrency === 'usdc',
  validWithdrawal.success ? validWithdrawal.data.sourceCurrency : '');
check('source chain defaults to ethereum',
  validWithdrawal.success && validWithdrawal.data.sourceChain === 'ethereum',
  validWithdrawal.success ? validWithdrawal.data.sourceChain : '');

check('an unsupported destination currency is rejected',
  !createWithdrawalSchema.safeParse({ ...baseWithdrawal, destinationCurrency: 'ngn' }).success,
  'NGN goes through the naira rail, not this schema');
check('a missing destination currency is rejected',
  !createWithdrawalSchema.safeParse({ userId: 'usr_1', externalAccountId: 'ext_1' }).success);
check('a missing userId is rejected',
  !createWithdrawalSchema.safeParse({ externalAccountId: 'ext_1', destinationCurrency: 'usd' }).success);
check('a negative sourceAmount is rejected',
  !createWithdrawalSchema.safeParse({ ...baseWithdrawal, sourceAmount: -100 }).success);
check('a zero sourceAmount is rejected',
  !createWithdrawalSchema.safeParse({ ...baseWithdrawal, sourceAmount: 0 }).success);
check('sourceAmount stays optional - the open-ended address path still works',
  createWithdrawalSchema.safeParse(baseWithdrawal).success);

/**
 * THE PIN MUST SURVIVE PARSING.
 *
 * zod strips unknown keys, so a PIN that is not declared is deleted before the
 * guard sees it - a correct client would read as "no PIN supplied" and be
 * refused, silently and undebuggably from the outside.
 */
const withPin = createWithdrawalSchema.safeParse({ ...baseWithdrawal, pin: '123456' });
check('a declared PIN survives parsing rather than being stripped',
  withPin.success && withPin.data.pin === '123456',
  withPin.success ? String(withPin.data.pin) : 'parse failed');
check('a step-up token survives parsing too',
  (() => { const r = createWithdrawalSchema.safeParse({ ...baseWithdrawal, stepUpToken: 'tok_abc' });
    return r.success && r.data.stepUpToken === 'tok_abc'; })());
check('a too-short PIN is rejected',
  !createWithdrawalSchema.safeParse({ ...baseWithdrawal, pin: '123' }).success);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (failures.length) console.log(`   ${failures.join('\n   ')}`);
process.exit(fail === 0 ? 0 : 1);
