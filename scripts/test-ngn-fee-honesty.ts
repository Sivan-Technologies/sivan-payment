// Backend assertions retained; legacy UI checks moved to docs/legacy-frontend-tests.
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
 * BREET MARKUP MODE IS NOT "NO FEE".
 *
 * When Sivan revenue mode is `breet_markup`, Sivan must NOT collect a second
 * on-chain fee through Privy - but the quote still has to show the markup
 * that Breet will apply inside settlement. The reported live symptom was an
 * 18 USDT quote showing only Breet's fixed 0.5% provider fee (0.09 USDT),
 * while the Breet dashboard markup was set to 1%. Correct display is 1.5%.
 */
const quoteSrcForMarkup = fs.readFileSync('src/ngn/service/ngn-quotes.service.ts', 'utf8');
const transfersSrcForMarkup = fs.readFileSync('src/ngn/service/ngn-transfers.service.ts', 'utf8');
check('breet_markup mode reads Breet markup into the quote',
  /let breetMarkupPercentForQuote = 0/.test(quoteSrcForMarkup)
  && /breetMarkupNgn[\s\S]{0,180}grossForMargin \* \(breetMarkupPercentForQuote \/ 100\)/.test(quoteSrcForMarkup),
  'otherwise the screen shows only Breet fixed provider fee');
check('breet_markup mode includes provider fee + markup in total fee',
  /revenueMode === 'breet_markup'[\s\S]{0,300}totalFee: providerFeeNgn \+ breetMarkupNgn/.test(quoteSrcForMarkup)
  && /effectivePercent:[\s\S]{0,120}\(providerFeeNgn \+ breetMarkupNgn\) \/ grossForMargin/.test(quoteSrcForMarkup),
  '18 USDT should show 1.5%, not only the fixed 0.5% provider fee');
check('but breet_markup still does not collect a Privy wallet fee',
  /const sivanFeeAmount = revenueMode === 'sivan_fee_wallet'/.test(transfersSrcForMarkup)
  && /\.\.\.\(sivanFeeAmount > 0 \? \{ feeAmount: String\(sivanFeeAmount\) \} : \{\}\)/.test(transfersSrcForMarkup),
  'Breet markup and Sivan wallet fee together would double-charge users');

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
const quoteSrc = quoteSrcForMarkup;
check('the quote returns the breakdown as a top-level field',
  /return \{[\s\S]{0,120}\.\.\.record,[\s\S]{0,120}fees: \{[\s\S]{0,260}sivanMargin/.test(quoteSrc),
  'it existed only on metadata, where the client never looked');

/** The split is still available where the cost/revenue distinction matters. */
check('but the breakdown is still returned for admins',
  /providerFee: input\.direction === 'offramp' \? fixedMoney\(providerFeeAsset, 6\) : fixedMoney\(margin\.providerFee, 2\)/.test(quoteSrc));

const grossNgn = SEND * RATE;
const feeNgnShown = Math.round(noProvider.totalFee * RATE);
const receiveNgn = Math.round((SEND - noProvider.totalFee) * RATE);
check('gross − receive equals the fee row exactly',
  grossNgn - receiveNgn === feeNgnShown,
  `${grossNgn} − ${receiveNgn} = ${grossNgn - receiveNgn}, row shows ${feeNgnShown}`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
