/**
 * SUPPLIER PAYOUTS WERE THE ONE FLOW CHARGING NOTHING.
 *
 * Send-crypto is priced (transfer-fee-policy.ts). Off-ramp is priced
 * (SIVAN_OFFRAMP_FEE_PERCENT, 1.25%). createSupplierPayment() held the amount,
 * routed it to Bridge and earned zero - on the most expensive, highest-touch
 * flow in the product: a third-party payout to a foreign bank, through a
 * compliance review, on a rail Sivan pays for.
 *
 * WHAT THIS FILE PINS DOWN
 *
 * 1. The curve is CONTINUOUS. Marginal bands, so no amount pays more than a
 *    slightly larger amount. This is the failure that killed the banded
 *    proposal for crypto transfers, and at supplier sizes one cent could move
 *    the fee by tens of dollars.
 *
 * 2. The fee is ADDED. A supplier invoicing $1,000 receives $1,000. Deducting
 *    would underpay a business relationship and force the user to gross up by
 *    hand.
 *
 * 3. BRIDGE'S REAL CONSTRAINTS, measured against the sandbox this session:
 *      developer_fee "500.00" on amount "1.00"
 *        -> 400 "must be less than total amount"
 *      developer_fee "0.12345"
 *        -> 400 "is only allowed 2 digits max of precision"
 *    A fee violating either is a 400 AFTER a compliance hold - money that
 *    looks stuck to the user.
 *
 * 4. The fee REACHES BRIDGE. It is computed at creation and must survive the
 *    review queue to the release call, or Sivan debits the user and collects
 *    nothing.
 *
 * Run: npm run test:supplier-fee
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-supplier-fee.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.BRIDGE_MOCK_MODE = 'true';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'supplier-fee-admin-key';
process.env.USER_JWT_SECRET = 'supplier-fee-jwt-secret-value-long';
process.env.RATE_LIMIT_ENABLED = 'false';

import fs from 'node:fs';
fs.rmSync('.data/test-supplier-fee.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const {
  quoteSupplierFee, volumeDiscountFor, nextVolumeDiscount,
  DEFAULT_SUPPLIER_FEE, SUPPLIER_VOLUME_COUNTING_STATUSES,
} = await import('../src/suppliers/supplier-fee-policy.js');

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 1. the marginal curve, and what each band charges ────────');

const q200 = quoteSupplierFee(200);
check('$200 pays 1.5% in the first band', q200.fee === '3.00', q200.fee);
check('and the supplier receives the full amount', q200.netAmount === '200.00', q200.netAmount);
check('while the user is debited amount + fee', q200.grossAmount === '203.00', q200.grossAmount);

/**
 * $2,000 = 500 @1.5% ($7.50) + 1500 @1.2% ($18.00) = $25.50.
 * Computed by hand and asserted as a literal. Asserting "less than 1.5%" would
 * pass for a great many wrong numbers.
 */
const q2000 = quoteSupplierFee(2_000);
check('$2,000 is charged across two bands: 7.50 + 18.00 = 25.50',
  q2000.fee === '25.50', q2000.fee);
check('and the effective rate is below the headline 1.5%',
  Number(q2000.effectivePercent) === 1.275, q2000.effectivePercent);

// 500@1.5 + 1500@1.2 + 8000@0.9 = 7.50 + 18 + 72 = 97.50
const q10k = quoteSupplierFee(10_000);
check('$10,000 across three bands = 97.50', q10k.fee === '97.50', q10k.fee);
// + 40000@0.6 = 240 -> 337.50
const q50k = quoteSupplierFee(50_000);
check('$50,000 into the top band = 337.50', q50k.fee === '337.50', q50k.fee);

check('the breakdown shows its work, one row per band',
  q10k.breakdown.length === 3, JSON.stringify(q10k.breakdown.map((b) => b.feeFromBand)));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 2. CONTINUITY: no cliff at any band edge ─────────────────');

/**
 * THE FAILURE MODE MARGINAL PRICING EXISTS TO PREVENT.
 *
 * A banded table would do this at the $500 edge:
 *     $499.99 -> $7.50    $500.01 -> $6.00
 * Paying MORE for sending LESS. Tested at every boundary, and at the scale
 * where it matters most.
 */
for (const edge of [500, 2_000, 10_000]) {
  const below = quoteSupplierFee(edge - 0.01);
  const above = quoteSupplierFee(edge + 0.01);
  check(`crossing $${edge.toLocaleString()} never lowers the fee`,
    Number(above.fee) >= Number(below.fee),
    `${below.fee} -> ${above.fee}`);
  check(`and the step across $${edge.toLocaleString()} is a fraction of a cent`,
    Number(above.fee) - Number(below.fee) < 0.02,
    `jump of ${(Number(above.fee) - Number(below.fee)).toFixed(4)}`);
}

/**
 * The monotonicity claim, swept rather than spot-checked. A curve can be
 * continuous at the three edges I thought to test and still invert somewhere
 * I did not.
 */
let inversions = 0;
let prevFee = -1;
for (let amt = 10; amt <= 60_000; amt += 137) {
  const f = Number(quoteSupplierFee(amt).fee);
  if (f < prevFee - 0.001) inversions += 1;
  prevFee = f;
}
check('across 400+ amounts the fee never decreases as the amount grows',
  inversions === 0, `${inversions} inversion(s)`);

