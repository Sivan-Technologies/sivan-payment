import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env.staging') });
dotenv.config({ path: path.resolve(__dirname, '../.env-sandbox') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const accountId = (process.env.NOMBA_ACCOUNT_ID || process.env.NOMBA_TEST_ACCOUNT_ID || '').trim();
const clientId = (process.env.NOMBA_CLIENT_ID || process.env.NOMBA_TEST_CLIENT_ID || '').trim();
const clientSecret = (process.env.NOMBA_CLIENT_SECRET || process.env.NOMBA_TEST_CLIENT_SECRET || '').trim();

const isSandbox = (process.env.APP_ENV || 'staging') !== 'production';
const baseUrl = isSandbox ? 'https://sandbox.nomba.com' : 'https://api.nomba.com';

console.log('Nomba Bills Probe:');
console.log('Base URL:', baseUrl);
console.log('Account ID:', accountId);
console.log('Client ID:', clientId ? `${clientId.slice(0, 8)}...` : 'missing');

async function getAccessToken(): Promise<string> {
  const url = `${baseUrl}/v1/auth/token/issue`;
  const res = await fetch(url, {
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
  const data = await res.json() as any;
  const token = data?.data?.access_token || data?.data?.accessToken || data?.access_token;
  if (!token) throw new Error('Token error: ' + JSON.stringify(data));
  return token;
}

async function main() {
  try {
    const token = await getAccessToken();
    console.log('✓ Token obtained successfully');

    // 1. Fetch Discos
    console.log('\n--- 1. Testing GET /v1/bill/electricity/discos ---');
    const discosRes = await fetch(`${baseUrl}/v1/bill/electricity/discos`, {
      headers: {
        accountId: accountId,
        Authorization: `Bearer ${token}`,
      },
    });
    const discosData = await discosRes.json() as any;
    console.log('Discos Status:', discosRes.status, discosData.code, discosData.description);
    if (Array.isArray(discosData.data)) {
      console.log(`✓ Received ${discosData.data.length} DisCos:`, discosData.data.map((d: any) => d.id).join(', '));
    } else {
      console.log('Discos payload:', JSON.stringify(discosData));
    }

    // 2. Electricity Lookup
    console.log('\n--- 2. Testing GET /v2/bill/electricity/lookup ---');
    const lookupRes = await fetch(`${baseUrl}/v2/bill/electricity/lookup?disco=phed&customerId=12347899`, {
      headers: {
        accountId: accountId,
        Authorization: `Bearer ${token}`,
      },
    });
    const lookupData = await lookupRes.json() as any;
    console.log('Electricity Lookup Status:', lookupRes.status, lookupData.code, lookupData.description);
    console.log('Lookup Data:', JSON.stringify(lookupData.data || lookupData));

    // 3. Cable TV Products (DSTV)
    console.log('\n--- 3. Testing GET /v1/bill/cableTvProduct?cableTvType=dstv ---');
    const cableRes = await fetch(`${baseUrl}/v1/bill/cableTvProduct?cableTvType=dstv`, {
      headers: {
        accountId: accountId,
        Authorization: `Bearer ${token}`,
      },
    });
    const cableData = await cableRes.json() as any;
    console.log('Cable TV Products Status:', cableRes.status, cableData.code, cableData.description);
    if (Array.isArray(cableData.data)) {
      console.log(`✓ Received ${cableData.data.length} DSTV plans:`, cableData.data.slice(0, 3));
    } else {
      console.log('Cable TV payload:', JSON.stringify(cableData));
    }

    // 4. Cable TV Lookup
    console.log('\n--- 4. Testing GET /v1/bill/cabletv/lookup ---');
    const cableLookupRes = await fetch(`${baseUrl}/v1/bill/cabletv/lookup?cableTvType=dstv&customerId=123909200`, {
      headers: {
        accountId: accountId,
        Authorization: `Bearer ${token}`,
      },
    });
    const cableLookupData = await cableLookupRes.json() as any;
    console.log('Cable TV Lookup Status:', cableLookupRes.status, cableLookupData.code, cableLookupData.description);
    console.log('Cable TV Lookup Data:', JSON.stringify(cableLookupData.data || cableLookupData));

    // 5. Electricity Payment
    console.log('\n--- 5. Testing POST /v2/bill/electricity ---');
    const electPayRes = await fetch(`${baseUrl}/v2/bill/electricity`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accountId: accountId,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        disco: 'ikeja',
        merchantTxRef: `sivan_elec_${Date.now()}`,
        payerName: 'John Doe',
        amount: 2000,
        customerId: '01234567890',
        meterType: 'PREPAID',
      }),
    });
    const electPayData = await electPayRes.json() as any;
    console.log('Electricity Payment Status:', electPayRes.status, electPayData.code, electPayData.description);
    console.log('Electricity Token:', electPayData?.data?.meta?.phcnToken || electPayData?.data?.meta?.phcnVendToken || 'n/a');
    console.log('Electricity Units:', electPayData?.data?.meta?.phcnVendUnits || electPayData?.data?.meta?.units || 'n/a');
    console.log('Full payment response data:', JSON.stringify(electPayData?.data?.meta || electPayData));

    // 6. Cable TV Payment
    console.log('\n--- 6. Testing POST /v2/bill/cabletv ---');
    const cablePayRes = await fetch(`${baseUrl}/v2/bill/cabletv`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accountId: accountId,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        cableTvType: 'dstv',
        merchantTxRef: `sivan_cable_${Date.now()}`,
        payerName: 'John Doe',
        amount: 2000,
        customerId: '123909200',
      }),
    });
    const cablePayData = await cablePayRes.json() as any;
    console.log('Cable TV Payment Status:', cablePayRes.status, cablePayData.code, cablePayData.description);
    console.log('Full cable payment response:', JSON.stringify(cablePayData?.data || cablePayData));

    // 7. Testing Airtime Topup
    console.log('\n--- 7. Testing POST /v2/bill/topup (Airtime) ---');
    const airtimeRes = await fetch(`${baseUrl}/v2/bill/topup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accountId: accountId,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        amount: 100,
        phoneNumber: '08123456788',
        network: 'MTN',
        merchantTxRef: `sivan_airtime_${Date.now()}`,
        senderName: 'Sivan Customer',
      }),
    });
    const airtimeData = await airtimeRes.json() as any;
    console.log('Airtime Status:', airtimeRes.status, airtimeData.code, airtimeData.description);
    console.log('Airtime Response:', JSON.stringify(airtimeData?.data || airtimeData));

    // 8. Testing Data Plans (MTN)
    console.log('\n--- 8. Testing GET /v1/bill/data-plan/mtn ---');
    const dataPlansRes = await fetch(`${baseUrl}/v1/bill/data-plan/mtn`, {
      headers: {
        accountId: accountId,
        Authorization: `Bearer ${token}`,
      },
    });
    const dataPlansData = await dataPlansRes.json() as any;
    console.log('Data Plans Status:', dataPlansRes.status, dataPlansData.code, dataPlansData.description);
    let sampleProductId = 'example-plan-id-1';
    if (Array.isArray(dataPlansData.data) && dataPlansData.data.length > 0) {
      console.log(`✓ Received ${dataPlansData.data.length} MTN Data plans. First 3:`, dataPlansData.data.slice(0, 3));
      sampleProductId = dataPlansData.data[0].productId || sampleProductId;
    } else {
      console.log('Data Plans Response:', JSON.stringify(dataPlansData));
    }

    // 9. Testing Data Bundle Purchase
    console.log(`\n--- 9. Testing POST /v2/bill/data with productId: ${sampleProductId} ---`);
    const dataVendRes = await fetch(`${baseUrl}/v2/bill/data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accountId: accountId,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        productId: sampleProductId,
        phoneNumber: '08123456788',
        network: 'MTN',
        merchantTxRef: `sivan_data_${Date.now()}`,
        senderName: 'Sivan Customer',
      }),
    });
    const dataVendData = await dataVendRes.json() as any;
    console.log('Data Vend Status:', dataVendRes.status, dataVendData.code, dataVendData.description);
    console.log('Data Vend Response:', JSON.stringify(dataVendData?.data || dataVendData));

    // 10. Testing Betting Providers
    console.log('\n--- 10. Testing GET /v1/bill/betting/providers ---');
    const bettingProvidersRes = await fetch(`${baseUrl}/v1/bill/betting/providers`, {
      headers: {
        accountId: accountId,
        Authorization: `Bearer ${token}`,
      },
    });
    const bettingProvidersData = await bettingProvidersRes.json() as any;
    console.log('Betting Providers Status:', bettingProvidersRes.status, bettingProvidersData.code, bettingProvidersData.description);
    let sampleBettingId = 'bet9ja';
    if (Array.isArray(bettingProvidersData.data) && bettingProvidersData.data.length > 0) {
      console.log(`✓ Received ${bettingProvidersData.data.length} Betting providers. First 3:`, bettingProvidersData.data.slice(0, 3));
      sampleBettingId = bettingProvidersData.data[0].id || bettingProvidersData.data[0].lookup_id || sampleBettingId;
    } else {
      console.log('Betting Providers Response:', JSON.stringify(bettingProvidersData));
    }

    // 11. Testing Betting Customer Lookup
    console.log(`\n--- 11. Testing GET /v1/bill/betting/lookup?providerId=${sampleBettingId}&customerId=1234567890 ---`);
    const bettingLookupRes = await fetch(`${baseUrl}/v1/bill/betting/lookup?providerId=${encodeURIComponent(sampleBettingId)}&customerId=1234567890`, {
      headers: {
        accountId: accountId,
        Authorization: `Bearer ${token}`,
      },
    });
    const bettingLookupData = await bettingLookupRes.json() as any;
    console.log('Betting Lookup Status:', bettingLookupRes.status, bettingLookupData.code, bettingLookupData.description);
    console.log('Betting Customer Name:', JSON.stringify(bettingLookupData.data || bettingLookupData));

    // 12. Testing Betting Wallet Funding (Payment)
    console.log('\n--- 12. Testing POST /v2/bill/betting ---');
    const bettingPayRes = await fetch(`${baseUrl}/v2/bill/betting`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accountId: accountId,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        bettingProvider: sampleBettingId,
        merchantTxRef: `sivan_bet_${Date.now()}`,
        phoneNumber: '09012345678',
        payerName: 'John Doe',
        amount: 2000,
        customerId: '1234567890',
      }),
    });
    const bettingPayData = await bettingPayRes.json() as any;
    console.log('Betting Payment Status:', bettingPayRes.status, bettingPayData.code, bettingPayData.description);
    console.log('Betting Payment Response:', JSON.stringify(bettingPayData?.data || bettingPayData));

  } catch (err: any) {
    console.error('Probe failed:', err.message || err);
  }
}

main();
