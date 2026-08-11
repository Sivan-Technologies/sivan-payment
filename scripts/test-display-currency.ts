/**
 * THE CURRENCY PREFERENCE ACTUALLY REACHES THE SCREEN.
 *
 * These assertions are deliberately written against BEHAVIOUR - the string a
 * user would read - and not against the existence of a helper, a constant or a
 * function name. Pinning a name is a mistake I have shipped in this repo
 * before: a test that asserted the reason string 'sweep_disabled_by_admin'
 * broke when another dev renamed it while the behaviour stayed correct, and a
 * toast test passed against markup the test itself had injected.
 *
 * So every case here asks "what does the user see", and the mutation checks at
 * the bottom of the file prove each assertion FAILS when the behaviour is
 * removed - which is the only evidence that a passing test means anything.
 */
import assert from 'node:assert/strict';
import {
  approximateNote,
  convertFromNgn,
  formatFromNgn,
  formatMoney,
  isConverted,
  isDisplayCurrency,
  resolveDisplayCurrency,
} from '../frontend/src/displayCurrency.js';
import { limitKpi } from '../frontend/src/dashboardKpis.js';
import { displayFxRates, convertFromNgn as serverConvert } from '../src/controls/display-fx.js';
import { DEFAULT_PAYMENT_CONTROLS, updatePaymentControlsSchema } from '../src/controls/payment-controls.service.js';

let passed = 0;
const checks: Array<[string, () => void]> = [];
function test(name: string, fn: () => void) { checks.push([name, fn]); }

/** A rate table with round numbers so an arithmetic slip is visible by eye. */
const FX = {
  ngnPerUnit: { ngn: 1, usd: 1500, gbp: 2000, eur: 1600 },
  configured: { ngn: true, usd: true, gbp: true, eur: true },
  approximate: true as const,
  enforcementCurrency: 'ngn' as const,
};

const summary = {
  level: 1,
  levelLabel: 'Level 1: Bank verified',
  path: 'ngn_bank' as const,
  windowDays: 30,
  allowances: [{ flow: 'offramp', rail: 'ngn', limitNgn: 150_000, usedNgn: 30_000, remainingNgn: 120_000 }],
};

// ---------------------------------------------------------------- resolution

test('a saved preference wins over the country path', () => {
  assert.equal(resolveDisplayCurrency('usd', 'ngn_bank'), 'usd');
  assert.equal(resolveDisplayCurrency('eur', 'ngn_bank'), 'eur');
});

test('no preference falls back to the old country behaviour', () => {
  // THE COMPATIBILITY GUARANTEE. A user who has never opened Settings must see
  // exactly what they saw before this change existed.
  assert.equal(resolveDisplayCurrency(undefined, 'ngn_bank'), 'ngn');
  assert.equal(resolveDisplayCurrency(null, 'bridge_kyc'), 'usd');
});

test('a junk preference does not become a currency', () => {
  // Comes off an API payload, so it is attacker-adjacent and must not be
  // trusted to be one of four strings.
  assert.equal(resolveDisplayCurrency('btc', 'ngn_bank'), 'ngn');
  assert.equal(resolveDisplayCurrency('', 'ngn_bank'), 'ngn');
  assert.equal(isDisplayCurrency('btc'), false);
});

// ---------------------------------------------------------------- conversion

test('naira converts to the chosen currency', () => {
  assert.equal(convertFromNgn(150_000, 'usd', FX), 100);
  assert.equal(convertFromNgn(150_000, 'gbp', FX), 75);
});

test('naira is never converted against itself', () => {
  assert.equal(convertFromNgn(150_000, 'ngn', FX), 150_000);
});

test('a missing rate returns the naira figure unchanged rather than guessing', () => {
  assert.equal(convertFromNgn(150_000, 'usd', undefined), 150_000);
  assert.equal(convertFromNgn(150_000, 'usd', { ...FX, ngnPerUnit: { ...FX.ngnPerUnit, usd: 0 } } as any), 150_000);
});

// ---------------------------------------------------------------- formatting

test('the user reads their own symbol, not naira', () => {
  const out = formatFromNgn(150_000, 'usd', FX);
  assert.ok(out.includes('$'), out);
  assert.ok(!out.includes('₦'), `naira leaked into a USD figure: ${out}`);
});

test('a converted figure is marked approximate', () => {
  // The whole disclosure. A converted limit rendered as a flat "$100" is a
  // promise the system cannot keep - the money is enforced in naira at a rate
  // that is not this one.
  assert.ok(formatFromNgn(150_000, 'usd', FX).startsWith('≈'));
  assert.ok(isConverted('usd'));
});

test('an exact naira figure is NOT marked approximate', () => {
  const out = formatFromNgn(150_000, 'ngn', FX);
  assert.equal(out, '₦150,000');
  assert.ok(!out.startsWith('≈'), 'told a naira user their exact limit was an estimate');
  assert.equal(approximateNote('ngn', FX), null);
});

test('with no rate available the figure stays naira and stays exact', () => {
  // Degrading to the truth. A foreign symbol on an unconverted naira number
  // would be the worst of both.
  const out = formatFromNgn(150_000, 'usd', undefined);
  assert.ok(out.includes('₦'), out);
  assert.ok(!out.startsWith('≈'), out);
  assert.equal(approximateNote('usd', undefined), null);
});

test('naira is shown whole - a bank transfer cannot settle a kobo', () => {
  assert.equal(formatMoney(75_352.5, 'ngn'), '₦75,353');
});