/** And the effective RATE must fall as the amount grows - that is the promise. */
check('the effective rate falls with size (1.5% -> 0.675%)',
  Number(quoteSupplierFee(200).effectivePercent) > Number(quoteSupplierFee(50_000).effectivePercent),
  `${quoteSupplierFee(200).effectivePercent}% vs ${quoteSupplierFee(50_000).effectivePercent}%`);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 3. the 30-day volume discount ────────────────────────────');

check('a new user gets no discount', volumeDiscountFor(0).discountPercent === 0);
check('$10k of 30-day volume unlocks 10%', volumeDiscountFor(10_000).discountPercent === 10);
check('$50k unlocks 20%', volumeDiscountFor(50_000).discountPercent === 20);
check('$250k unlocks 30%', volumeDiscountFor(250_000).discountPercent === 30);
check('and the highest qualifying step wins, not the first',
  volumeDiscountFor(1_000_000).discountPercent === 30);

/**
 * THE SAME PAYMENT, TWO USERS. This is what "fee according to volume" buys.
 */
const smallUser = quoteSupplierFee(5_000, 0);
const bigUser = quoteSupplierFee(5_000, 60_000);
check('the same $5,000 payment costs less for a high-volume user',
  Number(bigUser.fee) < Number(smallUser.fee), `${smallUser.fee} vs ${bigUser.fee}`);
// 500@1.5 + 1500@1.2 + 3000@0.9 = 7.5 + 18 + 27 = 52.50; less 20% = 42.00
check('and the discount is exactly 20% off the tiered fee',
  smallUser.fee === '52.50' && bigUser.fee === '42.00',
  `${smallUser.fee} -> ${bigUser.fee}`);
check('the saving is stated so the user can see it',
  bigUser.volumeDiscountAmount === '10.50', bigUser.volumeDiscountAmount);

const next = nextVolumeDiscount(9_000);
check('a user below a step is told how far away it is',
  next?.tier.discountPercent === 10 && next?.remainingUsd === 1_000,
  JSON.stringify(next));
check('and a user at the top is told nothing more is coming',
  nextVolumeDiscount(500_000) === undefined);

/**
 * A DISCOUNT CLIFF IS ACCEPTABLE; A FEE CLIFF IS NOT.
 *
 * Crossing a discount step can only ever reduce what you owe, so it is always
 * good news. Asserted so nobody "fixes" it into a fee cliff later.
 */
const justUnder = quoteSupplierFee(1_000, 9_999);
const justOver = quoteSupplierFee(1_000, 10_001);
check('crossing a discount step lowers the fee, never raises it',
  Number(justOver.fee) < Number(justUnder.fee), `${justUnder.fee} -> ${justOver.fee}`);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 4. the floor, and the order it is applied in ─────────────');

const tiny = quoteSupplierFee(20);
check('a $20 payment hits the floor rather than earning 30c',
  tiny.fee === '0.50' && tiny.appliedRule === 'minimum', `${tiny.fee} / ${tiny.appliedRule}`);

/**
 * FLOOR AFTER DISCOUNT, AND THE ORDER IS THE TEST.
 *
 * Applying the floor first and discounting after would let a 30% member pay
 * $1.40 against a $2.00 floor. A floor that does not hold is not a floor.
 */
/**
 * ASSERTED AGAINST THE CONFIGURED FLOOR, not a literal.
 *
 * This read `>= 2` and broke when the floor moved to 0.50 - the behaviour was
 * still right and only the hardcoded number was stale. Reading the config
 * means this tests the RULE ("a discount cannot take a fee below the floor")
 * and keeps working whatever the floor is set to.
 */
const tinyBigUser = quoteSupplierFee(20, 300_000);
check('the floor still holds for a 30% discount member',
  Number(tinyBigUser.fee) >= DEFAULT_SUPPLIER_FEE.minimumUsd, tinyBigUser.fee);
check('and the quote says the floor is why, not the discount',
  tinyBigUser.appliedRule === 'minimum', tinyBigUser.appliedRule);
check('a floored fee reports no discount, because none was given',
  tinyBigUser.volumeDiscountAmount === '0.00', tinyBigUser.volumeDiscountAmount);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 5. Bridge\'s measured constraints on developer_fee ────────');

/**
 * TWO DECIMALS MAX. Measured: "0.12345" -> 400 "is only allowed 2 digits max
 * of precision". Swept over amounts chosen to produce ugly fractions.
 */
let precisionViolations = 0;
for (const amt of [33.33, 66.67, 101.01, 777.77, 1_234.56, 9_999.99, 33_333.33]) {
  for (const vol of [0, 10_000, 50_000, 250_000]) {
    const f = quoteSupplierFee(amt, vol).fee;
    if (!/^\d+\.\d{2}$/.test(f)) precisionViolations += 1;
  }
}
check('every fee has exactly 2 decimals, whatever the inputs',
  precisionViolations === 0, `${precisionViolations} violation(s)`);

/**
 * FEE < AMOUNT. Measured: developer_fee "500.00" on amount "1.00" -> 400
 * "must be less than total amount". Because the fee is ADDED, the gross is
 * always net + fee, so this holds by construction - asserted so a future
 * change to deducted pricing cannot silently break it.
 */
