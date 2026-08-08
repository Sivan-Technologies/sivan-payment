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
console.log('\n── 1. every provider reports its fee in the SOURCE asset ────');

/**
 * THE UNIT IS THE PROVIDER'S TO STATE, AND THEY DISAGREED.
 *
 * breet.provider.ts computed its off-ramp fee on the NAIRA gross
 * (`gross * percent` = 382.50) while mock-ngn reported USDC (0.255), and
 * ngn-margin.ts adds providerFeeAmount to a margin denominated in the source
 * amount. Adding 382.50 to 0.51 charged 383 "USDC" on a 51 USDC withdrawal -
 * 751%, leaving the user at minus 332.
 *
 * MY FIRST FIX CONVERTED BY RATE DOWNSTREAM, and that broke the other
 * provider: mock's already-correct 0.255 was divided by 1,500 and rendered on
 * the quote card as "0.00017 USDC". Reported from the screen.
 *
 * A caller cannot know which unit a given provider chose. Breet now reports
 * the source asset like everyone else, and nothing converts.
 */
const breetSrc = fs.readFileSync('src/ngn/provider/breet.provider.ts', 'utf8');
check('Breet computes its off-ramp fee on the SOURCE amount, not the naira gross',
  /feeAmount = source \* \(feePercent \/ 100\);\n\s*const gross = source \* rate;/.test(breetSrc),
  'gross * percent gives naira, which the margin service then treats as USDC');

const marginSrc = fs.readFileSync('src/ngn/service/ngn-margin.ts', 'utf8');
check('and the margin service does NOT convert by rate any more',
  !/providerFeeInSourceUnits/.test(marginSrc),
  'converting downstream fixed Breet and broke mock');

/** The exact figure from the screenshot, asserted so it cannot come back. */
const passthrough = await applySivanMargin({
  direction: 'offramp', grossAmount: SEND, providerFeeAmount: 0.255,
} as any);
check('a 0.255 USDC provider fee stays 0.255, not 0.00017',
  passthrough.providerFee === 0.255, String(passthrough.providerFee));
check('so the total is 1.5% and the naira figure is ₦1,148',
  Math.abs(passthrough.effectivePercent - 1.5) < 0.01
  && Math.round(passthrough.totalFee * RATE) === 1148,
  `${passthrough.effectivePercent}% / ₦${Math.round(passthrough.totalFee * RATE)}`);
check('providerFee + sivanMargin === totalFee',
  Math.abs((passthrough.providerFee + passthrough.sivanMargin) - passthrough.totalFee) < 1e-9);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 2. the intended 1.5% = 1% Sivan + 0.5% Breet ─────────────');

check('Sivan takes its configured 1%',
  Math.abs(passthrough.sivanMargin - 0.51) < 0.001, `${passthrough.sivanMargin} USDC`);
check('Breet takes 0.5%',
  Math.abs(passthrough.providerFee - 0.255) < 0.001, `${passthrough.providerFee} USDC`);

const ngnTaken = passthrough.totalFee * RATE;
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
console.log('\n── 3. the provider rate is ADMIN-SET, not hardcoded ─────────');

/**
 * IT LIVED IN THREE PLACES, none of them changeable without a deploy:
 * BREET_FEE_PERCENT in the environment, and `0.005` written into
 * mock-ngn.provider.ts twice. So the mock disagreed with the real provider
 * whenever the rate moved - local testing showing a fee the user is not
 * charged - and matching a vendor price change meant shipping code.
 */
const { ngnProviderFeePercent } = await import('../src/ngn/service/ngn-provider-fee.js');
const { getAdminFeeSettings, updateAdminFeeSettings } = await import('../src/admin/admin-fees.service.js');

check('the provider rate is readable from the fee settings',
  (await ngnProviderFeePercent()) === 0.5, String(await ngnProviderFeePercent()));

const before: any = await getAdminFeeSettings();
await updateAdminFeeSettings({ ...before, ngnProviderFeePercent: 0.8, updatedBy: 'ops@test', reason: 'raise the provider rate from the fee tab' } as any, {});
check('an admin change takes effect with no deploy',
  (await ngnProviderFeePercent()) === 0.8, String(await ngnProviderFeePercent()));

/** It must reach the actual charge, not just the settings read. */
const raised = await applySivanMargin({
  direction: 'offramp', grossAmount: SEND, providerFeeAmount: SEND * 0.008,
} as any);
check('and flows through to what the user pays',
  Math.abs(raised.effectivePercent - 1.8) < 0.01, `${raised.effectivePercent}%`);

/** 0 is a real setting - some providers bundle the fee into the rate. */
await updateAdminFeeSettings({ ...before, ngnProviderFeePercent: 0, updatedBy: 'ops@test', reason: 'provider bundles its fee into the rate' } as any, {});
check('zero is honoured, not treated as "unset"',
  (await ngnProviderFeePercent()) === 0, String(await ngnProviderFeePercent()));

await updateAdminFeeSettings({ ...before, ngnProviderFeePercent: 0.5, updatedBy: 'ops@test', reason: 'restore' } as any, {});

const mockSrc = fs.readFileSync('src/ngn/provider/mock-ngn.provider.ts', 'utf8');
check('the mock provider no longer hardcodes 0.005',
  !/source \* 0\.005/.test(mockSrc),
  'the mock must charge what the fee tab says, or it tests a fiction');
