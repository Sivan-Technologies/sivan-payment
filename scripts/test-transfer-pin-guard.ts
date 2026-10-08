/**
 * TEST ADAPTIVE TRANSFER GUARD FOR DIRECT & P2P TRANSFERS
 *
 * Verifies the 5-rule risk-based step-up authentication matrix:
 * 1. New Sender (0 previous completed transfers): PIN required on all transfers, even $5.
 * 2. High-Value Transfer (>= 15 USDC): PIN required.
 * 3. New Recipient / Destination Address: PIN required.
 * 4. 24h Velocity Exceeded (>= 3 transfers or >= 30 USDC cumulative): PIN required.
 * 5. Frictionless Micro-Send (< 15 USDC to known counterparty): Allowed without PIN.
 */
import {
  assertTransferAuthorised,
} from '../src/identity/withdrawal-pin.guard.js';
import {
  setWithdrawalPin,
  hasWithdrawalPin,
} from '../src/identity/withdrawal-pin.service.js';
import { createAuditLog } from '../src/audit/audit.service.js';
import { env } from '../src/config/env.js';

let passed = 0;
function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
}

async function assertRejects(fn: () => Promise<unknown>, expectedCode: string, message: string) {
  try {
    await fn();
    throw new Error(`${message}: expected rejection with code ${expectedCode}, but call succeeded.`);
  } catch (error: any) {
    const code = error?.details?.code || error?.code || error?.message || '';
    if (!String(code).toLowerCase().includes(expectedCode.toLowerCase()) && !String(error?.message || '').toLowerCase().includes(expectedCode.toLowerCase())) {
      throw new Error(`${message}: rejected with wrong code -> ${JSON.stringify(error?.details || error?.message)}`);
    }
    passed += 1;
    console.log(`✓ ${message}`);
  }
}

async function run() {
  console.log('Testing Adaptive Transfer Guard...');

  // Ensure enforcement is enabled for test
  (env as any).WITHDRAWAL_PIN_ENFORCED = true;

  const testUserId = `test_transfer_user_${Date.now()}`;
  const knownRecipient = '0x1111111111111111111111111111111111111111';
  const newRecipient = '0x2222222222222222222222222222222222222222';

  // Test 1: New sender with NO PIN configured -> rejects with PIN_NOT_SET
  await assertRejects(
    () => assertTransferAuthorised({
      userId: testUserId,
      amount: 5,
      destinationAddress: knownRecipient,
    }),
    'PIN_NOT_SET',
    'New sender with no PIN configured is prompted with PIN_NOT_SET'
  );

  // Configure PIN for user
  await setWithdrawalPin(testUserId, { pin: '849201' });
  assert(await hasWithdrawalPin(testUserId), 'User now has withdrawal PIN configured');

  // Test 2: New sender (0 transfer history) with amount $5 and NO PIN passed -> rejects with PIN_REQUIRED
  await assertRejects(
    () => assertTransferAuthorised({
      userId: testUserId,
      amount: 5,
      destinationAddress: knownRecipient,
    }),
    'PIN_REQUIRED',
    'New sender sending $5 is required to provide PIN'
  );

  // Test 3: New sender providing wrong PIN -> rejects with PIN_INVALID
  await assertRejects(
    () => assertTransferAuthorised({
      userId: testUserId,
      amount: 5,
      destinationAddress: knownRecipient,
      pin: '000000',
    }),
    'That PIN is not correct',
    'Wrong PIN is rejected'
  );

  // Test 4: New sender providing CORRECT PIN -> passes!
  await assertTransferAuthorised({
    userId: testUserId,
    amount: 5,
    destinationAddress: knownRecipient,
    pin: '849201',
  });
  assert(true, 'New sender providing correct PIN authorizes transfer successfully');

  // Simulate established transfer history by creating an audit log of a completed transfer to knownRecipient
  await createAuditLog({
    actorType: 'user',
    actorId: testUserId,
    action: 'balance.transfer_confirmed',
    resourceType: 'balance_transfer',
    resourceId: 'btx_mock_1',
    severity: 'info',
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), // 5 days ago
    metadata: {
      transferId: 'btx_mock_1',
      userId: testUserId,
      amount: '10',
      asset: 'USDC',
      network: 'base',
      destinationAddress: knownRecipient,
      status: 'completed',
    },
  });

  // Test 5: Established sender sending $10 (< $15) to KNOWN recipient without PIN -> FRICTIONLESS PASS!
  await assertTransferAuthorised({
    userId: testUserId,
    amount: 10,
    destinationAddress: knownRecipient,
  });
  assert(true, 'Established sender sending $10 to known recipient passes without PIN');

  // Test 6: Established sender sending $25 (>= $15) to KNOWN recipient without PIN -> rejects with PIN_REQUIRED!
  await assertRejects(
    () => assertTransferAuthorised({
      userId: testUserId,
      amount: 25,
      destinationAddress: knownRecipient,
    }),
    'PIN_REQUIRED',
    'Transfers of $25 (>= $15) to known recipient require PIN'
  );

  // Test 7: Established sender sending $25 to KNOWN recipient with correct PIN -> passes!
  await assertTransferAuthorised({
    userId: testUserId,
    amount: 25,
    destinationAddress: knownRecipient,
    pin: '849201',
  });
  assert(true, 'Transfer of $25 with correct PIN authorizes successfully');

  // Test 8: Established sender sending $5 (< $15) to a NEW / UNKNOWN recipient without PIN -> rejects with PIN_REQUIRED!
  await assertRejects(
    () => assertTransferAuthorised({
      userId: testUserId,
      amount: 5,
      destinationAddress: newRecipient,
    }),
    'PIN_REQUIRED',
    'Transfers to new/unseen recipient address require PIN even for $5'
  );

  // Test 9: Established sender sending to new recipient with correct PIN -> passes!
  await assertTransferAuthorised({
    userId: testUserId,
    amount: 5,
    destinationAddress: newRecipient,
    pin: '849201',
  });
  assert(true, 'Transfer to new recipient with correct PIN authorizes successfully');

  // Test 10: Velocity Cap: Simulate 3 recent transfers in the last 24h
  for (let i = 1; i <= 3; i++) {
    await createAuditLog({
      actorType: 'user',
      actorId: testUserId,
      action: 'balance.transfer_confirmed',
      resourceType: 'balance_transfer',
      resourceId: `btx_mock_recent_${i}`,
      severity: 'info',
      createdAt: new Date().toISOString(),
      metadata: {
        transferId: `btx_mock_recent_${i}`,
        userId: testUserId,
        amount: '8',
        asset: 'USDC',
        network: 'base',
        destinationAddress: knownRecipient,
        status: 'completed',
      },
    });
  }

  // After 3 transfers in 24h, even a $5 send to a known recipient must require a PIN!
  await assertRejects(
    () => assertTransferAuthorised({
      userId: testUserId,
      amount: 5,
      destinationAddress: knownRecipient,
    }),
    'PIN_REQUIRED',
    '24-hour velocity limit triggers PIN requirement even for $5 to known recipient'
  );

  console.log(`\nAll ${passed} assertions passed successfully!`);
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
