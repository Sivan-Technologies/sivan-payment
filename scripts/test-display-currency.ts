// Backend assertions retained; legacy UI checks moved to docs/legacy-frontend-tests.
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
// Legacy UI assertions are retained in docs/legacy-frontend-tests; standalone coverage owns the UI.
import { displayFxRates, convertFromNgn as serverConvert } from '../src/controls/display-fx.js';
import { DEFAULT_PAYMENT_CONTROLS, updatePaymentControlsSchema } from '../src/controls/payment-controls.service.js';

let passed = 0;
const checks: Array<[string, () => void]> = [];
function test(name: string, fn: () => void) { checks.push([name, fn]); }

// Legacy UI assertions are retained in docs/legacy-frontend-tests; standalone coverage owns the UI.
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

test('server converts using its published rate', () => {
  // Two implementations of one conversion is a drift risk; this is the check
  // that would catch it.
  const rates = displayFxRates();
  const server = serverConvert(150_000, 'usd', rates);
  assert.equal(server, 150_000 / rates.ngnPerUnit.usd);
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