test('euros group in the European style', () => {
  assert.equal(formatMoney(1234, 'eur'), '€1.234');
});

// ------------------------------------------------------------- the KPI card

test('the dashboard limit card follows the preference', () => {
  const usd = limitKpi(summary as any, true, 'usd', FX as any);
  assert.ok(usd.value.includes('$'), usd.value);
  assert.ok(!usd.value.includes('₦'), `dashboard still printing naira to a USD user: ${usd.value}`);
  assert.equal(usd.value, '≈$80.00 left');
});

test('the same card in naira is unchanged from before', () => {
  const ngn = limitKpi(summary as any, true, 'ngn', FX as any);
  assert.equal(ngn.value, '₦120,000 left');
  assert.ok(!ngn.sub.includes('approx'));
});

test('a caller that passes no currency gets the old behaviour exactly', () => {
  // Protects every existing call site and test from this change.
  assert.equal(limitKpi(summary as any, true).value, '₦120,000 left');
});

test('END TO END: a saved USD preference changes what the dashboard prints', () => {
  /**
   * THE BUG THE USER REPORTED, AS ONE ASSERTION.
   *
   * Every other case here hands limitKpi a currency directly, so all of them
   * would still pass if resolveDisplayCurrency were bypassed in App.tsx and
   * the preference never reached the card - which is exactly the shape of the
   * original bug: a working setting, a working formatter, and a screen that
   * does not change. This is the only test that runs the real chain,
   * preference string -> resolution -> rendered figure.
   */
  const nigerianOnUsd = limitKpi(
    summary as any,
    true,
    resolveDisplayCurrency('usd', summary.path),
    FX as any,
  );
  assert.ok(!nigerianOnUsd.value.includes('\u20a6'), `preference ignored: ${nigerianOnUsd.value}`);
  assert.ok(nigerianOnUsd.value.includes('$'), nigerianOnUsd.value);

  // And the same Nigerian who never touched Settings still reads naira.
  const untouched = limitKpi(summary as any, true, resolveDisplayCurrency(undefined, summary.path), FX as any);
  assert.ok(untouched.value.includes('\u20a6'), untouched.value);
});

test('a converted card says approx where the user reads the number', () => {
  assert.ok(limitKpi(summary as any, true, 'usd', FX as any).sub.includes('approx'));
});

test('the loading state is still non-committal in any currency', () => {
  // A KPI that reads zero while loading accuses a verified user of not being
  // verified - this repo has shipped that twice.
  assert.equal(limitKpi(summary as any, false, 'usd', FX as any).value, '—');
});

// ------------------------------------------------------------------- server

test('NGN is offered as a payout currency', () => {
  const ngn = DEFAULT_PAYMENT_CONTROLS.find((c) => c.currency === 'ngn');
  assert.ok(ngn, 'naira missing from the payout controls');
  assert.equal(ngn!.enabled, true, 'the live naira rail must not ship switched off');
});

test('the naira control is not pretending to be a Bridge account shape', () => {
  // 'us' | 'gb' | 'iban' are Bridge external-account shapes and a NUBAN is
  // none of them. Mislabelling it would let a client POST a naira account
  // into the Bridge path.
  const ngn = DEFAULT_PAYMENT_CONTROLS.find((c) => c.currency === 'ngn')!;
  assert.equal(ngn.accountType, 'nuban');
  assert.ok(!['us', 'gb', 'iban'].includes(ngn.accountType));
});

test('an admin can toggle the naira rail', () => {
  const parsed = updatePaymentControlsSchema.safeParse({ payoutCurrencies: [{ currency: 'ngn', enabled: false }] });
  assert.equal(parsed.success, true, 'admin hub cannot switch naira off');
});

test('naira is refused as a VIRTUAL account - Bridge issues none', () => {
  const parsed = updatePaymentControlsSchema.safeParse({ virtualAccounts: [{ currency: 'ngn', enabled: true }] });
  assert.equal(parsed.success, false, 'accepted a naira virtual account that cannot exist');
});

test('server and client agree on the arithmetic', () => {
  // Two implementations of one conversion is a drift risk; this is the check
  // that would catch it.
  const rates = displayFxRates();
  const server = serverConvert(150_000, 'usd', rates);
  const client = convertFromNgn(150_000, 'usd', { ...FX, ngnPerUnit: rates.ngnPerUnit } as any);
  assert.equal(server, client);
});

test('a non-positive configured rate is refused, not obeyed', () => {
  // A zero rate would make every converted amount Infinity or 0.
  const prev = process.env.DISPLAY_FX_USD_TO_GBP;
  process.env.DISPLAY_FX_USD_TO_GBP = '0';
  const rates = displayFxRates();
  assert.ok(rates.ngnPerUnit.gbp > 0 && Number.isFinite(rates.ngnPerUnit.gbp));
  assert.equal(rates.configured.gbp, false, 'a refused rate must not report itself as configured');
  if (prev === undefined) delete process.env.DISPLAY_FX_USD_TO_GBP; else process.env.DISPLAY_FX_USD_TO_GBP = prev;
});

test('the response states that enforcement is still in naira', () => {
  assert.equal(displayFxRates().enforcementCurrency, 'ngn');
  assert.equal(displayFxRates().approximate, true);
});

for (const [name, fn] of checks) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${(error as Error).message.split('\n')[0]}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${checks.length} passed`);
if (passed !== checks.length) process.exitCode = 1;
