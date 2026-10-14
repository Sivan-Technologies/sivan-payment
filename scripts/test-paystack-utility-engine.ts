/**
 * SIVAN MULTI-PROVIDER UTILITY ENGINE TEST SUITE
 *
 * Verifies:
 * 1. Telco prefix auto-detection (MTN, Airtel, Glo, 9mobile) & phone normalization.
 * 2. Balance enforcement & atomic ledger debit.
 * 3. Airtime top-up execution & formatted receipt generation (Paystack default).
 * 4. Pluggable provider routing (routing via Nomba / failover IUtilityProvider).
 * 5. Data bundle purchase execution.
 * 6. Electricity DisCo pre-flight meter inquiry (customer name resolution).
 * 7. Electricity bill payment & 20-digit prepaid token generation.
 * 8. Fastify HTTP routes via app.inject.
 */

// MUST be configured before any app modules are loaded
process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-paystack-utility-engine.json';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_mock_secret_key_1234567890';
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';

async function main() {
  console.log('\n==================================================');
  console.log('🔷 SIVAN MULTI-PROVIDER UTILITY ENGINE TEST SUITE');
  console.log('==================================================\n');

  // Dynamic import ensures process.env is applied prior to module evaluation
  const { buildApp } = await import('../src/app.js');
  const { db } = await import('../src/database/json-database.js');
  const {
    detectTelcoOperator,
    normalizeDomesticPhone,
  } = await import('../src/ngn/types/paystackUtilityTypes.js');
  const {
    getUserNgnBalance,
    executeAirtimePurchase,
    executeDataPurchase,
    executeElectricityInquiry,
    executeElectricityPayment,
    getUtilityProvider,
    listUtilityProviders,
  } = await import('../src/ngn/service/sivanUtilityService.js');

  let passed = 0;
  function ok(msg: string) {
    passed++;
    console.log(`  ✅ ok - ${msg}`);
  }

  // ─── 1. Telco Prefix Detection & Phone Normalization ──────────────
  console.log('══ 1. Telco Detection & Phone Normalization ══');
  assert.equal(detectTelcoOperator('08031234567'), 'mtn');
  assert.equal(detectTelcoOperator('+2348102524846'), 'mtn');
  assert.equal(detectTelcoOperator('whatsapp:+2348141234567'), 'mtn');
  ok('MTN numbers correctly detected across formats');

  assert.equal(detectTelcoOperator('08021234567'), 'airtel');
  assert.equal(detectTelcoOperator('+2348081234567'), 'airtel');
  assert.equal(detectTelcoOperator('09071234567'), 'airtel');
  ok('Airtel numbers correctly detected');

  assert.equal(detectTelcoOperator('08051234567'), 'glo');
  assert.equal(detectTelcoOperator('+2348151234567'), 'glo');
  ok('Glo numbers correctly detected');

  assert.equal(detectTelcoOperator('08091234567'), '9mobile');
  assert.equal(detectTelcoOperator('+2348181234567'), '9mobile');
  ok('9mobile numbers correctly detected');

  assert.equal(normalizeDomesticPhone('+2348102524846'), '08102524846');
  assert.equal(normalizeDomesticPhone('whatsapp:+2348102524846'), '08102524846');
  ok('domestic phone normalizes cleanly to 08... format');

  // ─── 2. Balance Enforcement & Inflow Seeding ──────────────────────
  console.log('\n══ 2. Balance Verification & Inflow Seeding ══');
  const testUserId = `user_utility_test_${Date.now()}`;
  const initialBalance = await getUserNgnBalance(testUserId);
  assert.equal(initialBalance, 0);
  ok('initial user balance is 0 NGN');

  // Attempting to buy airtime with 0 balance must throw
  await assert.rejects(
    async () => {
      await executeAirtimePurchase({
        userId: testUserId,
        phone: '08102524846',
        amountNgn: 1000,
      });
    },
    /Insufficient balance/,
    'insufficient balance is enforced'
  );
  ok('zero-balance purchase is rejected');

  // Seed 25,000 NGN inflow into virtual account ledger
  const now = new Date().toISOString();
  await db.upsertVirtualAccountTransactionRecord({
    id: `vatx_seed_inflow_${Date.now()}`,
    provider: 'paystack',
    depositId: `dep_seed_${Date.now()}`,
    userId: testUserId,
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: '25000.00',
    destinationAmount: '25000.00',
    paymentRail: 'nibss_paystack_dva',
    status: 'completed',
    createdAt: now,
    updatedAt: now,
  });

  const fundedBalance = await getUserNgnBalance(testUserId);
  assert.equal(fundedBalance, 25000);
  ok('user ledger reflects 25,000 NGN balance');

  // ─── 3. Pluggable Utility Provider Registry ───────────────────────
  console.log('\n══ 3. Pluggable Provider Registry ══');
  const availableProviders = listUtilityProviders();
  assert.ok(availableProviders.includes('paystack'));
  assert.ok(availableProviders.includes('nomba'));
  ok('registry lists paystack and nomba providers');

  const defaultProv = getUtilityProvider();
  assert.equal(defaultProv.name, 'paystack');
  ok('default provider resolves to paystack');

  const nombaProv = getUtilityProvider('nomba');
  assert.equal(nombaProv.name, 'nomba');
  ok('explicit provider request resolves to nomba');

  // ─── 4. Airtime Execution & Atomic Debit (Default Rail) ───────────
  console.log('\n══ 4. Airtime Execution & Atomic Debit ══');
  const airtimeReceipt = await executeAirtimePurchase({
    userId: testUserId,
    phone: '08102524846', // Auto-detected as MTN
    amountNgn: 1000,
  });

  assert.equal(airtimeReceipt.success, true);
  assert.equal(airtimeReceipt.providerName, 'paystack');
  assert.equal(airtimeReceipt.operatorOrDisco, 'MTN');
  assert.equal(airtimeReceipt.recipientOrMeter, '08102524846');
  assert.equal(airtimeReceipt.amountNgn, 1000);
  assert.equal(airtimeReceipt.feeNgn, 0);
  assert.match(airtimeReceipt.formattedText, /MTN/);
  assert.match(airtimeReceipt.formattedText, /Remaining Balance: 24,000 NGN/);
  ok('airtime purchased via Paystack with zero fee and formatted receipt');

  const balanceAfterAirtime = await getUserNgnBalance(testUserId);
  assert.equal(balanceAfterAirtime, 24000);
  ok('user balance atomically debited by exactly 1,000 NGN');

  // ─── 5. Multi-Provider Routing (Fulfillment via Nomba Rail) ───────
  console.log('\n══ 5. Multi-Provider Failover/Routing (Nomba Rail) ══');
  const nombaAirtimeReceipt = await executeAirtimePurchase({
    userId: testUserId,
    phone: '08021234567', // Airtel
    amountNgn: 1000,
    providerName: 'nomba', // Route explicitly to Nomba
  });

  assert.equal(nombaAirtimeReceipt.success, true);
  assert.equal(nombaAirtimeReceipt.providerName, 'nomba');
  assert.match(nombaAirtimeReceipt.formattedText, /Fulfillment Rail: NOMBA/);
  ok('airtime routed to secondary provider (Nomba) without modifying core engine');

  const balanceAfterNomba = await getUserNgnBalance(testUserId);
  assert.equal(balanceAfterNomba, 23000);
  ok('user balance debited accurately across alternative provider rail');

  // ─── 6. Mobile Data Bundle Purchase ───────────────────────────────
  console.log('\n══ 6. Data Bundle Purchase ══');
  const dataReceipt = await executeDataPurchase({
    userId: testUserId,
    phone: '08021234567', // Auto-detected as Airtel
    planCode: 'AIRTEL_5GB_MONTHLY',
    amountNgn: 2500,
  });

  assert.equal(dataReceipt.success, true);
  assert.equal(dataReceipt.operatorOrDisco, 'AIRTEL');
  assert.equal(dataReceipt.amountNgn, 2500);
  assert.match(dataReceipt.formattedText, /AIRTEL_5GB_MONTHLY/);
  assert.match(dataReceipt.formattedText, /Remaining Balance: 20,500 NGN/);
  ok('data bundle purchased and debited');

  const balanceAfterData = await getUserNgnBalance(testUserId);
  assert.equal(balanceAfterData, 20500);
  ok('user balance atomically debited by 2,500 NGN');

  // ─── 7. Electricity Pre-flight Inquiry & Payment ──────────────────
  console.log('\n══ 7. Electricity DisCo Inquiry & Token Issuance ══');
  const meterInquiry = await executeElectricityInquiry({
    userId: testUserId,
    meterNumber: '45012345678',
    disco: 'ikeja',
    meterType: 'prepaid',
  });

  assert.equal(meterInquiry.meterNumber, '45012345678');
  assert.equal(meterInquiry.disco, 'ikeja');
  assert.match(meterInquiry.discoName, /Ikeja Electric/);
  assert.equal(meterInquiry.customerName, 'ADEKUNLE OLA (SIVAN TEST HOLDER)');
  ok('pre-flight inquiry successfully resolves registered customer name');

  // Execute Electricity Bill Payment
  const electricityReceipt = await executeElectricityPayment({
    userId: testUserId,
    meterNumber: '45012345678',
    disco: 'ikeja',
    meterType: 'prepaid',
    amountNgn: 5000,
    customerName: meterInquiry.customerName,
  });

  assert.equal(electricityReceipt.success, true);
  assert.equal(electricityReceipt.serviceType, 'electricity');
  assert.equal(electricityReceipt.amountNgn, 5000);
  assert.equal(electricityReceipt.customerName, 'ADEKUNLE OLA (SIVAN TEST HOLDER)');
  assert.ok(electricityReceipt.token, 'prepaid token generated');
  assert.match(electricityReceipt.token!, /^\d{4}-\d{4}-\d{4}-\d{4}-\d{4}$/);
  assert.match(electricityReceipt.formattedText, /Token: 4521-8930-1124-7839-9021/);
  assert.match(electricityReceipt.formattedText, /Remaining Balance: 15,500 NGN/);
  ok('20-digit prepaid electricity token issued with formatted receipt');

  const balanceAfterElectricity = await getUserNgnBalance(testUserId);
  assert.equal(balanceAfterElectricity, 15500);
  ok('user balance atomically debited by 5,000 NGN');

  // ─── 8. Fastify HTTP Endpoints ────────────────────────────────────
  console.log('\n══ 8. Fastify HTTP Endpoints ══');
  const app = await buildApp();

  // Balance Check Route
  const balRes = await app.inject({
    method: 'GET',
    url: `/api/ngn/utility/balance/${testUserId}`,
  });
  assert.equal(balRes.statusCode, 200);
  const balJson = balRes.json();
  assert.equal(balJson.status, 'success');
  assert.equal(balJson.data.spendableBalanceNgn, 15500);
  ok('GET /api/ngn/utility/balance/:userId returns accurate spendable balance');

  // HTTP Airtime Top-Up
  const airtimeRes = await app.inject({
    method: 'POST',
    url: '/api/ngn/utility/airtime',
    payload: {
      userId: testUserId,
      phone: '08051234567', // Glo
      amountNgn: 500,
    },
  });
  assert.equal(airtimeRes.statusCode, 200);
  assert.equal(airtimeRes.json().data.operatorOrDisco, 'GLO');
  assert.equal(airtimeRes.json().data.amountNgn, 500);
  ok('POST /api/ngn/utility/airtime endpoint succeeds');

  // HTTP Electricity Pre-flight Inquiry
  const inqRes = await app.inject({
    method: 'POST',
    url: '/api/ngn/utility/electricity/inquire',
    payload: {
      userId: testUserId,
      meterNumber: '01234567890',
      disco: 'abuja',
      meterType: 'prepaid',
    },
  });
  assert.equal(inqRes.statusCode, 200);
  assert.match(inqRes.json().data.discoName, /Abuja Electricity/);
  ok('POST /api/ngn/utility/electricity/inquire endpoint succeeds');

  // HTTP Electricity Payment
  const payRes = await app.inject({
    method: 'POST',
    url: '/api/ngn/utility/electricity/pay',
    payload: {
      userId: testUserId,
      meterNumber: '01234567890',
      disco: 'abuja',
      meterType: 'prepaid',
      amountNgn: 2000,
    },
  });
  assert.equal(payRes.statusCode, 200);
  assert.ok(payRes.json().data.token);
  ok('POST /api/ngn/utility/electricity/pay endpoint succeeds');

  await app.close();

  console.log('\n==================================================');
  console.log(`📊 RESULTS: ${passed} passed, 0 failed`);
  console.log('==================================================\n');
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