check('and reads the same shared source as Breet',
  /ngnProviderFeePercent\(\)/.test(mockSrc) && /ngnProviderFeePercent\(\)/.test(breetSrc));

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

/**
 * ONE ROW, NOT THREE.
 *
 * The card briefly showed "Sivan fee", "Provider fee" and "Total fee" as
 * separate lines. That is the right breakdown for an accounts screen and the
 * wrong one for a user: the split between Sivan's margin and Breet's cut is
 * internal cost structure, and the person withdrawing has no decision to make
 * about it. Three numbers to reconcile where one answers their only question.
 */
check('the card shows a single combined fee row',
  /return \[\{ label: 'Sivan fee', value: both\(fees\.totalFee\) \}\]/.test(form),
  'the provider split belongs on an admin screen, not a withdrawal');
/**
 * NO PERCENTAGE IN THE LABEL.
 *
 * The user is sending a fixed amount, so the cash figure is the whole answer.
 * A rate beside it is a third representation of one charge that nobody checks,
 * and it invites arithmetic against the rate line - which is how a rounded
 * display starts looking like a discrepancy.
 */
check('and no percentage in the label',
  !/label: `Sivan fee\$\{percent\}`/.test(form) && !/effectivePercent\).toFixed\(2\)\}%\)/.test(form),
  'the cash figure is the whole answer');
check('and no separate provider row is rendered',
  !/label: 'Provider fee'/.test(form) && !/label: `Total fee/.test(form));
/**
 * INCLUDED, NOT HIDDEN. The single figure is totalFee - Sivan's margin plus
 * the provider's cut - so removing the row did not remove the charge.
 */
check('the one row is the TOTAL, so the provider cut is still charged',
  /value: both\(fees\.totalFee\)/.test(form),
  'showing only sivanMargin would understate the fee by the provider cut');
/** The split is still available where the cost/revenue distinction matters. */
check('but the breakdown is still returned for admins',
  /providerFee: String\(margin\.providerFee\)/.test(quoteSrc));

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

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 6. the CONFIRM screen restates the quote, not a percentage ');

/**
 * The confirm screen showed a bare percentage one step after a card itemising
 * "Sivan fee ₦765 · 0.51 USDC". Asking someone to reconcile a percentage
 * against a cash figure they read ten seconds earlier is how a confirmation
 * screen creates doubt rather than removing it - and on the naira rail the
 * percentage was Bridge's 1.25%, so it was not even the same charge.
 */
const app = fs.readFileSync('frontend/src/App.tsx', 'utf8');
check('the accepted quote carries its fee onto the review state',
  /feeSummary: \(\(\) => \{/.test(app),
  'the confirm screen had no amount to show, only a rate');
check('and what the user receives',
  /payoutSummary: \{/.test(app));

/**
 * COPIED, NOT RECOMPUTED. Recomputing the fee on the second screen risks the
 * two disagreeing by a rounding step, which is precisely the class of bug
 * that produced "₦1" in the first place.
 */
check('the figures come from the quote rather than being recalculated',
  /quote\.fees\?\.totalFee \?\? quote\.feeAmount/.test(app),
  'two independent calculations of one fee will eventually differ');
check('and are rounded to whole naira on this screen too',
  /Math\.round\(totalFee \* rate\)/.test(app));

const sectionsRaw = fs.readFileSync('frontend/src/components/AppSections.tsx', 'utf8');
const sectionsCode = sectionsRaw.replace(/\/\*[\s\S]*?\*\//g, '');
/**
 * BEHAVIOUR, NOT PRESENCE.
 *
 * This first read `/review\.feeSummary\?\.ngn/`, which a mutant prefixing the
 * expression with `false &&` satisfies perfectly - the string is still there
 * and the screen still shows a bare percentage. Third time this session a
 * source regex has checked that code EXISTS rather than that it RUNS.
 *
 * The ternary is evaluated for real instead: cash when the quote carried it,
 * the percentage when it did not.
 */
const feeDisplayFor = (feeSummary: any, fallback: string) =>
  feeSummary?.ngn
    ? `${feeSummary.ngn}${feeSummary.asset ? ` · ${feeSummary.asset}` : ''}`
    : fallback;

check('the confirm screen prefers the cash figure over the percentage',
  feeDisplayFor({ ngn: '₦1,148', asset: '0.765 USDC' }, '1.25%')
    === '₦1,148 · 0.765 USDC',
  feeDisplayFor({ ngn: '₦1,148', asset: '0.765 USDC' }, '1.25%'));
/**
 * THE TWO SCREENS MUST STILL MATCH. Dropping the percentage from the quote
 * card and leaving it here would recreate the mismatch this pair was fixed to
 * remove - same figures, one screen with a rate and one without.
 */
check('and shows exactly what the quote card shows - no trailing percentage',
  !/\(\$\{review\.feeSummary\.percent\}%\)/.test(sectionsCode),
  'the quote card no longer shows one, so neither should this');

// And the exact expression must still be wired into the component.
check('and that expression is the one the component renders',
  /const feeDisplay = review\.feeSummary\?\.ngn/.test(sectionsCode),
  'the logic above must match what actually ships');
/**
 * The Bridge rail creates a liquidation address with no amount in existence,
 * so a percentage is the only honest answer there. The fallback must survive.
 */
check('but still falls back to the rail-correct percentage when there is no quote',
  feeDisplayFor(undefined, '1.25%') === '1.25%' && /: sivanFeeLabel;/.test(sectionsCode),
  'the Bridge rail has no pre-accepted quote to restate');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
