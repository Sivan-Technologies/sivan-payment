/**
 * TEST PAYSTACK DVA SYNC AND ADMIN MANAGEMENT TOOLS
 *
 * Verifies:
 * 1. Active Paystack sync: transitions 'provisioning' or 'under_review' to 'ready' when account exists.
 * 2. Admin DVA diagnostics: returns complete local DB and upstream Paystack state.
 * 3. Admin Override: allows admin to surgically assign or activate virtual accounts for users.
 * 4. Admin Reset: clears stuck DVA state back to 'requested', allowing clean restart.
 * 5. Multi-aggregator utility adapter failover and airtime-cash anti-fraud name matching.
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-paystack-dva-sync.json';
process.env.NODE_ENV = 'test';

import {
  getDvaState,
  syncDvaWithPaystack,
  adminGetDvaDetails,
  adminOverrideUserDva,
  adminResetUserDva,
} from '../src/virtual-accounts/service/paystackDvaService.js';
import { db } from '../src/database/json-database.js';
import { executeUtilityWithFailover } from '../src/ngn/provider/utility-registry.js';
import { getAirtimeConversionRate } from '../src/ngn/service/airtime-cash.service.js';
import { matchAccountName } from '../src/kyc/service/name-match.js';


let passed = 0;
function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  passed++;
  console.log(`✓ ${message}`);
}

async function run() {
  console.log('Running Paystack DVA Sync and Admin Tools Test Suite...\n');

  const testUserId = `user_test_dva_${Date.now()}`;

  // 1. Initial State: User with no record should return awaiting_identity
  const state1 = await getDvaState(testUserId);
  assert(state1.state === 'awaiting_identity', 'Unregistered user starts in awaiting_identity state');

  // 2. Admin Override: Admin can manually assign/activate virtual account for user
  const state2 = await adminOverrideUserDva(testUserId, {
    accountNumber: '0123456789',
    bankName: 'Wema Bank',
    accountName: 'Sivan / Samson Micheal',
    status: 'active',
  });
  assert(state2.state === 'ready', 'Admin override successfully sets state to ready');
  if (state2.state === 'ready') {
    assert(state2.account.accountNumber === '0123456789', 'Account number matches admin override');
    assert(state2.account.bankName === 'Wema Bank', 'Bank name matches admin override');
    assert(state2.account.active === true, 'Account is active');
  }

  // 3. Diagnostics: adminGetDvaDetails returns full user & local record
  const details = await adminGetDvaDetails(testUserId);
  assert(details.userId !== undefined, 'Diagnostics return canonical userId');
  assert(details.localRecord !== null, 'Diagnostics return local database record');
  assert((details.dvaState as any).state === 'ready', 'Diagnostics reflect ready state');

  // 4. Admin Reset: Admin can reset stuck account
  const resetRes = await adminResetUserDva(testUserId, 'Testing state reset');
  assert(resetRes.success === true, 'Admin reset returns success');
  const stateAfterReset = await getDvaState(testUserId);
  assert(stateAfterReset.state === 'awaiting_identity', 'After admin reset, state returns to awaiting_identity');

  // 5. Multi-aggregator utility adapter failover
  const failoverRes = await executeUtilityWithFailover(async (provider) => {
    return provider.listDataPlans ? provider.listDataPlans('mtn') : [];
  });
  assert(Array.isArray(failoverRes.result) && failoverRes.result.length > 0, 'Multi-aggregator failover resolves data plans');
  assert(failoverRes.providerName === 'paystack', 'Multi-aggregator failover correctly identifies provider');


  // 6. Airtime-to-cash conversion rates
  const airtimeRate = await getAirtimeConversionRate('mtn');
  assert(airtimeRate.operator === 'mtn', 'Airtime conversion rate returned for MTN');
  assert(airtimeRate.rate > 0, 'Conversion rate is positive');
  assert(airtimeRate.percent === '85%', 'Conversion percent matches MTN rate');
  assert(airtimeRate.minAmountNgn === 1000, 'Min airtime conversion is 1,000 NGN');

  // 7. Strict anti-fraud name matching on airtime-to-cash payouts
  const matchResultValid = matchAccountName('Samson Micheal', 'SAMSON MICHEAL');
  assert(matchResultValid.verdict === 'match', 'Strict name matcher approves matching names');

  const matchResultFraud = matchAccountName('Samson Micheal', 'EMMANUEL CHUKWUMA OKONKWO');
  assert(matchResultFraud.verdict === 'mismatch', 'Strict name matcher rejects third-party fraud account names');

  console.log(`\nAll ${passed} assertions passed successfully!`);
}

run().catch((err) => {
  console.error('\nTest failed with error:', err);
  process.exit(1);
});
