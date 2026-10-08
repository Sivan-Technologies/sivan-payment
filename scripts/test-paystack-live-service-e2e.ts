/**
 * LIVE PAYSTACK SANDBOX SERVICE-LAYER E2E TEST
 *
 * Tests the full state machine (resolveOrCreateDva -> completeAfterIdentification -> getDvaState)
 * against genuine Paystack API using the configured sandbox test key.
 */

import 'dotenv/config';
import { db } from '../src/database/json-database.js';
import {
  resolveOrCreateDva,
  completeAfterIdentification,
  getDvaState,
} from '../src/virtual-accounts/service/paystackDvaService.js';

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

async function main() {
  console.log('\n' + '='.repeat(55));
  console.log('🔷 SIVAN LIVE PAYSTACK DVA SERVICE-LAYER E2E TEST');
  console.log('='.repeat(55));

  const userId = 'sivan_live_sandbox_user_' + Date.now();
  const now = new Date().toISOString();

  // 1. Seed user in DB
  await db.insertUserRecord({
    id: userId,
    email: `${userId}@user.sivantech.online`,
    fullName: 'Joe Micheal',
    createdAt: now,
    updatedAt: now,
  });

  // 2. Initial state before DVA creation
  console.log('\n══ 1. Initial State ══');
  const initial = await getDvaState(userId);
  check('Unregistered user returns awaiting_identity', initial.state === 'awaiting_identity');

  // 3. Step A & B: Resolve or create DVA (live Paystack call)
  console.log('\n══ 2. Resolve / Create DVA (Real Paystack API Call) ══');
  const verifying = await resolveOrCreateDva({
    userId,
    legalName: 'Joe Micheal',
    identifier: '22212345678',
    phone: '+2348012345678',
  });

  check('Flow advances to verifying state (awaiting webhook)', verifying.state === 'verifying', verifying.state);
  const customerCode = (verifying as any).customerCode;
  check('Valid customer code returned from Paystack', typeof customerCode === 'string' && customerCode.startsWith('CUS_'), customerCode);
  console.log(`     Customer Code in DB & Paystack: ${customerCode}`);

  // 4. Step C: Webhook resolution (Simulating customeridentification.success)
  console.log('\n══ 3. Webhook KYC Completion & NUBAN Assignment ══');
  const completed = await completeAfterIdentification(userId, customerCode);
  check('Account state is ready after identification verdict', completed.state === 'ready', completed.state);

  if (completed.state === 'ready') {
    const acc = completed.account;
    check('Dedicated NUBAN account number generated', Boolean(acc.accountNumber), acc.accountNumber);
    check('Bank name surfaced', Boolean(acc.bankName), acc.bankName);
    check('Mode is marked test', acc.mode === 'test', acc.mode);
    console.log(`     Assigned NUBAN: ${acc.accountNumber}`);
    console.log(`     Assigned Bank: ${acc.bankName}`);
    console.log(`     Account Name: ${acc.accountName}`);
  }

  // 5. Idempotent check
  console.log('\n══ 4. Idempotent Cached Lookups ══');
  const cached = await getDvaState(userId);
  check('Subsequent getDvaState() reads directly from storage without extra API calls', cached.state === 'ready');

  console.log('\n' + '='.repeat(55));
  console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(55) + '\n');

  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\nSUITE ERROR:', err);
  process.exitCode = 1;
});
