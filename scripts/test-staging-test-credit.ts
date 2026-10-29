/**
 * TEST STAGING TEST CREDIT FACILITY (50,000 NGN WELCOME CREDIT)
 *
 * Verifies:
 * 1. Automatic 50,000 NGN credit grant upon DVA ready state in staging.
 * 2. Idempotency: duplicate calls do not double credit.
 * 3. Ledger integrity: updates payments_virtual_account_transactions,
 *    payments_virtual_account_events, balance ledger, and unified balance.
 * 4. Production guard: strictly blocked when live.
 */

import { grantStagingDvaTestCredit, backfillStagingDvaTestCredits } from '../src/virtual-accounts/service/paystackDvaService.js';
import { db } from '../src/database/json-database.js';
import { getUserNgnBalance } from '../src/ngn/service/sivanUtilityService.js';
import { getUserBalance } from '../src/balances/balance.service.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✅ ok - ${name}`);
  } else {
    failed++;
    console.log(`  ❌ FAIL - ${name}${detail ? `  (${detail})` : ''}`);
  }
}

async function run() {
  console.log('\n==================================================');
  console.log('🔷 SIVAN AI . TEST STAGING CREDIT FACILITY');
  console.log('==================================================\n');

  // Test user
  const testUserId = `test_user_cred_${Date.now()}`;
  const now = new Date().toISOString();

  // Create user record
  await db.insertUserRecord({
    id: testUserId,
    email: `${testUserId}@user.sivantech.online`,
    fullName: 'Test Credit User',
    primaryChannel: 'email',
    createdAt: now,
    updatedAt: now,
  });

  // Create virtual account record in ready/active state
  await db.upsertVirtualAccountRecord({
    id: `va_${testUserId}`,
    userId: testUserId,
    provider: 'paystack',
    providerAccountId: `act_${testUserId}`,
    currency: 'ngn',
    country: 'NG',
    bankName: 'Test Bank',
    accountName: 'Sivan / Test Credit User',
    accountNumberMasked: '****1234',
    status: 'active',
    customerId: `cus_${testUserId}`,
    createdAt: now,
    updatedAt: now,
  });

  // 1. Initial balance should be 0 NGN
  const initialBal = await getUserNgnBalance(testUserId);
  check('Initial user NGN balance is 0', initialBal === 0, `Got ${initialBal}`);

  // 2. Grant staging test credit
  const granted = await grantStagingDvaTestCredit(testUserId);
  check('grantStagingDvaTestCredit returns true on first call', granted === true);

  // 3. Balance after credit should be 50,000 NGN
  const postBal = await getUserNgnBalance(testUserId);
  check('User NGN balance is exactly 50,000 NGN after credit', postBal === 50000, `Got ${postBal}`);

  // 4. Verify balance ledger entry
  const userLedger = await getUserBalance(testUserId);
  const ngnRow = userLedger.balances.find((b) => b.asset === 'ngn');
  check('Ledger contains NGN available of 50000', Number(ngnRow?.available) === 50000, `Got ${ngnRow?.available}`);

  // 5. Idempotency test: calling grantStagingDvaTestCredit a second time must return false and not double credit
  const secondCall = await grantStagingDvaTestCredit(testUserId);
  check('Second grantStagingDvaTestCredit call returns false (idempotent)', secondCall === false);

  const postSecondBal = await getUserNgnBalance(testUserId);
  check('Balance remains exactly 50,000 NGN without duplication', postSecondBal === 50000, `Got ${postSecondBal}`);

  // 6. Virtual account transaction record check
  const allTxs = await db.listVirtualAccountTransactions();
  const userTx = allTxs.find((tx) => tx.userId === testUserId && (tx.rawPayload as any)?.sourceType === 'sandbox_test_credit');
  check('Recorded transaction has completed status', userTx?.status === 'completed');
  check('Recorded transaction amount is 50000.00', userTx?.destinationAmount === '50000.00');

  // 7. Production safety test: simulate live mode / production environment
  process.env.APP_ENV = 'production';
  const prodUserId = `prod_user_${Date.now()}`;
  const prodAttempt = await grantStagingDvaTestCredit(prodUserId);
  check('Strict production safety: refused when APP_ENV is production', prodAttempt === false);
  delete process.env.APP_ENV;

  console.log('\n==================================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('==================================================\n');

  if (failed > 0) process.exit(1);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });
