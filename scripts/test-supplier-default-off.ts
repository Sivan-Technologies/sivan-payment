/**
 * SUPPLIER PAYOUTS SHIP OFF, AND STAY OFF UNTIL SOMEONE DECIDES OTHERWISE.
 *
 * Asked for: "set default to off so it does not accidentally switch on and
 * display".
 *
 * The subtlety is that a code default was NOT enough. Migration 025 inserts
 * payments_supplier_controls with supplier_payments_enabled = true, and a
 * saved row always beats a default - verified against the deployed test API,
 * which reports `supplierPaymentsEnabled: true, updatedBy: "migration"`. So
 * three things had to change together: the zod default, the shipped defaults
 * object, and the seeded database row.
 *
 * AND THE DANGEROUS HALF: db-migrate.ts re-runs every migration on EVERY
 * deploy with no ledger. An unguarded "turn it off" UPDATE would switch
 * supplier payouts off on every deploy - silently undoing an operator who
 * turned them on from the hub minutes earlier. That is the case this file
 * exists to pin down.
 *
 * Run: npm run test:supplier-default-off
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-supplier-default-off.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.BRIDGE_MOCK_MODE = 'true';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'default-off-admin-key';
process.env.USER_JWT_SECRET = 'default-off-jwt-secret-value-long';
process.env.RATE_LIMIT_ENABLED = 'false';

import fs from 'node:fs';
fs.rmSync('.data/test-supplier-default-off.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { defaultSupplierControls, supplierControlsSchema } = await import('../src/risk/supplier-risk.service.js');

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 1. the shipped defaults are OFF ──────────────────────────');

const d = defaultSupplierControls();
check('supplier payouts default to disabled', d.supplierPaymentsEnabled === false, String(d.supplierPaymentsEnabled));
check('third-party payouts default to disabled', d.thirdPartySupplierPayoutsEnabled === false);

/**
 * A control that GRANTS a capability fails closed; controls that RESTRICT
 * still fail closed by staying ON. Both directions are "safe", and they point
 * opposite ways - asserted so nobody flips these to match each other.
 */
check('but the RESTRICTIVE controls stay on - invoice required',
  d.requireInvoiceForSupplierPayouts === true);
check('and first-payment review stays on',
  d.newSupplierFirstPaymentReview === true);

const parsedEmpty = supplierControlsSchema.parse({ updatedBy: 'probe', reason: 'parse with nothing supplied' });
check('parsing an empty payload yields disabled, not enabled',
  parsedEmpty.supplierPaymentsEnabled === false,
  'a schema fallback must not open the flow');

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 2. a fresh deployment refuses payouts ────────────────────');

const { db } = await import('../src/database/json-database.js');
const { getSupplierPaymentControls, createSupplierPayment } = await import('../src/suppliers/supplier.service.js');
const { AppError } = await import('../src/shared/errors.js');

const live = await getSupplierPaymentControls();
check('an untouched deployment reports payouts disabled',
  live.supplierPaymentsEnabled === false, String(live.supplierPaymentsEnabled));

const refused = await createSupplierPayment({
  userId: 'usr_any', supplierId: 'sup_any', amount: 100, sourceAsset: 'usdc',
  destinationCurrency: 'gbp', paymentPurpose: 'default-off enforcement probe',
} as any).then(() => null).catch((e: Error) => e);
check('and the payment path refuses before touching a user or a provider',
  refused instanceof AppError && /disabled/i.test(String((refused as any).message)),
  String(refused));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 3. the customer app is told, so nothing is displayed ─────');

const { listPaymentControls } = await import('../src/controls/payment-controls.service.js');
const controls = await listPaymentControls();
check('the public controls payload reports payouts off',
  controls.supplierPayoutsEnabled === false, String(controls.supplierPayoutsEnabled));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 4. THE MIGRATION MUST NOT UNDO A DELIBERATE SWITCH-ON ────');

/**
 * db-migrate.ts runs every file on every deploy with no ledger. Migration 050
 * turns payouts off, so its `where updated_by = 'migration'` guard is the only
 * thing standing between an operator's decision and it being silently reverted
 * on the next deploy.
 */
const migrationRaw = fs.readFileSync('database/migrations/050_supplier_payouts_default_off.sql', 'utf8');
/**
 * COMMENTS STRIPPED FIRST, and this is not fussiness.
 *
 * Caught by mutation testing: with the `and updated_by = 'migration'` clause
 * DELETED from the SQL, this check still passed - because the explanatory
 * comment above the statement contains the phrase "updated_by = 'migration'"
 * and the regex was reading the whole file. The test was asserting that the
 * guard was DESCRIBED, not that it existed.
 */
const migration = migrationRaw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');
check('the migration only touches the migration-seeded row',
  /where[\s\S]*updated_by\s*=\s*'migration'/i.test(migration),
  'without this, every deploy would revert an operator who enabled payouts');
check('and it targets the single global row',
  /id\s*=\s*'global'/i.test(migration));
check('it does not enable anything, only disables',
  !/=\s*true/i.test(migration.split('update')[1] ?? ''),
  'a migration that can turn payouts ON is the accident this prevents');

/**
 * Simulated: an operator enables payouts from the hub, which stamps their
 * identity on the row. The migration predicate must no longer match it.
 */
const rowAfterOperator = { id: 'global', updated_by: 'ops@sivantech.online', supplier_payments_enabled: true };
const migrationWouldMatch = (row: any) => row.id === 'global' && row.updated_by === 'migration';
check('once a human saves the controls, the migration stops matching forever',
  migrationWouldMatch(rowAfterOperator) === false,
  'their choice survives every subsequent deploy');
check('while an untouched seeded row is still matched and turned off',
  migrationWouldMatch({ id: 'global', updated_by: 'migration' }) === true);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 5. an operator can still turn it on, and it sticks ───────');

const { updateSupplierPaymentControls } = await import('../src/suppliers/supplier.service.js');
const enabled = await updateSupplierPaymentControls({
  ...live, supplierPaymentsEnabled: true, thirdPartySupplierPayoutsEnabled: true,
  updatedBy: 'ops@sivantech.online', reason: 'Deliberately enabling supplier payouts after launch',
} as any);
check('an admin can enable payouts', enabled.supplierPaymentsEnabled === true);
check('and the row now carries THEIR identity, not the migration\'s',
  enabled.updatedBy === 'ops@sivantech.online', String(enabled.updatedBy));

const reread = await listPaymentControls();
check('the customer app immediately sees it enabled - no deploy',
  reread.supplierPayoutsEnabled === true, String(reread.supplierPayoutsEnabled));

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
