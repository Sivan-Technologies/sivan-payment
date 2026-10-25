/**
 * SIVAN UTILITY CONCURRENCY & RESILIENCE REGRESSION TEST SUITE (18 SUITES)
 *
 * Verifies end-to-end:
 * 1.  Persistence failure halts dispatch: provider is never called if reservation DB write fails.
 * 2.  Concurrency double-spend prevention: concurrent purchases atomically serialized.
 * 3.  Durable idempotency: receipt recovered across process restart, zero double debit.
 * 4.  Idempotency conflict (409): reusing key with conflicting payload rejected.
 * 5.  Idempotency ownership (403): reusing key across different users rejected.
 * 6.  Strict failover guard: timeouts NEVER fail over to another provider.
 * 7.  Timeout hold retention: timeout retains hold and marks pending_reconciliation (never refund on timeout alone).
 * 8.  Confirmed rejection release: provider business rejection atomically releases ledger hold.
 * 9.  Post-delivery resilience: debit write failure marks delivery_confirmed_unsettled, logs critical incident, returns valid receipt.
 * 10. Unsettled reconciliation: reconcileUnsettledUtilityPurchases finalizes unsettled debit.
 * 11. Fail-closed controls: database read failure disables controls and blocks purchases.
 * 12. Catalogue enforcement: unconfigured data plan rejected.
 * 13. Provider plan code translation: internal bundle size mapped to aggregator plan code before dispatch.
 * 14. Electricity inquiry and payment: pre-flight inquiry and token generation with structured receipt.
 * 15. Fail-closed idempotency lookups: database read failure halts dispatch and throws 503 Service Unavailable.
 * 16. Ambiguous unknown error hold retention: unhandled crash / 500 error retains hold in pending_reconciliation.
 * 17. Paystack reference forwarding: outbound Paystack payload contains caller idempotencyKey as reference.
 * 18. Connected reconciliation operational process: reconcileUnsettledUtilityPurchases tracks and audits reconciliation.
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-utility-concurrency.json';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_mock_concurrency_key_12345';
process.env.NODE_ENV = 'test';
process.env.IDENTITY_LINK_SERVICE_SECRET = 'test_service_secret_concurrency';
process.env.UTILITY_ROUTING = JSON.stringify({
  routes: { airtime: ['mock_primary', 'mock_secondary'], data: ['mock_primary'], electricity: ['mock_primary'] },
  failover: { airtime: true, data: false, electricity: false },
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { IUtilityProvider } from '../src/ngn/provider/utility-provider.interface.js';

function ok(message: string): void {
  console.log(`  ✅ ok . ${message}`);
}

async function run(): Promise<void> {
  console.log('\n======================================================');
  console.log('🛡️  SIVAN UTILITY CONCURRENCY & RESILIENCE TEST SUITE');
  console.log('======================================================\n');

  // Dynamic import ensures process.env is applied prior to module evaluation
  const { db } = await import('../src/database/json-database.js');
  const {
    executeAirtimePurchase,
    executeDataPurchase,
    executeElectricityInquiry,
    executeElectricityPayment,
    getUserNgnBalance,
    getCachedReceipt,
    reconcileUnsettledUtilityPurchases,
  } = await import('../src/ngn/service/sivanUtilityService.js');
  const {
    registerUtilityProvider,
    setUtilityRouting,
  } = await import('../src/ngn/provider/utility-registry.js');
  const { UtilityProviderError } = await import('../src/ngn/provider/utility-provider.error.js');
  const { listSystemIncidents } = await import('../src/incidents/system-incidents.service.js');
  const { updateUtilityDataPlans } = await import('../src/ngn/service/utility-data-plans.service.js');
  const { getUtilitiesControls } = await import('../src/admin/feature-controls.service.js');

  // Ensure fresh isolated test data file
  const testDbPath = path.resolve('.data/test-utility-concurrency.json');
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  // ─── 0. Register Test Providers ────────────────────────────────────
  let primaryCallCount = 0;
  let secondaryCallCount = 0;
  let lastDispatchedPlanCode = '';

  const mockPrimary: IUtilityProvider = {
    name: 'mock_primary',
    supports: ['airtime', 'data', 'electricity'],
    priority: 10,
    async purchaseAirtime(phone, amountNgn, operator, idempotencyKey) {
      primaryCallCount++;
      await new Promise((r) => setTimeout(r, 40));
      return {
        reference: `ref_prim_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        amountNgn,
        phone,
        operator,
        status: 'success',
        message: 'Mock airtime delivered',
        rawPayload: { provider: 'mock_primary', phone, amountNgn, operator, idempotencyKey },
      };
    },
    async purchaseDataBundle(phone, planCode, amountNgn, operator, idempotencyKey) {
      primaryCallCount++;
      lastDispatchedPlanCode = planCode;
      await new Promise((r) => setTimeout(r, 40));
      return {
        reference: `ref_prim_data_${Date.now()}`,
        amountNgn,
        phone,
        operator,
        planCode,
        status: 'success',
        message: 'Mock data delivered',
        rawPayload: { provider: 'mock_primary', phone, planCode, amountNgn, operator, idempotencyKey },
      };
    },
    async inquireElectricityMeter(meterNumber, disco, meterType) {
      return {
        customerName: 'Adebayo Ogunlesi',
        meterNumber,
        disco,
        discoName: 'Ikeja Electric',
        meterType,
        minimumAmountNgn: 1000,
        address: '12 Marina Street, Lagos Island',
      };
    },
    async payElectricityBill(meterNumber, disco, meterType, amountNgn, customerName, idempotencyKey) {
      primaryCallCount++;
      return {
        reference: `ref_prim_elec_${Date.now()}`,
        amountNgn,
        meterNumber,
        disco,
        meterType,
        status: 'success',
        message: 'Mock electricity paid',
        token: '1234-5678-9012-3456-7890',
        units: '35.4 kWh',
        customerName: customerName || 'Adebayo Ogunlesi',
        rawPayload: { provider: 'mock_primary', meterNumber, disco, amountNgn, idempotencyKey },
      };
    },
  };

  const mockSecondary: IUtilityProvider = {
    name: 'mock_secondary',
    supports: ['airtime'],
    priority: 5,
    async purchaseAirtime(phone, amountNgn, operator, idempotencyKey) {
      secondaryCallCount++;
      return {
        reference: `ref_sec_${Date.now()}`,
        amountNgn,
        phone,
        operator,
        status: 'success',
        message: 'Mock airtime delivered',
        rawPayload: { provider: 'mock_secondary', phone, amountNgn, operator, idempotencyKey },
      };
    },
    async purchaseDataBundle() { throw new Error('Not supported'); },
    async inquireElectricityMeter() { throw new Error('Not supported'); },
    async payElectricityBill() { throw new Error('Not supported'); },
  };

  registerUtilityProvider(mockPrimary);
  registerUtilityProvider(mockSecondary);

  setUtilityRouting({
    routes: { airtime: ['mock_primary', 'mock_secondary'], data: ['mock_primary'], electricity: ['mock_primary'] },
    failover: { airtime: true, data: false, electricity: false },
  });

  // Seed test data plans
  await updateUtilityDataPlans([
    {
      bundleSize: '1GB',
      costPriceNgn: 250,
      markupNgn: 50,
      amountNgn: 300,
      network: 'mtn',
      isActive: true,
      providerPlanCodes: { mock_primary: 'MTN_1GB_TRANSLATED_CODE' },
      updatedBy: 'resilience_test',
    },
  ]);

  const now = new Date().toISOString();

  // ─── 1. Persistence Failure Halts Dispatch ─────────────────────────
  console.log('══ 1. Persistence Failure Halts Dispatch ══');
  const user0 = 'usr_persistence_fail_0';
  await db.upsertVirtualAccountTransactionRecord({
    id: `vatx_seed_${user0}`,
    provider: 'paystack',
    depositId: `dep_${user0}`,
    userId: user0,
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: '5000.00',
    destinationAmount: '5000.00',
    paymentRail: 'nibss_paystack_dva',
    status: 'completed',
    createdAt: now,
    updatedAt: now,
  });

  const originalUpsert = db.upsertVirtualAccountTransactionRecord.bind(db);
  let reservationWriteIntercepted = false;
  const preCallCount = primaryCallCount;

  // Intercept reservation persistence
  (db as any).upsertVirtualAccountTransactionRecord = async (record: any) => {
    if (record.id && record.id.startsWith('vatx_res_')) {
      reservationWriteIntercepted = true;
      throw new Error('SIMULATED_DB_ERROR: Failed to write reservation record');
    }
    return originalUpsert(record);
  };

  let halted = false;
  try {
    await executeAirtimePurchase({
      userId: user0,
      phone: '08031234567',
      amountNgn: 1000,
      operator: 'mtn',
      channel: 'webapp',
    });
  } catch (err: any) {
    halted = true;
    assert.match(err.message, /Failed to persist balance reservation/);
  } finally {
    (db as any).upsertVirtualAccountTransactionRecord = originalUpsert;
  }

  assert.ok(halted, 'Must throw error when reservation persistence fails');
  assert.ok(reservationWriteIntercepted, 'Reservation write was intercepted');
  assert.equal(
    primaryCallCount,
    preCallCount,
    'Provider MUST NEVER be called if reservation could not be persisted'
  );
  ok('Security rule verified: Provider dispatch was halted because reservation persistence failed');

  // ─── 2. Concurrency Double-Spend Prevention ─────────────────────────
  console.log('\n══ 2. Concurrency Double-Spend Prevention ══');
  const user1 = 'usr_concurrency_race_1';
  await db.upsertVirtualAccountTransactionRecord({
    id: `vatx_seed_${user1}`,
    provider: 'paystack',
    depositId: `dep_${user1}`,
    userId: user1,
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: '1500.00',
    destinationAmount: '1500.00',
    paymentRail: 'nibss_paystack_dva',
    status: 'completed',
    createdAt: now,
    updatedAt: now,
  });

  const [resA, resB] = await Promise.allSettled([
    executeAirtimePurchase({
      userId: user1,
      phone: '08031234567',
      amountNgn: 1000,
      operator: 'mtn',
      channel: 'webapp',
    }),
    executeAirtimePurchase({
      userId: user1,
      phone: '08031234567',
      amountNgn: 1000,
      operator: 'mtn',
      channel: 'webapp',
    }),
  ]);

  const successes = [resA, resB].filter((r) => r.status === 'fulfilled');
  const failures = [resA, resB].filter((r) => r.status === 'rejected');

  assert.equal(successes.length, 1, 'Exactly one concurrent purchase must succeed');
  assert.equal(failures.length, 1, 'Exactly one concurrent purchase must fail');
  assert.match(
    (failures[0] as PromiseRejectedResult).reason.message,
    /Insufficient balance/,
    'Second purchase rejected with insufficient balance'
  );
  assert.equal(await getUserNgnBalance(user1), 500, 'Remaining balance is exactly 500 NGN');
  ok('Race condition prevented: exactly one 1,000 NGN purchase succeeded, second rejected');

  // ─── 3. Durable Idempotency Across Simulated Reboot ────────────────
  console.log('\n══ 3. Durable Idempotency Across Simulated Reboot ══');
  const user2 = 'usr_concurrency_reboot_2';
  await db.upsertVirtualAccountTransactionRecord({
    id: `vatx_seed_${user2}`,
    provider: 'paystack',
    depositId: `dep_${user2}`,
    userId: user2,
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: '10000.00',
    destinationAmount: '10000.00',
    paymentRail: 'nibss_paystack_dva',
    status: 'completed',
    createdAt: now,
    updatedAt: now,
  });

  const idemKey = `idem_test_${Date.now()}`;
  const firstReceipt = await executeAirtimePurchase({
    userId: user2,
    phone: '08039876543',
    amountNgn: 2000,
    operator: 'mtn',
    idempotencyKey: idemKey,
    channel: 'whatsapp',
  });

  assert.ok(firstReceipt.reference);
  assert.equal(await getUserNgnBalance(user2), 8000);

  // Re-execute with identical key and identical payload
  const secondReceipt = await executeAirtimePurchase({
    userId: user2,
    phone: '08039876543',
    amountNgn: 2000,
    operator: 'mtn',
    idempotencyKey: idemKey,
    channel: 'whatsapp',
  });

  assert.equal(secondReceipt.reference, firstReceipt.reference, 'Must return identical reference');
  assert.equal(await getUserNgnBalance(user2), 8000, 'Balance must remain 8,000 NGN without second debit');
  ok('Durable idempotency verified: exact receipt returned with zero extra debit');

  // ─── 4. Idempotency Conflict on Conflicting Payload (409) ───────────
  console.log('\n══ 4. Idempotency Conflict on Conflicting Payload ══');
  let conflictCaught = false;
  try {
    await executeAirtimePurchase({
      userId: user2,
      phone: '08039876543',
      amountNgn: 3000, // Different amount with same key!
      operator: 'mtn',
      idempotencyKey: idemKey,
      channel: 'whatsapp',
    });
  } catch (err: any) {
    conflictCaught = true;
    assert.match(err.message, /conflicting purchase parameters/i);
    assert.equal(err.statusCode || err.status, 409);
  }
  assert.ok(conflictCaught, 'Reusing key with different amount must throw 409 conflict');
  ok('Idempotency integrity verified: conflicting payload rejected with 409 Conflict');

  // ─── 5. Idempotency Ownership Verification (403) ───────────────────
  console.log('\n══ 5. Idempotency Ownership Verification ══');
  const userOther = 'usr_another_attacker_9';
  let forbiddenCaught = false;
  try {
    await executeAirtimePurchase({
      userId: userOther,
      phone: '08039876543',
      amountNgn: 2000,
      operator: 'mtn',
      idempotencyKey: idemKey, // Key created by user2
      channel: 'whatsapp',
    });
  } catch (err: any) {
    forbiddenCaught = true;
    assert.match(err.message, /another user/i);
    assert.equal(err.statusCode || err.status, 403);
  }
  assert.ok(forbiddenCaught, 'Reusing key under different userId must throw 403 forbidden');
  ok('Ownership protocol verified: cross-user key reuse rejected with 403 Forbidden');

  // ─── 6. Strict Failover Guard on Timeout / Unknown Outcome ─────────
  console.log('\n══ 6. Failover Guard on Timeout / Unknown Outcome ══');
  const user3 = 'usr_concurrency_timeout_3';
  await db.upsertVirtualAccountTransactionRecord({
    id: `vatx_seed_${user3}`,
    provider: 'paystack',
    depositId: `dep_${user3}`,
    userId: user3,
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: '5000.00',
    destinationAmount: '5000.00',
    paymentRail: 'nibss_paystack_dva',
    status: 'completed',
    createdAt: now,
    updatedAt: now,
  });

  let timeoutProviderAttempted = false;
  let fallbackProviderAttempted = false;

  const timeoutProvider: IUtilityProvider = {
    name: 'timeout_primary',
    supports: ['airtime'],
    priority: 20,
    async purchaseAirtime() {
      timeoutProviderAttempted = true;
      throw new UtilityProviderError({
        provider: 'timeout_primary',
        reason: 'provider_timeout',
        context: 'purchaseAirtime',
        upstreamMessage: 'Upstream HTTP socket timed out after 10000ms',
      });
    },
    async purchaseDataBundle() { throw new Error('Not supported'); },
    async inquireElectricityMeter() { throw new Error('Not supported'); },
    async payElectricityBill() { throw new Error('Not supported'); },
  };

  const safeFallback: IUtilityProvider = {
    name: 'safe_secondary',
    supports: ['airtime'],
    priority: 10,
    async purchaseAirtime(phone, amountNgn, operator) {
      fallbackProviderAttempted = true;
      return {
        reference: 'ref_should_not_happen',
        amountNgn,
        phone,
        operator,
        status: 'success',
        message: 'Mock fallback delivered',
        rawPayload: {},
      };
    },
    async purchaseDataBundle() { throw new Error('Not supported'); },
    async inquireElectricityMeter() { throw new Error('Not supported'); },
    async payElectricityBill() { throw new Error('Not supported'); },
  };

  registerUtilityProvider(timeoutProvider);
  registerUtilityProvider(safeFallback);

  setUtilityRouting({
    routes: { airtime: ['timeout_primary', 'safe_secondary'], data: ['mock_primary'], electricity: ['mock_primary'] },
    failover: { airtime: true, data: false, electricity: false },
  });

  let threwTimeout = false;
  const timeoutKey = `idem_timeout_${Date.now()}`;
  try {
    await executeAirtimePurchase({
      userId: user3,
      phone: '08031112233',
      amountNgn: 1000,
      operator: 'mtn',
      idempotencyKey: timeoutKey,
      channel: 'minipay',
    });
  } catch (err: any) {
    threwTimeout = true;
    assert.match(err.message, /timed out|Purchase outcome unconfirmed/i);
  }

  assert.ok(threwTimeout, 'Must throw timeout error directly to caller');
  assert.ok(timeoutProviderAttempted, 'Primary timeout provider was attempted');
  assert.equal(
    fallbackProviderAttempted,
    false,
    'Secondary provider must NEVER be called when primary outcome is unknown'
  );
  ok('Failover guard verified: timeout did not fail over to secondary provider');

  // ─── 7. Timeout Hold Retention (Never Refund on Timeout Alone) ─────
  console.log('\n══ 7. Timeout Hold Retention ══');
  // Check transaction status in DB
  const allTxs = await db.listVirtualAccountTransactions();
  const timeoutTx = allTxs.find((tx) => tx.depositReference === timeoutKey || tx.depositId === `res_${timeoutKey}`);
  assert.ok(timeoutTx, 'Reservation record must exist in DB');
  assert.equal(timeoutTx.status, 'pending_reconciliation', 'Reservation must be in pending_reconciliation status');

  // User spendable balance must reflect the held money (5000 - 1000 = 4000)
  const balAfterTimeout = await getUserNgnBalance(user3);
  assert.equal(balAfterTimeout, 4000, 'User spendable balance must hold 1,000 NGN pending reconciliation');
  ok('Ledger integrity verified: hold preserved on timeout, balance is 4,000 NGN pending reconciliation');

  // ─── 8. Confirmed Rejection Atomically Releases Hold ────────────────
  console.log('\n══ 8. Confirmed Rejection Atomically Releases Hold ══');
  const userRejection = 'usr_confirmed_rejection_8';
  await db.upsertVirtualAccountTransactionRecord({
    id: `vatx_seed_${userRejection}`,
    provider: 'paystack',
    depositId: `dep_${userRejection}`,
    userId: userRejection,
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: '5000.00',
    destinationAmount: '5000.00',
    paymentRail: 'nibss_paystack_dva',
    status: 'completed',
    createdAt: now,
    updatedAt: now,
  });

  const rejectingProvider: IUtilityProvider = {
    name: 'rejecting_primary',
    supports: ['airtime'],
    priority: 30,
    async purchaseAirtime() {
      // Explicit business rejection: invalid subscriber line
      const err: any = new Error('Invalid mobile number specified for operator MTN');
      err.statusCode = 400;
      err.code = 'INVALID_RECIPIENT';
      throw err;
    },
    async purchaseDataBundle() { throw new Error('Not supported'); },
    async inquireElectricityMeter() { throw new Error('Not supported'); },
    async payElectricityBill() { throw new Error('Not supported'); },
  };
  registerUtilityProvider(rejectingProvider);

  setUtilityRouting({
    routes: { airtime: ['rejecting_primary'], data: ['mock_primary'], electricity: ['mock_primary'] },
    failover: { airtime: false, data: false, electricity: false },
  });

  let rejectionCaught = false;
  try {
    await executeAirtimePurchase({
      userId: userRejection,
      phone: '08030000000',
      amountNgn: 1500,
      operator: 'mtn',
      channel: 'webapp',
    });
  } catch (err: any) {
    rejectionCaught = true;
    assert.match(err.message, /Invalid mobile number/);
  }

  assert.ok(rejectionCaught, 'Rejection error must propagate to caller');
  const balAfterRejection = await getUserNgnBalance(userRejection);
  assert.equal(balAfterRejection, 5000, 'Balance must be restored to 5,000 NGN after confirmed rejection');
  ok('Confirmed rejection verified: hold released atomically and balance restored to 5,000 NGN');

  // ─── 9. Post-Delivery Database Resilience ───────────────────────────
  console.log('\n══ 9. Post-Delivery Database Resilience ══');
  const user4 = 'usr_concurrency_incident_4';
  await db.upsertVirtualAccountTransactionRecord({
    id: `vatx_seed_${user4}`,
    provider: 'paystack',
    depositId: `dep_${user4}`,
    userId: user4,
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: '5000.00',
    destinationAmount: '5000.00',
    paymentRail: 'nibss_paystack_dva',
    status: 'completed',
    createdAt: now,
    updatedAt: now,
  });

  setUtilityRouting({
    routes: { airtime: ['mock_primary'], data: ['mock_primary'], electricity: ['mock_primary'] },
    failover: { airtime: false, data: false, electricity: false },
  });

  let simulatedDebitErrorTriggered = false;
  (db as any).upsertVirtualAccountTransactionRecord = async (record: any) => {
    if (record.id && record.id.startsWith('vatx_debit_')) {
      simulatedDebitErrorTriggered = true;
      throw new Error('SIMULATED_DB_ERROR: disk failure during post-delivery debit');
    }
    return originalUpsert(record);
  };

  let postDeliveryReceipt: any;
  try {
    postDeliveryReceipt = await executeAirtimePurchase({
      userId: user4,
      phone: '08035556677',
      amountNgn: 1500,
      operator: 'mtn',
      channel: 'webapp',
    });
  } finally {
    (db as any).upsertVirtualAccountTransactionRecord = originalUpsert;
  }

  assert.ok(postDeliveryReceipt.reference, 'Receipt returned with valid reference');
  assert.equal(postDeliveryReceipt.success, true);
  assert.equal(simulatedDebitErrorTriggered, true, 'Simulated debit error occurred');

  // Verify transaction status transitioned to delivery_confirmed_unsettled
  const txList = await db.listVirtualAccountTransactions();
  const unsettledTx = txList.find((tx) => tx.depositId === postDeliveryReceipt.reference);
  assert.ok(unsettledTx, 'Unsettled transaction record must exist');
  assert.equal(unsettledTx.status, 'delivery_confirmed_unsettled');

  // Critical system incident logged
  const incidents = await listSystemIncidents({ status: 'active' });
  const matchIncident = incidents.find(
    (inc) => inc.severity === 'critical' && inc.message.includes(postDeliveryReceipt.reference)
  );
  assert.ok(matchIncident, 'Critical system incident must be created for post-delivery failure');
  ok('Post-delivery resilience verified: customer received receipt, record marked delivery_confirmed_unsettled');

  // ─── 10. Unsettled Purchase Reconciliation ─────────────────────────
  console.log('\n══ 10. Unsettled Purchase Reconciliation ══');
  const reconResult = await reconcileUnsettledUtilityPurchases();
  assert.ok(reconResult.settled.includes(postDeliveryReceipt.reference), 'Unsettled purchase finalized');

  // Verify status is now completed
  const updatedTx = (await db.listVirtualAccountTransactions()).find(
    (tx) => tx.depositId === postDeliveryReceipt.reference
  );
  assert.equal(updatedTx?.status, 'completed', 'Transaction status updated to completed after reconciliation');
  ok('Reconciliation verified: unsettled delivery settled and finalized to completed');

  // ─── 11. Fail-Closed Feature Controls on Database Read Error ───────
  console.log('\n══ 11. Fail-Closed Feature Controls on DB Error ══');
  const originalAuditLogReader = db.latestAuditLogByAction.bind(db);
  (db as any).latestAuditLogByAction = async () => {
    throw new Error('SIMULATED_DB_DOWN: connection pool exhausted');
  };

  let failClosedControls: any;
  try {
    failClosedControls = await getUtilitiesControls();
  } finally {
    (db as any).latestAuditLogByAction = originalAuditLogReader;
  }

  assert.equal(failClosedControls.enabled, false, 'Controls must be disabled when DB read fails');
  assert.equal(failClosedControls.maintenanceMode, true, 'Maintenance mode must be active on DB error');
  assert.match(failClosedControls.maintenanceReason, /Database temporarily unavailable/);
  ok('Fail-closed safety verified: DB read error safely blocks utility purchases in maintenance mode');

  // ─── 12. Data Purchase Catalogue Enforcement ───────────────────────
  console.log('\n══ 12. Data Purchase Catalogue Enforcement ══');
  const user5 = 'usr_data_catalogue_5';
  await db.upsertVirtualAccountTransactionRecord({
    id: `vatx_seed_${user5}`,
    provider: 'paystack',
    depositId: `dep_${user5}`,
    userId: user5,
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: '5000.00',
    destinationAmount: '5000.00',
    paymentRail: 'nibss_paystack_dva',
    status: 'completed',
    createdAt: now,
    updatedAt: now,
  });

  let unconfiguredRejected = false;
  try {
    await executeDataPurchase({
      userId: user5,
      phone: '08031234567',
      planCode: '99GB', // Not in data plan catalogue!
      amountNgn: 1000,
      operator: 'mtn',
      channel: 'webapp',
    });
  } catch (err: any) {
    unconfiguredRejected = true;
    assert.match(err.message, /No data plan "99GB" is configured/);
  }

  assert.ok(unconfiguredRejected, 'Unconfigured plan must be rejected');
  ok('Catalogue enforcement verified: unconfigured plan rejected before provider dispatch');

  // ─── 13. Data Purchase Provider Plan Translation ───────────────────
  console.log('\n══ 13. Data Purchase Provider Plan Translation ══');
  const dataReceipt = await executeDataPurchase({
    userId: user5,
    phone: '08031234567',
    planCode: '1GB',
    amountNgn: 300,
    operator: 'mtn',
    channel: 'webapp',
  });

  assert.ok(dataReceipt.reference);
  assert.equal(dataReceipt.success, true);
  assert.equal(
    lastDispatchedPlanCode,
    'MTN_1GB_TRANSLATED_CODE',
    'Provider must receive translated provider plan code'
  );
  ok('Translation verified: internal bundle size translated to aggregator plan code (MTN_1GB_TRANSLATED_CODE)');

  // ─── 14. Electricity Inquiry and Payment Token Generation ──────────
  console.log('\n══ 14. Electricity Inquiry and Payment Token Generation ══');
  const user6 = 'usr_electricity_test_6';
  await db.upsertVirtualAccountTransactionRecord({
    id: `vatx_seed_${user6}`,
    provider: 'paystack',
    depositId: `dep_${user6}`,
    userId: user6,
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: '10000.00',
    destinationAmount: '10000.00',
    paymentRail: 'nibss_paystack_dva',
    status: 'completed',
    createdAt: now,
    updatedAt: now,
  });

  // Pre-flight inquiry
  const inquiry = await executeElectricityInquiry({
    meterNumber: '01423456789',
    disco: 'ikeja',
    meterType: 'prepaid',
  });
  assert.equal(inquiry.customerName, 'Adebayo Ogunlesi');
  assert.equal(inquiry.discoName, 'Ikeja Electric (IKEDC)');
  ok('Electricity inquiry verified: registered customer name resolved');

  // Token payment
  const elecReceipt = await executeElectricityPayment({
    userId: user6,
    meterNumber: '01423456789',
    disco: 'ikeja',
    meterType: 'prepaid',
    amountNgn: 3000,
    customerName: inquiry.customerName,
    channel: 'webapp',
  });

  assert.ok(elecReceipt.reference);
  assert.equal(elecReceipt.token, '1234-5678-9012-3456-7890');
  assert.equal(elecReceipt.units, '35.4 kWh');
  assert.match(elecReceipt.formattedText, /Token: 1234-5678-9012-3456-7890/);
  assert.equal(await getUserNgnBalance(user6), 7000);
  ok('Electricity payment verified: 20-digit prepaid token generated and balance debited to 7,000 NGN');

  // ─── 15. Fail-Closed Idempotency Lookups ───────────────────────────
  console.log('\n══ 15. Fail-Closed Idempotency Lookups ══');
  const userFailClosed = 'usr_fail_closed_idem_15';
  await db.upsertVirtualAccountTransactionRecord({
    id: `vatx_seed_${userFailClosed}`,
    provider: 'paystack',
    depositId: `dep_${userFailClosed}`,
    userId: userFailClosed,
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: '5000.00',
    destinationAmount: '5000.00',
    paymentRail: 'nibss_paystack_dva',
    status: 'completed',
    createdAt: now,
    updatedAt: now,
  });

  const originalListRecords = (db as any).listVirtualAccountTransactions.bind(db);
  (db as any).listVirtualAccountTransactions = async () => {
    throw new Error('SIMULATED_DB_DOWN: connection pool dead');
  };

  let failClosedThrew = false;
  try {
    await executeAirtimePurchase({
      userId: userFailClosed,
      phone: '08031234567',
      amountNgn: 1000,
      operator: 'mtn',
      idempotencyKey: 'idem_fail_closed_test_key',
      channel: 'webapp',
    });
  } catch (err: any) {
    failClosedThrew = true;
    assert.equal(err.status || err.statusCode, 503, 'Must throw 503 Service Unavailable');
    assert.match(err.message, /Database error while verifying idempotency records/);
  } finally {
    (db as any).listVirtualAccountTransactions = originalListRecords;
  }

  assert.ok(failClosedThrew, 'Idempotency lookup failure must halt dispatch and throw 503');
  assert.equal(await getUserNgnBalance(userFailClosed), 5000, 'Zero funds debited when DB is down');
  ok('Fail-closed idempotency verified: DB read error throws 503 and prevents purchase dispatch');

  // ─── 16. Ambiguous Non-Timeout Unknown Error Retains Balance Hold ──
  console.log('\n══ 16. Ambiguous Non-Timeout Unknown Error Retains Balance Hold ══');
  const userUnknownErr = 'usr_unknown_err_16';
  await db.upsertVirtualAccountTransactionRecord({
    id: `vatx_seed_${userUnknownErr}`,
    provider: 'paystack',
    depositId: `dep_${userUnknownErr}`,
    userId: userUnknownErr,
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: '5000.00',
    destinationAmount: '5000.00',
    paymentRail: 'nibss_paystack_dva',
    status: 'completed',
    createdAt: now,
    updatedAt: now,
  });

  const crashProvider: IUtilityProvider = {
    name: 'crash_primary',
    supports: ['airtime'],
    priority: 50,
    async purchaseAirtime() {
      // Simulate unhandled server crash / 500 from provider gateway
      const err: any = new Error('HTTP 500 Internal Server Error from aggregator upstream');
      err.status = 500;
      throw err;
    },
  };
  registerUtilityProvider(crashProvider);
  setUtilityRouting({
    routes: { airtime: ['crash_primary'], data: ['mock_primary'], electricity: ['mock_primary'] },
    failover: { airtime: false, data: false, electricity: false },
  });

  const unknownErrKey = `idem_unknown_err_${Date.now()}`;
  let unknownErrThrew = false;
  try {
    await executeAirtimePurchase({
      userId: userUnknownErr,
      phone: '08031234567',
      amountNgn: 1000,
      operator: 'mtn',
      idempotencyKey: unknownErrKey,
      channel: 'webapp',
    });
  } catch (err: any) {
    unknownErrThrew = true;
    assert.match(err.message, /Purchase outcome unconfirmed/i);
  }

  assert.ok(unknownErrThrew, 'Must throw unconfirmed outcome error to caller');

  // Verify transaction status is pending_reconciliation (not failed!)
  const allTxs16 = await db.listVirtualAccountTransactions();
  const unknownTx = allTxs16.find((tx) => tx.depositReference === unknownErrKey || tx.depositId === `res_${unknownErrKey}`);
  assert.ok(unknownTx, 'Reservation record must exist in DB');
  assert.equal(unknownTx.status, 'pending_reconciliation', 'Reservation must be in pending_reconciliation status');

  // User spendable balance must retain the hold (5000 - 1000 = 4000)
  const balAfterCrash = await getUserNgnBalance(userUnknownErr);
  assert.equal(balAfterCrash, 4000, 'User balance must hold 1,000 NGN pending reconciliation');
  ok('Hold preservation verified: non-timeout unknown error retains hold in pending_reconciliation');

  // ─── 17. Paystack Outbound Idempotency Reference Forwarding ─────────
  console.log('\n══ 17. Paystack Outbound Idempotency Reference Forwarding ══');
  const { purchaseAirtime: paystackPurchaseAirtime } = await import('../src/ngn/provider/paystack-utility.provider.js');
  const originalFetch = global.fetch;
  let capturedPaystackPayload: any = null;
  global.fetch = async (url: any, init: any) => {
    if (String(url).includes('/bill/charge')) {
      capturedPaystackPayload = JSON.parse(init.body);
      return new Response(JSON.stringify({
        status: true,
        message: 'Charge successful',
        data: {
          reference: capturedPaystackPayload.reference,
          status: 'success',
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(url, init);
  };

  try {
    const testKey = 'idem_forwarded_paystack_ref_888';
    const paystackRes = await paystackPurchaseAirtime('08031234567', 1000, 'mtn', testKey);
    assert.ok(capturedPaystackPayload, 'Paystack payload was sent');
    assert.equal(capturedPaystackPayload.reference, testKey, 'Paystack reference must equal exact idempotencyKey');
    assert.equal(paystackRes.reference, testKey, 'Result reference must equal exact idempotencyKey');
    ok('Paystack reference forwarding verified: caller idempotencyKey directly forwarded into outbound payload.reference');
  } finally {
    global.fetch = originalFetch;
  }

  // ─── 18. Connected Reconciliation Operational Process ───────────────
  console.log('\n══ 18. Connected Reconciliation Operational Process ══');
  const reconResult18 = await reconcileUnsettledUtilityPurchases();
  assert.ok(Array.isArray(reconResult18.settled), 'settled must be an array');
  assert.ok(Array.isArray(reconResult18.failed), 'failed must be an array');
  assert.ok(Array.isArray(reconResult18.pendingReconciliation), 'pendingReconciliation must be an array');

  // The pending_reconciliation record from Suite 16 must be tracked
  const foundPending = reconResult18.pendingReconciliation.find((ref) =>
    ref === `res_${unknownErrKey}` || ref === unknownErrKey
  );
  assert.ok(foundPending, 'pending_reconciliation record from Suite 16 must be tracked in reconciliation');
  ok('Connected reconciliation verified: reconcileUnsettledUtilityPurchases tracks pending reconciliation and unsettled deliveries');

  console.log('\n======================================================');
  console.log('🎉 ALL 18 UTILITY CONCURRENCY & RESILIENCE TESTS PASSED');
  console.log('======================================================\n');
}

run().catch((err) => {
  console.error('\n❌ RESILIENCE TEST SUITE FAILED:', err);
  process.exit(1);
});
