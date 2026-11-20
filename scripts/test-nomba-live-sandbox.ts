import dotenv from 'dotenv';
dotenv.config({ path: '.env.staging' });
dotenv.config({ path: '.env-sandbox' });
dotenv.config();

const accountId = (
  process.env.NOMBA_ACCOUNT_ID ||
  process.env.NOMBA_TEST_ACCOUNT_ID ||
  '1dc450d3-7a92-48dd-8276-342eddb062c0'
).trim();

const clientId = (
  process.env.NOMBA_CLIENT_ID ||
  process.env.NOMBA_TEST_CLIENT_ID ||
  '1024c75d-4923-4945-9055-e1ab3f6435e9'
).trim();

const clientSecret = (
  process.env.NOMBA_CLIENT_SECRET ||
  process.env.NOMBA_TEST_CLIENT_SECRET ||
  process.argv[2] ||
  ''
).trim();

// If sandbox credentials, use sandbox base URL:
const baseUrls = [
  'https://sandbox.nomba.com/v1',
  'https://api.nomba.com/v1',
];

async function testNombaLive() {
  console.log('========================================');
  console.log('SIVAN AI . NOMBA SANDBOX LIVE PROOF');
  console.log('========================================');
  console.log(`Account ID:  ${accountId}`);
  console.log(`Client ID:   ${clientId}`);
  console.log(`Secret Len:  ${clientSecret ? clientSecret.length : 0} chars`);

  if (!clientSecret) {
    console.error('\nERROR: NOMBA_CLIENT_SECRET (Private Key) is missing.');
    console.error('Please pass it as an argument: npx tsx scripts/test-nomba-live-sandbox.ts <PRIVATE_KEY>');
    console.error('or set NOMBA_CLIENT_SECRET in .env.staging');
    process.exit(1);
  }

  let token = '';
  let activeBase = '';

  for (const base of baseUrls) {
    console.log(`\n--- Step 1: Testing OAuth Token Issue on ${base} ---`);
    try {
      const res = await fetch(`${base}/auth/token/issue`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          accountId: accountId,
        },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });

      console.log(`HTTP Status: ${res.status} ${res.statusText}`);
      const data = await res.json().catch(() => null);
      console.log('Response:', JSON.stringify(data, null, 2));

      const payload = data?.data || data || {};
      const foundToken = payload.access_token || payload.accessToken || payload.token;

      if (res.ok && foundToken) {
        token = String(foundToken);
        activeBase = base;
        console.log(`SUCCESS: Acquired OAuth Bearer Token from ${base}!`);
        break;
      }
    } catch (err: any) {
      console.warn(`Attempt on ${base} failed:`, err.message);
    }
  }

  if (!token) {
    console.error('\nFAILED: Could not acquire Bearer token from Nomba. Check credentials.');
    process.exit(1);
  }

  const authHeaders = {
    Authorization: `Bearer ${token}`,
    accountId: accountId,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  console.log(`\n--- Step 2: Fetching Bank List from ${activeBase} ---`);
  try {
    const res = await fetch(`${activeBase}/transfers/banks`, {
      method: 'GET',
      headers: authHeaders,
    });
    console.log(`HTTP Status: ${res.status}`);
    const data = (await res.json().catch(() => null)) as any;
    const banks = data?.data?.results || data?.data || [];
    console.log(`Total banks returned: ${Array.isArray(banks) ? banks.length : 0}`);
    if (Array.isArray(banks) && banks.length > 0) {
      console.log('Sample bank:', banks[0]);
    }
  } catch (err: any) {
    console.warn('Bank list fetch failed:', err.message);
  }

  console.log(`\n--- Step 3: Testing Account Lookup from ${activeBase} ---`);
  try {
    const res = await fetch(`${activeBase}/transfers/bank/lookup`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        accountNumber: '0123456789',
        bankCode: '058',
      }),
    });
    console.log(`HTTP Status: ${res.status}`);
    const data = await res.json().catch(() => null);
    console.log('Lookup Response:', JSON.stringify(data, null, 2));
  } catch (err: any) {
    console.warn('Lookup test note:', err.message);
  }

  console.log(`\n--- Step 4: Testing Virtual Account Creation on /accounts/virtual from ${activeBase} ---`);
  try {
    const res = await fetch(`${activeBase}/accounts/virtual`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        accountRef: `sivan_test_${Date.now()}`,
        currency: 'NGN',
        accountName: 'Sivan Test User',
      }),
    });
    console.log(`HTTP Status: ${res.status}`);
    const data = await res.json().catch(() => null);
    console.log('Virtual Account Response:', JSON.stringify(data, null, 2));
  } catch (err: any) {
    console.warn('Virtual account test note:', err.message);
  }

  console.log(`\n--- Step 5: Testing Outward Transfer Endpoint on ${activeBase.replace(/\/v1$/, '/v2')}/transfers/bank ---`);
  try {
    const transferBase = activeBase.replace(/\/v1$/, '/v2');
    const res = await fetch(`${transferBase}/transfers/bank`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        amount: 100,
        accountNumber: '0123456789',
        accountName: 'Elijah Isabella',
        bankCode: '058',
        merchantTxRef: `sivan_payout_test_${Date.now()}`,
        senderName: 'Sivan Technologies',
        narration: 'Test Payout Sandbox',
      }),
    });
    console.log(`HTTP Status: ${res.status}`);
    const data = await res.json().catch(() => null);
    console.log('Transfer Response:', JSON.stringify(data, null, 2));
  } catch (err: any) {
    console.warn('Transfer test note:', err.message);
  }

  console.log(`\n--- Step 6: Testing Checkout Order on ${activeBase}/checkout/order ---`);
  try {
    const res = await fetch(`${activeBase}/checkout/order`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        order: {
          orderReference: `sivan_order_${Date.now()}`,
          amount: 5000,
          currency: 'NGN',
          customerEmail: 'buyer@sivantech.online',
          callbackUrl: 'https://staging.sivantech.online/agreements/callback',
          allowedPaymentMethods: ['Transfer', 'USSD'],
        },
      }),
    });
    console.log(`HTTP Status: ${res.status}`);
    const data = await res.json().catch(() => null);
    console.log('Checkout Order Response:', JSON.stringify(data, null, 2));
  } catch (err: any) {
    console.warn('Checkout test note:', err.message);
  }

  console.log('\n========================================');
  console.log('NOMBA SANDBOX LIVE PROOF COMPLETED!');
  console.log('========================================');
}

testNombaLive().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

