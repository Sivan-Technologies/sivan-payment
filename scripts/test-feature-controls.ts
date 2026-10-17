process.env.DATABASE_MODE = 'test';
process.env.DATABASE_URL = '';
import Fastify from 'fastify';
import { adminRoutes } from '../src/admin/admin.routes.js';
import { moneygramRoutes } from '../src/moneygram/routes/moneygram.routes.js';
import { updateMoneyGramControls } from '../src/admin/feature-controls.service.js';

async function run() {
  console.log('SIVAN PAYMENT — FEATURE CONTROLS & DYNAMIC FLAG TEST SUITE\n');

  const app = Fastify();
  await adminRoutes(app);
  await moneygramRoutes(app);

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`  ok   ${msg}`);
      passed++;
    } else {
      console.error(`  FAIL ${msg}`);
      failed++;
    }
  }

  try {
    // 1. Check initial public feature status
    const pubStatusRes = await app.inject({
      method: 'GET',
      url: '/api/features/status',
    });
    assert(pubStatusRes.statusCode === 200, 'GET /api/features/status returns HTTP 200');
    const pubData = JSON.parse(pubStatusRes.body).data;
    assert(pubData.moneygram.enabled === true, 'MoneyGram is enabled by default');
    assert(pubData.moneygram.minipayEnabled === true, 'MoneyGram MiniPay is enabled by default');
    assert(pubData.utilities.enabled === true, 'Sivan Utilities is enabled by default');

    // 2. Fetch admin MoneyGram controls
    const mgAdminRes = await app.inject({
      method: 'GET',
      url: '/api/admin/moneygram/controls',
    });
    assert(mgAdminRes.statusCode === 200, 'GET /api/admin/moneygram/controls returns HTTP 200');
    const mgControls = JSON.parse(mgAdminRes.body).data;
    assert(Array.isArray(mgControls.corridors), 'MoneyGram corridors array returned');

    // 3. Create a session on minipay channel when enabled
    const sessionRes = await app.inject({
      method: 'POST',
      url: '/api/moneygram/session',
      payload: {
        amount: 25,
        targetCurrency: 'NGN',
        channel: 'minipay',
        userAddressOrId: '0x4a1A9cf30A86b2b333D1a743181aAE71a50BAFBc',
      },
    });
    assert(sessionRes.statusCode === 200, 'POST /api/moneygram/session succeeds when enabled');
    const sessionData = JSON.parse(sessionRes.body).data;
    assert(sessionData.amount === '25.00', 'Session created with realistic 25.00 USDC');

    // 4. Disable MiniPay channel in MoneyGram controls
    const updateRes = await app.inject({
      method: 'PUT',
      url: '/api/admin/moneygram/controls',
      payload: {
        minipayEnabled: false,
      },
    });
    assert(updateRes.statusCode === 200, 'PUT /api/admin/moneygram/controls updates status');
    assert(JSON.parse(updateRes.body).data.minipayEnabled === false, 'minipayEnabled is now false');

    // 5. Verify public feature status reflects change
    const pubStatusUpdated = await app.inject({
      method: 'GET',
      url: '/api/features/status',
    });
    const pubDataUpdated = JSON.parse(pubStatusUpdated.body).data;
    assert(pubDataUpdated.moneygram.minipayEnabled === false, 'Public status shows minipayEnabled is false');

    // 6. Verify session creation on minipay channel is now blocked
    const blockedRes = await app.inject({
      method: 'POST',
      url: '/api/moneygram/session',
      payload: {
        amount: 25,
        channel: 'minipay',
      },
    });
    assert(blockedRes.statusCode === 403, 'POST /api/moneygram/session rejected with HTTP 403 when MiniPay disabled');

    // 7. Re-enable MiniPay channel
    await updateMoneyGramControls({ minipayEnabled: true });

    // 8. Test Sivan Utilities controls
    const utilRes = await app.inject({
      method: 'GET',
      url: '/api/admin/utilities/controls',
    });
    assert(utilRes.statusCode === 200, 'GET /api/admin/utilities/controls returns HTTP 200');
    const utilData = JSON.parse(utilRes.body).data;
    assert(utilData.airtimeEnabled === true && utilData.electricityEnabled === true, 'Utilities airtime and electricity enabled');

    // 9. Query transactions list
    const mgTxRes = await app.inject({
      method: 'GET',
      url: '/api/admin/moneygram/transactions',
    });
    assert(mgTxRes.statusCode === 200, 'GET /api/admin/moneygram/transactions returns HTTP 200');
    const txList = JSON.parse(mgTxRes.body).data;
    assert(txList.length > 0, 'Transactions list contains logged transactions');

  } catch (err: any) {
    console.error('Test execution error:', err);
    failed++;
  } finally {
    await app.close();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run();
