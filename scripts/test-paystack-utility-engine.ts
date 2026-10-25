/**
 * SIVAN MULTI-PROVIDER UTILITY ENGINE TEST SUITE
 *
 * Verifies:
 * 1. Telco prefix auto-detection (MTN, Airtel, Glo, 9mobile) & phone normalization.
 * 2. Balance enforcement & atomic ledger debit.
 * 3. Airtime top-up execution & formatted receipt generation (Paystack default).
 * 4. Per-service provider routing, capability refusal and scoped failover.
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
process.env.IDENTITY_LINK_SERVICE_SECRET = 'test_service_secret_for_utility_routes';
process.env.UTILITY_ROUTING = JSON.stringify({
  routes: { airtime: ['paystack'], data: ['paystack'], electricity: ['paystack'] },
  failover: { airtime: false, data: false, electricity: false },
});

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import {
  classifySmeApiMessage,
  canFailOver,
  statusForReason,
  customerMessageForReason,
} from '../src/ngn/provider/utility-provider.error.js';
import {
  canAfford,
  recordFloatProbe,
  recordFloatSpend,
  recordFloatExhausted,
  __resetFloatCache,
} from '../src/ngn/provider/provider-float-cache.js';
import { listUtilityProviders } from '../src/ngn/provider/utility-registry.js';

function startPaystackStub(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      res.setHeader('content-type', 'application/json');

      if (path === '/bill/charge') {
        const isElectricity = !!body.meter_number;
        const ref = body.reference || `paystack_ref_${Date.now()}`;
        res.writeHead(200);
        return res.end(
          JSON.stringify({
            status: true,
            message: isElectricity ? 'Electricity charged' : 'Charge successful',
            data: {
              reference: ref,
              amount: body.amount,
              customer_name: isElectricity ? 'ADEKUNLE OLA (SIVAN TEST HOLDER)' : undefined,
              token: isElectricity ? '4521-8930-1124-7839-9021' : undefined,
              units: isElectricity ? '34.2' : undefined,
              plan: body.plan,
            },
          })
        );
      }

      if (path === '/bill/validate') {
        const disco = url.searchParams.get('service_type') || '';
        const discoName = disco.toLowerCase() === 'abuja' ? 'Abuja Electricity' : 'Ikeja Electric';
        res.writeHead(200);
        return res.end(
          JSON.stringify({
            status: true,
            message: 'Meter validated',
            data: {
              meter_number: url.searchParams.get('meter_number') || '45012345678',
              provider_name: discoName,
              customer_name: 'ADEKUNLE OLA (SIVAN TEST HOLDER)',
              address: '12 Marina, Lagos',
              minimum_amount: 1000,
            },
          })
        );
      }

      res.writeHead(404);
      res.end(JSON.stringify({ status: false, message: `stub: unknown path ${path}` }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  console.log('\n==================================================');
  console.log('🔷 SIVAN MULTI-PROVIDER UTILITY ENGINE TEST SUITE');
  console.log('==================================================\n');

  const stubServer = await startPaystackStub();
  const stubPort = (stubServer.address() as AddressInfo).port;
  process.env.PAYSTACK_ALLOW_INSECURE_BASE_URL = 'true';
  process.env.PAYSTACK_BASE_URL = `http://127.0.0.1:${stubPort}`;

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
  const { updateUtilityDataPlans, getUtilityDataPlanBySize } = await import(
    '../src/ngn/service/utility-data-plans.service.js'
  );
  const { setWithdrawalPin } = await import('../src/identity/withdrawal-pin.service.js');
  const {
    setUtilityRouting,
    getProviderChainForService,
    listUtilityProviderCapabilities,
  } = await import('../src/ngn/provider/utility-registry.js');
  const { setUtilityRoutingConfig } = await import('../src/ngn/service/utility-routing.service.js');

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
  assert.ok(availableProviders.includes('smeapi'));
  assert.ok(!availableProviders.includes('vtu_ng'));
  ok('registry lists the real fulfilment providers (paystack, smeapi)');

  // The simulator fabricates a successful vend, so reaching it in production
  // means debiting a customer who receives nothing. It is opt in only.
  assert.ok(!availableProviders.includes('nomba'));
  assert.ok(!availableProviders.includes('mock'));
  ok('simulator absent unless UTILITY_ENABLE_MOCK_PROVIDER is set');

  const defaultProv = getUtilityProvider();
  assert.equal(defaultProv.name, 'paystack');
  ok('default provider resolves to paystack');

  const capabilities = listUtilityProviderCapabilities();
  const smeapiCap = capabilities.find((c) => c.name === 'smeapi');
  assert.ok(smeapiCap);
  assert.deepEqual([...smeapiCap!.supports].sort(), ['airtime', 'data']);
  ok('smeapi declares airtime and data only, never electricity');

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
  console.log('\n══ 5. Per-Service Routing, Capability Refusal & Scoped Failover ══');

  // A telco-only aggregator must never be handed a meter. The registry
  // refuses the configuration rather than discovering it at purchase time.
  await assert.rejects(
    () => setUtilityRoutingConfig({ routes: { electricity: ['smeapi'] } }, 'test-suite'),
    /does not support electricity/
  );
  ok('routing electricity to an airtime-only provider is refused');

  setUtilityRouting({
    routes: { airtime: ['paystack'], data: ['paystack'], electricity: ['paystack'] },
    failover: { airtime: true, data: true, electricity: false },
  });
  assert.equal(getProviderChainForService('airtime')[0].name, 'paystack');
  ok('each service resolves to its own configured primary');

  // Failover is opt in per service: electricity issues a token, so a blind
  // second attempt elsewhere is how a customer pays twice for one token.
  assert.equal(getProviderChainForService('electricity').length, 1);
  ok('electricity runs with failover disabled');

  const routedAirtimeReceipt = await executeAirtimePurchase({
    userId: testUserId,
    phone: '08021234567', // Airtel
    amountNgn: 1000,
    idempotencyKey: 'idem_routed_airtime_1',
  });

  assert.equal(routedAirtimeReceipt.success, true);
  assert.equal(routedAirtimeReceipt.providerName, 'paystack');
  ok('airtime fulfils through the routed provider, not a caller-supplied one');

  // Exact same key returns cached receipt without double debiting
  const repeatedReceipt = await executeAirtimePurchase({
    userId: testUserId,
    phone: '08021234567',
    amountNgn: 1000,
    idempotencyKey: 'idem_routed_airtime_1',
  });
  assert.equal(repeatedReceipt.reference, routedAirtimeReceipt.reference);
  ok('repeated airtime purchase with same idempotencyKey returns cached receipt');

  const balanceAfterRouted = await getUserNgnBalance(testUserId);
  assert.equal(balanceAfterRouted, 23000);
  ok('user balance debited accurately across the routed rail exactly once');

  // ─── 6. Mobile Data Bundle Purchase ───────────────────────────────
  console.log('\n══ 6. Data Bundle Purchase ══');

  // A bundle nobody has configured cannot be sold. Previously an unknown plan
  // code fell through to the caller's own amountNgn, which let a client both
  // invent a product and set its price.
  await assert.rejects(
    () =>
      executeDataPurchase({
        userId: testUserId,
        phone: '08021234567',
        planCode: 'NOT_A_REAL_BUNDLE',
        amountNgn: 2500,
      }),
    /No data plan .* is configured/
  );
  ok('an unconfigured bundle is refused instead of being priced by the caller');

  // A bundle that is priced but deliberately never mapped to any provider.
  // Mappings are merged and never removed, so this stays unmapped on re-runs.
  await updateUtilityDataPlans(
    [{ bundleSize: '7GB', costPriceNgn: 2600, amountNgn: 3000, network: 'airtel', isActive: true, updatedBy: 'utility_engine_test' }],
    'utility_engine_test'
  );
  await assert.rejects(
    () =>
      executeDataPurchase({
        userId: testUserId,
        phone: '08021234567',
        planCode: '7GB',
        amountNgn: 3000,
      }),
    /has no plan code mapped for provider/
  );
  ok('a bundle with no provider plan code is refused, not sent upstream blind');

  // The sellable bundle: priced, and mapped to the identifier the provider
  // itself uses. Both halves are required before anything can be dispatched.
  await updateUtilityDataPlans(
    [
      {
        bundleSize: '5GB',
        costPriceNgn: 2000,
        amountNgn: 2500,
        network: 'airtel',
        isActive: true,
        providerPlanCodes: { paystack: 'AIRTEL_5GB_MONTHLY' },
        updatedBy: 'utility_engine_test',
      },
    ],
    'utility_engine_test'
  );

  const dataReceipt = await executeDataPurchase({
    userId: testUserId,
    phone: '08021234567', // Auto-detected as Airtel
    planCode: '5GB',
    // Deliberately wrong: the catalogue price must win over the caller's figure.
    amountNgn: 9999,
  });

  assert.equal(dataReceipt.success, true);
  assert.equal(dataReceipt.operatorOrDisco, 'AIRTEL');
  assert.equal(dataReceipt.amountNgn, 2500);
  assert.match(dataReceipt.formattedText, /AIRTEL_5GB_MONTHLY/);
  assert.match(dataReceipt.formattedText, /Remaining Balance: 20,500 NGN/);
  ok('data bundle purchased at the catalogue price, not the caller-supplied one');

  const balanceAfterData = await getUserNgnBalance(testUserId);
  assert.equal(balanceAfterData, 20500);
  ok('user balance atomically debited by 2,500 NGN');

  const configuredPlan = await getUtilityDataPlanBySize('5GB', 'airtel');
  assert.ok(configuredPlan);
  assert.equal(configuredPlan.costPriceNgn, 2000);
  assert.equal(configuredPlan.markupNgn, 500);
  ok('margin is derived from the real synced cost, never typed in');

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

  const SECRET = { 'x-sivan-identity-link-secret': 'test_service_secret_for_utility_routes' };
  const TEST_PIN = '135790';

  // ─── Authentication: the namespace must not be reachable anonymously ──
  const anonBal = await app.inject({
    method: 'GET',
    url: `/api/ngn/utility/balance/${testUserId}`,
  });
  assert.equal(anonBal.statusCode, 403);
  ok('anonymous balance read is refused');

  const anonAirtime = await app.inject({
    method: 'POST',
    url: '/api/ngn/utility/airtime',
    payload: { userId: testUserId, phone: '08051234567', amountNgn: 500 },
  });
  assert.equal(anonAirtime.statusCode, 403);
  ok('anonymous airtime purchase is refused, so money cannot move unauthenticated');

  // ─── PIN: the service secret authenticates the bot, not the person ────
  const noPin = await app.inject({
    method: 'POST',
    url: '/api/ngn/utility/airtime',
    headers: SECRET,
    payload: { userId: testUserId, phone: '08051234567', amountNgn: 500 },
  });
  assert.equal(noPin.statusCode, 400);
  // The bots read details.code, same as the p2p transfer flow does.
  assert.equal(noPin.json().error?.details?.code, 'PIN_NOT_SET');
  ok('a user with no PIN is told to set one rather than being charged');

  await setWithdrawalPin(testUserId, { pin: TEST_PIN });

  const stillNoPin = await app.inject({
    method: 'POST',
    url: '/api/ngn/utility/airtime',
    headers: SECRET,
    payload: { userId: testUserId, phone: '08051234567', amountNgn: 500 },
  });
  assert.equal(stillNoPin.statusCode, 400);
  assert.equal(stillNoPin.json().error?.details?.code, 'PIN_REQUIRED');
  ok('a user who has a PIN is asked for it, not sent to settings');

  const wrongPin = await app.inject({
    method: 'POST',
    url: '/api/ngn/utility/airtime',
    headers: SECRET,
    payload: { userId: testUserId, phone: '08051234567', amountNgn: 500, pin: '000000' },
  });
  assert.ok(wrongPin.statusCode >= 400, 'an incorrect PIN must not purchase');
  ok('an incorrect PIN is rejected');

  // Balance Check Route
  const balRes = await app.inject({
    method: 'GET',
    url: `/api/ngn/utility/balance/${testUserId}`,
    headers: SECRET,
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
    headers: SECRET,
    payload: {
      userId: testUserId,
      phone: '08051234567', // Glo
      amountNgn: 500,
      pin: TEST_PIN,
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
    headers: SECRET,
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
    headers: SECRET,
    payload: {
      userId: testUserId,
      meterNumber: '01234567890',
      disco: 'abuja',
      meterType: 'prepaid',
      amountNgn: 2000,
      pin: TEST_PIN,
    },
  });
  assert.equal(payRes.statusCode, 200);
  assert.ok(payRes.json().data.token);
  ok('POST /api/ngn/utility/electricity/pay endpoint succeeds');

  // ===========================================================================
  // SECTION 7: Provider failure classification
  //
  // Every upstream string asserted here was produced by the live SME API, not
  // copied from its documentation. The provider reports business failures as
  // HTTP 200 with { status: 'fail', msg }, so this prose is the only signal
  // available and these tests are what stop it drifting unnoticed.
  // ===========================================================================
  console.log('\n--- Section 7: provider failure classification ---');

  assert.equal(
    classifySmeApiMessage('Your wallet balance is insufficient for this purchase. Please fund your wallet and try again.'),
    'provider_float_exhausted'
  );
  assert.equal(
    classifySmeApiMessage('Insufficient balance fund your wallet and try again'),
    'provider_float_exhausted'
  );
  ok('both live phrasings of an empty float classify as provider_float_exhausted');

  assert.equal(classifySmeApiMessage('Please enter a valid 11 digit phone number'), 'invalid_recipient');
  assert.equal(classifySmeApiMessage('The Data Plan ID : 999999 is invalid '), 'invalid_plan');
  assert.equal(classifySmeApiMessage('Invalid or inactive authorization token.'), 'provider_auth_failed');
  ok('recipient, plan and auth failures are told apart');

  /**
   * THE ASSERTION THIS WHOLE SECTION EXISTS FOR.
   *
   * When the provider says "insufficient balance" it means OUR wallet with
   * them. A customer holding plenty of naira who is told they have
   * insufficient funds will not retry - they will stop trusting the ledger.
   * So no provider-side failure may produce a message that talks about money
   * the customer holds, and none may repeat the vendor's own sentence.
   */
  for (const reason of [
    'provider_float_exhausted',
    'provider_auth_failed',
    'provider_unavailable',
    'provider_timeout',
    'upstream_declined',
  ] as const) {
    const message = customerMessageForReason(reason).toLowerCase();
    assert.ok(!message.includes('balance'), `${reason} message must not mention balance: "${message}"`);
    assert.ok(!message.includes('insufficient'), `${reason} message must not say insufficient: "${message}"`);
    assert.ok(!message.includes('wallet'), `${reason} message must not mention a wallet: "${message}"`);
    assert.ok(!message.includes('sme'), `${reason} message must not name the provider: "${message}"`);
    assert.ok(statusForReason(reason) !== 500, `${reason} must not be reported as a server crash`);
  }
  ok('no provider-side failure message mentions the customer balance or names the vendor');

  /**
   * Failing over after a timeout can pay twice for one sale: the first
   * provider may already have delivered and simply not told us.
   */
  assert.equal(canFailOver('provider_timeout'), false);
  assert.equal(canFailOver('invalid_recipient'), false);
  assert.equal(canFailOver('invalid_plan'), false);
  assert.equal(canFailOver('provider_float_exhausted'), true);
  assert.equal(canFailOver('upstream_declined'), true);
  ok('ambiguous and deterministic failures are not retried on another provider');

  assert.equal(statusForReason('invalid_recipient'), 400);
  assert.equal(statusForReason('invalid_plan'), 409);
  assert.equal(statusForReason('provider_float_exhausted'), 503);
  ok('each failure maps to a status that matches whose problem it is');

  // ===========================================================================
  // SECTION 8: Pre-flight float check
  //
  // The whole design constraint here is that this must never be the thing that
  // refuses a sale. These assertions are mostly about what it DOES NOT do.
  // ===========================================================================
  console.log('\n--- Section 8: pre-flight float check ---');

  __resetFloatCache();
  assert.equal(canAfford('smeapi', 395), 'unknown');
  ok('an empty cache answers unknown, never no');

  recordFloatProbe('smeapi', 10_000);
  assert.equal(canAfford('smeapi', 395), 'yes');
  recordFloatProbe('smeapi', 100);
  assert.equal(canAfford('smeapi', 395), 'no');
  ok('a measured balance decides affordability in both directions');

  recordFloatProbe('smeapi', 10_000);
  recordFloatExhausted('smeapi');
  assert.equal(canAfford('smeapi', 1), 'no');
  ok('a provider declining for want of funds overrides a healthy earlier reading');

  /**
   * An estimate derived by subtracting spends is not a measurement, so it only
   * refuses when it is clear of the line. Otherwise drift, or any spend we
   * failed to observe, would eventually take a healthy provider out of
   * rotation with no upstream ever having complained.
   */
  __resetFloatCache();
  recordFloatProbe('smeapi', 1_000);
  recordFloatSpend('smeapi', 400);
  assert.equal(canAfford('smeapi', 500), 'no');
  assert.equal(canAfford('smeapi', 50), 'yes');
  ok('an optimistic estimate keeps a safety margin before refusing');

  /**
   * THE GUARANTEE THAT MATTERS.
   *
   * With every routed provider marked broke, a purchase must still be
   * attempted. A cache that is stale, wrong, or simply never populated must
   * not be able to refuse traffic the provider would have accepted - the
   * fallback is the behaviour we had before the cache existed.
   */
  __resetFloatCache();
  for (const name of listUtilityProviders()) recordFloatExhausted(name);
  const failOpen = await app.inject({
    method: 'POST',
    url: '/api/ngn/utility/airtime',
    headers: SECRET,
    payload: { userId: testUserId, phone: '08051234567', amountNgn: 100, pin: TEST_PIN },
  });
  assert.equal(
    failOpen.statusCode,
    200,
    `fail-open violated: cache said every provider was broke and the purchase was refused (${failOpen.body})`
  );
  ok('a purchase still goes through when the cache claims every provider is broke');
  __resetFloatCache();

  await app.close();
  await new Promise<void>((resolve) => stubServer.close(() => resolve()));

  console.log('\n==================================================');
  console.log(`📊 RESULTS: ${passed} passed, 0 failed`);
  console.log('==================================================\n');
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
