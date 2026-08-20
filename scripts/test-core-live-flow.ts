import fetch from 'node-fetch';

async function testCoreLiveFlow() {
  const CORE_URL = 'https://test-sivan.sivantech.online';
  const CORE_SECRET = 'Yu3w1j5s-I7SgaxBNOAVcaUrW0SpkrlKoo7zppgnMrI';

  console.log('=== Step 1: Check Core Gateway Health ===');
  const healthRes = await fetch(`${CORE_URL}/health`);
  console.log('Health:', healthRes.status, await healthRes.json());

  console.log('\n=== Step 2: Create Live Service Agreement for USDC ===');
  const buyer = '+2348079604214'; // linked phone or test buyer
  const seller = '+2348000000002'; // test seller

  const createPayload = {
    creatorWhatsapp: buyer,
    buyerWhatsapp: buyer,
    sellerWhatsapp: seller,
    amount: 1,
    currency: 'USDC',
    purpose: 'End-to-End Live USDC Service Agreement Test',
    feePayer: 'buyer',
  };

  const createRes = await fetch(`${CORE_URL}/api/escrows`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-secret': CORE_SECRET,
      'x-core-api-secret': CORE_SECRET,
    },
    body: JSON.stringify(createPayload),
  });

  const createData: any = await createRes.json();
  console.log('Create Agreement Response Code:', createRes.status);
  console.log('Create Agreement Response Body:', JSON.stringify(createData, null, 2));

  if (!createRes.ok || !createData.escrow) {
    console.error('Failed to create Service Agreement');
    return;
  }

  const escrowId = createData.escrow.escrowId;
  console.log(`\n=== Step 3: Accept Service Agreement as Seller (${seller}) ===`);
  const acceptRes = await fetch(`${CORE_URL}/api/escrows/${escrowId}/accept`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-secret': CORE_SECRET,
      'x-core-api-secret': CORE_SECRET,
    },
    body: JSON.stringify({ actorWhatsapp: seller }),
  });
  const acceptData: any = await acceptRes.json();
  console.log('Accept Response Code:', acceptRes.status);
  console.log('Accept Response Body:', JSON.stringify(acceptData, null, 2));

  console.log(`\n=== Step 4: Request Payment Instruction as Buyer (${buyer}) ===`);
  const payRes = await fetch(`${CORE_URL}/api/escrows/${escrowId}/payment-instruction`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-secret': CORE_SECRET,
      'x-core-api-secret': CORE_SECRET,
    },
    body: JSON.stringify({ actorWhatsapp: buyer }),
  });
  const payData: any = await payRes.json();
  console.log('Payment Instruction Code:', payRes.status);
  console.log('Payment Instruction Body:', JSON.stringify(payData, null, 2));

  console.log(`\n=== Step 5: Query Live Service Agreement State ===`);
  const statusRes = await fetch(`${CORE_URL}/api/escrows/${escrowId}?actorWhatsapp=${encodeURIComponent(buyer)}`, {
    headers: {
      'x-api-secret': CORE_SECRET,
      'x-core-api-secret': CORE_SECRET,
    },
  });
  const statusData: any = await statusRes.json();
  console.log('Agreement Status Code:', statusRes.status);
  console.log('Agreement Status Body:', JSON.stringify(statusData, null, 2));
}

testCoreLiveFlow().catch(console.error);