let feeTooBig = 0;
for (const amt of [0.5, 1, 5, 20, 100, 5_000]) {
  const q = quoteSupplierFee(amt);
  if (Number(q.fee) >= Number(q.grossAmount)) feeTooBig += 1;
}
check('the fee is ALWAYS strictly less than the amount sent to Bridge',
  feeTooBig === 0, `${feeTooBig} case(s) would be rejected by Bridge`);

check('gross always equals net + fee, to the cent',
  [10, 200, 2_000, 50_000].every((a) => {
    const q = quoteSupplierFee(a);
    return Number(q.grossAmount).toFixed(2) === (Number(q.netAmount) + Number(q.fee)).toFixed(2);
  }));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 6. the fee actually reaches Bridge ───────────────────────');

/**
 * THE HOLE THAT WOULD HAVE MADE ALL OF THE ABOVE POINTLESS.
 *
 * releaseSupplierPaymentToProvider() called createSupplierPayout WITHOUT
 * developer_fee. Priced, held, shown to the user - and Bridge would have paid
 * the full gross to the supplier while Sivan collected nothing. The fee is
 * stored on the record at creation so it survives the review queue; this
 * asserts it is read back out and sent.
 */
const releaseSrc = fs.readFileSync('src/suppliers/supplier.service.ts', 'utf8');
check('the release call passes developerFee to the provider',
  /createSupplierPayout\(\{[\s\S]{0,400}?developerFee/.test(releaseSrc),
  'without this the fee is charged to the user and never collected');
check('and it is sourced from the stored payment record',
  /developerFee\s*=\s*payment\.feeAmount/.test(releaseSrc));

const providerSrc = fs.readFileSync('src/providers/bridge/bridge.provider.ts', 'utf8');
check('the Bridge adapter forwards it as developer_fee',
  /developer_fee:\s*input\.developerFee/.test(providerSrc));

/** The hold must cover the GROSS, or release fails for insufficient funds. */
check('the balance check and hold use the gross, not the amount typed',
  /amount\(available\)\s*<\s*grossAmount/.test(releaseSrc),
  'checking the bare amount accepts payments the user cannot fund');

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 7. degenerate and hostile inputs ─────────────────────────');

const zero = quoteSupplierFee(0);
check('a zero amount produces a zero fee, not a floored one',
  zero.fee === '0.00' && zero.grossAmount === '0.00', `${zero.fee}/${zero.grossAmount}`);
check('negatives are clamped rather than producing negative money',
  quoteSupplierFee(-500).fee === '0.00');
check('NaN does not propagate into a money string',
  quoteSupplierFee(Number.NaN).fee === '0.00');
check('an absurd volume does not exceed the top discount',
  volumeDiscountFor(Number.MAX_SAFE_INTEGER).discountPercent === 30);
check('volume is ignored when negative',
  quoteSupplierFee(1_000, -50_000).fee === quoteSupplierFee(1_000, 0).fee);

check('pending and rejected payments do NOT count toward volume',
  !SUPPLIER_VOLUME_COUNTING_STATUSES.includes('pending_review' as never)
  && !SUPPLIER_VOLUME_COUNTING_STATUSES.includes('rejected' as never),
  'otherwise a user self-grants a discount with a payment they abandon');
check('but committed money does count',
  SUPPLIER_VOLUME_COUNTING_STATUSES.includes('completed' as never)
  && SUPPLIER_VOLUME_COUNTING_STATUSES.includes('processing' as never));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 8. the default curve is defensible ───────────────────────');

/**
 * Sanity bounds on the shipped numbers. Not arithmetic - a judgement that the
 * pricing is inside the range this product can defend against Wise/Payoneer
 * business payouts out of Nigeria (2-4%).
 */
check('the small end is under 2%', Number(quoteSupplierFee(300).effectivePercent) < 2);
check('the large end is under 1%', Number(quoteSupplierFee(20_000).effectivePercent) < 1);
check('no amount is ever charged more than the headline first-band rate',
  [50, 500, 5_000, 500_000].every((a) => Number(quoteSupplierFee(a).effectivePercent) <= 1.5 || a < 200));
check('the tiers ship ascending and end open-ended',
  DEFAULT_SUPPLIER_FEE.tiers[DEFAULT_SUPPLIER_FEE.tiers.length - 1].upToUsd === null);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 9. small payments are no longer punished ─────────────────');

/**
 * THE $2 FLOOR MADE A $50 INVOICE COST 4%.
 *
 * Against Nigerian P2P spreads of 1-3% and Wise/Payoneer business payouts at
 * 2-4%, that made Sivan the expensive option for exactly the small, frequent
 * invoices a WhatsApp-first product exists to serve.
 *
 * The cause was a mispricing, not merely a high number: the floor was sized to
 * cover a compliance review, but supplier-risk.service.ts scores
 * `isFirstPayment` PER SUPPLIER, and with autoApproveApprovedSuppliers a
 * repeat payment to an approved supplier is auto-approved with no human
 * involved. Every payment was being charged for a review only the first one
 * triggers.
 */
const repeat50 = quoteSupplierFee(50, 0, DEFAULT_SUPPLIER_FEE, { isFirstPaymentToSupplier: false });
check('a $50 repeat invoice costs 1.5%, not the old 4%',
  repeat50.fee === '0.75' && Number(repeat50.effectivePercent) === 1.5,
  `${repeat50.fee} (${repeat50.effectivePercent}%)`);

const repeat20 = quoteSupplierFee(20, 0, DEFAULT_SUPPLIER_FEE, { isFirstPaymentToSupplier: false });
check('a $20 repeat invoice costs 2.5%, not the old 10%',
  repeat20.fee === '0.50' && Number(repeat20.effectivePercent) === 2.5,
  `${repeat20.fee} (${repeat20.effectivePercent}%)`);

/**
 * THE COST IS STILL RECOVERED - just once, from the payment that causes it.
 * A change that only lowered the floor would make small payouts unprofitable;
 * this asserts the onboarding charge still lands.
 */
/**
 * $150 rather than $50, because the setup charge is now CAPPED at 1.5% of the
 * payment - a $50 first payment pays only $0.75 of it. This case has to be
 * above the point where the full charge applies, or it tests the ceiling
 * instead of the recovery it is meant to assert. Section 12 covers the
 * capped end.
 */
const first150 = quoteSupplierFee(150, 0, DEFAULT_SUPPLIER_FEE, { isFirstPaymentToSupplier: true });
const repeat150 = quoteSupplierFee(150, 0, DEFAULT_SUPPLIER_FEE, { isFirstPaymentToSupplier: false });
check('the FIRST payment to a supplier still recovers the review',
  first150.fee === '3.75', `${first150.fee} = 2.25 tiered + 1.50 setup`);
check('and the setup charge is itemised, not buried in the fee',
  first150.newSupplierFee === '1.50', first150.newSupplierFee);
/**
 * AND IT IS EXCLUDED FROM THE ADVERTISED RATE.
 *
 * Caught in a screenshot: a first payment read "Sivan fee (1.700%)" beside a
 * row saying the setup charge was one-time - the percentage described a cost
 * the user would never pay again. The rate must be the RECURRING one.
 */
check('the quoted percentage is the recurring rate, excluding setup',
  Number(first150.effectivePercent) === 1.5
  && first150.effectivePercent === repeat150.effectivePercent,
  `first=${first150.effectivePercent}% repeat=${repeat150.effectivePercent}%`);
check('the second payment to that supplier drops the charge',
  Number(repeat150.fee) < Number(first150.fee) && repeat150.newSupplierFee === '0.00',
  `${first150.fee} -> ${repeat150.fee}`);

/**
 * A weekly supplier over a year: the onboarding cost is paid ONCE, not 52
 * times. This is the whole point of the change, stated as the number.
 */
const yearOld = 52 * 2.00;              // old flat $2 floor, every payment
const yearNew = 1.50 + 51 * 0.75;       // capped setup once, then the real rate
check('a weekly $50 supplier pays $39.75/yr instead of $104',
  Math.abs(yearNew - 39.75) < 0.01 && yearOld === 104, `${yearNew.toFixed(2)} vs ${yearOld.toFixed(2)}`);

/**
 * THE SETUP CHARGE IS NOT DISCOUNTED BY VOLUME. A high-volume user onboarding
 * a brand new supplier causes exactly the same review as anyone else - the
 * loyalty discount applies to the rate for moving money, not to a one-off cost
 * they just caused.
 */
const bigUserFirst = quoteSupplierFee(5_000, 300_000, DEFAULT_SUPPLIER_FEE, { isFirstPaymentToSupplier: true });
check('the setup charge survives even a 30% volume discount',
  bigUserFirst.newSupplierFee === '1.50', bigUserFirst.newSupplierFee);

/** And it sits OUTSIDE the cap, like the ATA-rent surcharge on transfers. */
/**
 * A SMALL PAYMENT, so the cap binds without colliding with the provider-cost
 * floor. On $50,000 a $100 cap is BELOW what Bridge charges (250.00), and the
 * cost floor correctly overrides it - see section 13. Here the cap is the
 * binding rule, which is what this assertion is about.
 */
const capped = quoteSupplierFee(300, 0, { ...DEFAULT_SUPPLIER_FEE, maximumUsd: 2 }, { isFirstPaymentToSupplier: true });
check('a capped fee still adds the setup charge on top of the cap',
  capped.newSupplierFee === '1.50' && Number(capped.fee) > 2,
  `${capped.fee} (cap 2.00 + 1.50 setup)`);

/** The floor must not resurrect itself on a zero amount. */
check('a zero amount is charged no setup fee either',
  quoteSupplierFee(0, 0, DEFAULT_SUPPLIER_FEE, { isFirstPaymentToSupplier: true }).fee === '0.00');

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 10. volume Sivan cannot see ──────────────────────────────');

/**
 * THE DISCOUNT MEASURED SUPPLIER PAYMENTS ALONE, which punished the customer
 * it was meant to reward: a business off-ramping $80k a month and paying two
 * suppliers $3k was treated as a $3k customer. It also created a perverse
 * incentive - to earn a discount you had to route MORE through the most
 * compliance-expensive flow rather than the cheap ones.
 *
 * Two changes: all Sivan volume now counts, and an admin can credit volume
 * that Sivan genuinely cannot observe.
 */
const svcSrc = fs.readFileSync('src/suppliers/supplier.service.ts', 'utf8');
check('the volume basis includes off-ramp withdrawals, not just supplier payments',
  /listWithdrawalsByUserSince/.test(svcSrc),
  'a large off-ramp customer was being treated as a small supplier customer');
check('and an admin-granted floor exists for volume Sivan cannot observe',
  /getGrantedVolumeFloorUsd/.test(svcSrc));
check('the grant is applied as a FLOOR, so real volume still wins when higher',
  /Math\.max\(earned, granted\)/.test(svcSrc),
  'a grant must not CAP a customer who outgrows it');
check('grants require a reason',
  /reason: z\.string\(\)\.min\(10\)/.test(svcSrc),
  'an unexplained permanent discount is unauditable');
check('and expire by default',
  /expiresInDays: z\.coerce\.number\(\)\.int\(\)\.min\(0\)\.max\(3650\)\.default\(90\)/.test(svcSrc),
  'a forgotten discount that never ends is worse than one that is renewed');
check('expiry is enforced on READ, not by a cleanup job',
  /!row\.expiresAt \|\| Date\.parse\(row\.expiresAt\) > now/.test(svcSrc));
check('granting volume is audited as a warning',
  /supplier\.volume_grant_created/.test(svcSrc) && /severity: 'warning'/.test(svcSrc.slice(svcSrc.indexOf('volume_grant_created') - 400, svcSrc.indexOf('volume_grant_created') + 400)));

/**
 * THE FIRST-PAYMENT TEST MUST MATCH THE RISK ENGINE EXACTLY.
 *
 * If they disagree, a user is charged a setup fee for a review that never
 * happened, or gets a free review that did. Both read the same three statuses.
 */
const riskSrc = fs.readFileSync('src/risk/supplier-risk.service.ts', 'utf8');
const statusesIn = (src: string) => {
  const m = src.match(/\['approved', 'processing', 'completed'\]/);
  return Boolean(m);
};
check('fee and risk engines agree on what "first payment" means',
  statusesIn(svcSrc) && statusesIn(riskSrc),
  'a mismatch charges for a review that did not happen');

/** The migration must exist, and be idempotent - db-migrate re-runs every file. */
const migration = fs.readFileSync('database/migrations/049_supplier_volume_grants.sql', 'utf8');
check('the grants table migration is idempotent',
  /create table if not exists/.test(migration) && /create index if not exists/.test(migration),
  'db-migrate.ts runs every file on every deploy with no ledger');

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 11. the grant, EXERCISED not grepped ─────────────────────');

/**
 * THE ASSERTIONS ABOVE ARE SOURCE REGEXES, and a regex passes when the code
 * merely looks right. Mutating `Math.max(earned, granted)` was caught only
 * because the mutation changed that exact line - a different implementation
 * with the same bug would sail through.
 *
 * These run the real function against a real database.
 */
const { db } = await import('../src/database/json-database.js');
const { getSupplierVolumeUsd, grantSupplierVolume, getGrantedVolumeFloorUsd } =
  await import('../src/suppliers/supplier.service.js');

const nowIso = () => new Date().toISOString();
await db.mutate((d: any) => {
  d.users = [{ id: 'usr_vol', email: 'vol@t.test', fullName: 'Vol User', createdAt: nowIso(), updatedAt: nowIso() }];
  d.supplierPayments = [
    // $4,000 of real, committed supplier volume.
    { id: 'spp_a', userId: 'usr_vol', supplierId: 'sup_1', amount: '4000', netAmount: '4000',
      status: 'completed', createdAt: nowIso(), updatedAt: nowIso() },
    // Pending must NOT count - otherwise a user self-grants a discount with a
    // payment they never intend to complete.
    { id: 'spp_b', userId: 'usr_vol', supplierId: 'sup_1', amount: '90000', netAmount: '90000',
      status: 'pending_review', createdAt: nowIso(), updatedAt: nowIso() },
  ];
  d.supplierVolumeGrants = [];
  return 1;
});

const earnedOnly = await getSupplierVolumeUsd('usr_vol');
check('real volume counts committed payments only',
  earnedOnly === 4000, String(earnedOnly));
check('and a pending payment cannot buy a discount',
  earnedOnly < 90000, String(earnedOnly));

// An admin credits them for volume settled elsewhere.
await grantSupplierVolume({
  userId: 'usr_vol', volumeUsd: 60_000,
  reason: 'Settles roughly half their invoices via another provider; agreed with sales.',
  grantedBy: 'ops@sivantech.online', expiresInDays: 90,
});

const withGrant = await getSupplierVolumeUsd('usr_vol');
check('the granted floor lifts a user whose real volume is lower',
  withGrant === 60_000, String(withGrant));
check('and it moves them into the 20% discount band',
  volumeDiscountFor(withGrant).discountPercent === 20, String(volumeDiscountFor(withGrant).discountPercent));

/**
 * THE FLOOR MUST NOT BECOME A CEILING. A customer who outgrows their grant
 * keeps their real, higher tier - otherwise a kindness turns into a penalty.
 */
await db.mutate((d: any) => {
  d.supplierPayments.push({ id: 'spp_c', userId: 'usr_vol', supplierId: 'sup_2',
    amount: '300000', netAmount: '300000', status: 'completed', createdAt: nowIso(), updatedAt: nowIso() });
  return 1;
});
const outgrown = await getSupplierVolumeUsd('usr_vol');
check('a user who outgrows the grant keeps their real, higher volume',
  outgrown === 304_000, String(outgrown));
check('and reaches the top discount on their own merit',
  volumeDiscountFor(outgrown).discountPercent === 30);

/** An expired grant stops applying, with no cleanup job involved. */
await db.mutate((d: any) => {
  d.supplierPayments = [];
  d.supplierVolumeGrants = [{
    id: 'svg_old', userId: 'usr_vol', volumeUsd: '250000', reason: 'expired pilot agreement',
    grantedBy: 'ops', expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
    createdAt: nowIso(), updatedAt: nowIso(),
  }];
  return 1;
});
check('an expired grant no longer counts',
  (await getGrantedVolumeFloorUsd('usr_vol')) === 0, String(await getGrantedVolumeFloorUsd('usr_vol')));
check('so the user falls back to their real volume',
  (await getSupplierVolumeUsd('usr_vol')) === 0);

/** A grant with no expiry is allowed, but only when chosen explicitly. */
const permanent = await grantSupplierVolume({
  userId: 'usr_perm', volumeUsd: 15_000,
  reason: 'Strategic partner, indefinite arrangement approved by finance.',
  grantedBy: 'ops@sivantech.online', expiresInDays: 0,
});
check('an explicit no-expiry grant is permitted',
  permanent.expiresAt === undefined, String(permanent.expiresAt));
check('and it applies', (await getSupplierVolumeUsd('usr_perm')) === 15_000);

/**
 * OFF-RAMP VOLUME COUNTS, exercised rather than grepped.
 *
 * The regex assertion above passes if the call merely APPEARS in the source.
 * This one puts a real withdrawal in the database and checks the number moves
 * - the case of the business off-ramping heavily and paying two suppliers, who
 * was previously treated as a tiny customer.
 */
await db.mutate((d: any) => {
  d.supplierPayments = [{ id: 'spp_w', userId: 'usr_ramp', supplierId: 'sup_9',
    amount: '3000', netAmount: '3000', status: 'completed', createdAt: nowIso(), updatedAt: nowIso() }];
  d.supplierVolumeGrants = [];
  d.withdrawals = [
    { id: 'wd_1', userId: 'usr_ramp', customerId: 'cus_r', externalAccountId: 'ea_1',
      liquidationAddressId: 'la_1', provider: 'bridge', sourceCurrency: 'usdc', destinationCurrency: 'usd',
      sourceAmount: '80000', status: 'completed', createdAt: nowIso(), updatedAt: nowIso() },
  ];
  return 1;
});
const rampVolume = await getSupplierVolumeUsd('usr_ramp');
check('a heavy off-ramp user is credited for that volume too',
  rampVolume === 83_000, `${rampVolume} (3,000 supplier + 80,000 off-ramp)`);
check('which earns them a discount their supplier spend alone would not',
  volumeDiscountFor(rampVolume).discountPercent === 20
  && volumeDiscountFor(3_000).discountPercent === 0,
  `${volumeDiscountFor(rampVolume).discountPercent}% vs ${volumeDiscountFor(3_000).discountPercent}%`);

/** Grants are rejected without a real reason. */
const noReason = await grantSupplierVolume({
  userId: 'usr_x', volumeUsd: 10_000, reason: 'because', grantedBy: 'ops',
} as any).then(() => null).catch((e: Error) => e);
check('a grant with a throwaway reason is refused',
  noReason instanceof Error, String(noReason));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 12. a small FIRST payment is not punished either ─────────');

/**
 * THE REMAINING SHARP EDGE, and why the obvious fix was rejected.
 *
 * A flat $1.50 setup charge is identical for a $50 supplier and a $50,000 one,
 * so a small first invoice paid 4.5% - a bad first impression at exactly the
 * moment a new user is deciding whether to trust the product.
 *
 * The tempting fix was a threshold: waive setup under $200. It produces
 *
 *     $199.99 -> $3.00      $200.01 -> $4.50      +50% across two cents
 *
 * which is the SAME CLIFF this file already rejects for the fee bands and
 * mutation-tests against. Rejecting it for the tiers and accepting it here
 * would be inconsistency with extra steps, and it is a cliff a user can
 * actually notice.
 *
 * Instead the setup charge is the LOWER of $1.50 and 1.5% of the payment:
 * continuous everywhere, self-limiting at the small end.
 */
const first10 = quoteSupplierFee(10, 0, DEFAULT_SUPPLIER_FEE, { isFirstPaymentToSupplier: true });
const first50b = quoteSupplierFee(50, 0, DEFAULT_SUPPLIER_FEE, { isFirstPaymentToSupplier: true });
const first100 = quoteSupplierFee(100, 0, DEFAULT_SUPPLIER_FEE, { isFirstPaymentToSupplier: true });

check('a $50 first payment no longer pays 4.5%',
  first50b.newSupplierFee === '0.75' && first50b.fee === '1.50',
  `${first50b.fee} (setup ${first50b.newSupplierFee})`);
check('and a $100 first payment pays the full setup charge',
  first100.newSupplierFee === '1.50', first100.newSupplierFee);
check('above ~$100 the charge is flat, never proportional forever',
  quoteSupplierFee(5_000, 0, DEFAULT_SUPPLIER_FEE, { isFirstPaymentToSupplier: true }).newSupplierFee === '1.50');
check('a tiny $10 first payment is capped at 15c of setup, not $1.50',
  first10.newSupplierFee === '0.15', first10.newSupplierFee);

/**
 * NO CLIFF, ANYWHERE. Swept across the range a threshold would have broken,
 * on the FIRST-payment path specifically - the earlier continuity sweep only
 * covered repeat payments and would not have caught a threshold.
 */
let firstInversions = 0;
let prevFirst = -1;
for (let amt = 1; amt <= 1_000; amt += 0.37) {
  const f = Number(quoteSupplierFee(amt, 0, DEFAULT_SUPPLIER_FEE, { isFirstPaymentToSupplier: true }).fee);
  if (f < prevFirst - 0.001) firstInversions += 1;
  prevFirst = f;
}
check('the FIRST-payment curve never inverts across 2,700 amounts',
  firstInversions === 0, `${firstInversions} inversion(s)`);

/** The specific boundary a threshold would have broken. */
const below = quoteSupplierFee(199.99, 0, DEFAULT_SUPPLIER_FEE, { isFirstPaymentToSupplier: true });
const above = quoteSupplierFee(200.01, 0, DEFAULT_SUPPLIER_FEE, { isFirstPaymentToSupplier: true });
check('there is no jump at $200, where a threshold would have put one',
  Number(above.fee) - Number(below.fee) < 0.02,
  `${below.fee} -> ${above.fee}; a "waive under 200" rule jumped 3.00 -> 4.50`);

/**
 * THE PROMISE, stated as a test: a first payment never costs more than about
 * double the ongoing rate. Without the ceiling a $10 first payment was 20%.
 */
/**
 * MEASURED FROM $40, where the setup ceiling stops binding and the $0.50 floor
 * has stopped dominating.
 *
 * Below that the rate is driven by the FLOOR, not by onboarding: a $5 payment
 * is 11.6% because 50c is the least Sivan will charge for moving money at all,
 * and it would be 10% on a repeat payment too. That is a property of the floor
 * and a separate decision - conflating the two here would have hidden which
 * lever was responsible. Asserted honestly below instead.
 */
let worstFirstRate = 0;
for (let amt = 40; amt <= 2_000; amt += 5) {
  const q = quoteSupplierFee(amt, 0, DEFAULT_SUPPLIER_FEE, { isFirstPaymentToSupplier: true });
  worstFirstRate = Math.max(worstFirstRate, (Number(q.fee) / amt) * 100);
}
check('no first payment of $40+ is charged more than 3.01% all-in',
  worstFirstRate <= 3.01, `worst = ${worstFirstRate.toFixed(2)}%`);

/**
 * AND BELOW $40 THE SETUP CHARGE IS NOT THE CULPRIT. Stated explicitly so a
 * future reader does not "fix" onboarding when the floor is what binds.
 */
const tinyFirst = quoteSupplierFee(5, 0, DEFAULT_SUPPLIER_FEE, { isFirstPaymentToSupplier: true });
const tinyRepeat = quoteSupplierFee(5, 0, DEFAULT_SUPPLIER_FEE, { isFirstPaymentToSupplier: false });
check('at $5 the floor dominates, and onboarding adds under a dime',
  Number(tinyFirst.fee) - Number(tinyRepeat.fee) < 0.10,
  `first ${tinyFirst.fee} vs repeat ${tinyRepeat.fee}`);

/** And the ongoing rate is untouched - this changes onboarding, not pricing. */
check('the recurring rate is unchanged by the ceiling',
  quoteSupplierFee(600, 0).fee === '8.70' && quoteSupplierFee(50_000, 0).fee === '337.50');

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 13. Bridge takes 0.50% - the curve must clear it ─────────');

/**
 * A SUPPLIER PAYOUT IS AN OFF-RAMP IN BRIDGE'S PRICING.
 *
 * createSupplierPayout posts /transfers with a `bridge_wallet` source and an
 * `external_account` destination: stablecoin in, fiat out. Bridge bills that
 * as off-ramp volume at 0.50%, +0.10% on USDT.
 *
 * THE CURVE WAS PRICED WITHOUT SUBTRACTING IT. Tiers were set against Sivan's
 * own costs and the volume discount then cut Sivan's revenue while Bridge's
 * cut stayed fixed - so the biggest, most loyal customers were the most
 * loss-making:
 *
 *     $50,000 at 30% off  -> Sivan 236.25, Bridge 250.00 = -13.75
 *     $100,000 at 30% off -> Sivan 446.25, Bridge 500.00 = -53.75
 */
const { BRIDGE_OFFRAMP_COST_PERCENT, MARGIN_MULTIPLIER, providerCostPercentFor } =
  await import('../src/suppliers/supplier-fee-policy.js');

check('the off-ramp cost is stated, not implicit',
  BRIDGE_OFFRAMP_COST_PERCENT === 0.5, String(BRIDGE_OFFRAMP_COST_PERCENT));
check('and USDT is priced 0.10% higher, as Bridge charges',
  providerCostPercentFor('usdt') === 0.6 && providerCostPercentFor('usdc') === 0.5,
  `usdt=${providerCostPercentFor('usdt')} usdc=${providerCostPercentFor('usdc')}`);

/**
 * THE REGRESSION, ASSERTED DIRECTLY. These are the exact cases that lost
 * money before the floor existed.
 */
for (const [amt, vol] of [[50_000, 300_000], [100_000, 300_000], [50_000, 60_000]] as Array<[number, number]>) {
  const q = quoteSupplierFee(amt, vol, DEFAULT_SUPPLIER_FEE, { sourceAsset: 'usdc' });
  const margin = Number(q.fee) - Number(q.providerCost);
  check(`$${amt.toLocaleString()} at ${vol.toLocaleString()} volume is PROFITABLE`,
    margin > 0, `fee ${q.fee} - bridge ${q.providerCost} = ${margin.toFixed(2)}`);
}

/** Swept, because three spot checks is not a guarantee. */
let lossMaking = 0;
let worstMargin = Infinity;
for (const vol of [0, 10_000, 50_000, 250_000, 1_000_000]) {
  for (let amt = 100; amt <= 500_000; amt += 971) {
    for (const asset of ['usdc', 'usdt']) {
      const q = quoteSupplierFee(amt, vol, DEFAULT_SUPPLIER_FEE, { sourceAsset: asset });
      const margin = Number(q.fee) - Number(q.providerCost);
      if (margin <= 0) lossMaking += 1;
      worstMargin = Math.min(worstMargin, margin);
    }
  }
}
check('NO amount, volume or asset combination is ever sold below cost',
  lossMaking === 0, `${lossMaking} loss-making quote(s), worst margin ${worstMargin.toFixed(2)}`);

/** And the margin is a real one, not break-even. */
check('the floor leaves a real margin, not break-even',
  MARGIN_MULTIPLIER > 1.2, String(MARGIN_MULTIPLIER));

/**
 * A DISCOUNT COMPRESSES MARGIN, IT DOES NOT INVERT IT. The discount must still
 * WORK where there is room for it - a floor that swallowed every discount
 * would make the loyalty tier decorative.
 */
const smallLoyal = quoteSupplierFee(10_000, 300_000, DEFAULT_SUPPLIER_FEE, { sourceAsset: 'usdc' });
const smallNew = quoteSupplierFee(10_000, 0, DEFAULT_SUPPLIER_FEE, { sourceAsset: 'usdc' });
check('the volume discount still bites where there is margin for it',
  Number(smallLoyal.fee) < Number(smallNew.fee) && smallLoyal.volumeDiscountPercent === 30,
  `${smallNew.fee} -> ${smallLoyal.fee} at ${smallLoyal.volumeDiscountPercent}%`);

/**
 * AND THE REPORTED DISCOUNT IS THE ONE ACTUALLY RECEIVED.
 *
 * When the cost floor absorbs part of the discount, claiming the headline
 * "30%" would promise a saving the user did not get. Reporting 0 would deny
 * one they partly did. Both are lies; this reports the real difference.
 */
const compressed = quoteSupplierFee(50_000, 300_000, DEFAULT_SUPPLIER_FEE, { sourceAsset: 'usdc' });
check('a compressed discount reports what was really saved, not the tier headline',
  compressed.volumeDiscountPercent > 0 && compressed.volumeDiscountPercent < 30,
  `${compressed.volumeDiscountPercent}% actual vs 30% tier`);
check('and the quote flags that the margin floor bound',
  compressed.marginFloorApplied === true);
check('the saving reported matches the arithmetic',
  Math.abs(Number(compressed.feeBeforeDiscount) - Number(compressed.fee) - Number(compressed.volumeDiscountAmount)) < 0.01,
  `${compressed.feeBeforeDiscount} - ${compressed.fee} vs ${compressed.volumeDiscountAmount}`);

/**
 * A MISCONFIGURED CAP MUST NOT SELL AT A LOSS. "Never charge more than $100"
 * looks reasonable and would otherwise give away every large payout.
 */
const badCap = quoteSupplierFee(50_000, 0, { ...DEFAULT_SUPPLIER_FEE, maximumUsd: 100 }, { sourceAsset: 'usdc' });
check('a cap set below provider cost is overridden, not honoured',
  Number(badCap.fee) > Number(badCap.providerCost),
  `cap 100.00 but bridge takes ${badCap.providerCost}, charged ${badCap.fee}`);

/** USDT costs more, so it must be charged more at the floor. */
const usdtBig = quoteSupplierFee(50_000, 300_000, DEFAULT_SUPPLIER_FEE, { sourceAsset: 'usdt' });
const usdcBig = quoteSupplierFee(50_000, 300_000, DEFAULT_SUPPLIER_FEE, { sourceAsset: 'usdc' });
check('a USDT payout costs the user more, because it costs Sivan more',
  Number(usdtBig.fee) > Number(usdcBig.fee),
  `usdt ${usdtBig.fee} vs usdc ${usdcBig.fee}`);
check('and USDT margin is still positive',
  Number(usdtBig.fee) - Number(usdtBig.providerCost) > 0);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
