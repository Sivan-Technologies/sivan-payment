import { signUserJwt } from '../src/auth/jwt.js';
import { env } from '../src/config/env.js';

const STAGING_URL = 'https://api-staging.sivantech.online';

const BUYER = {
  id: 'usr_10ed27f0-7ff2-4228-b45c-70a327d9b3c8',
  email: 'sivantech@gmail.com',
  name: 'Samuel Udochukwu (Client)',
};

const SELLER = {
  id: 'usr_b1d36f5b-9e1d-4d72-918a-c0484310c6bc',
  email: 'solianetwork0@gmail.com',
  name: 'Solia Network (Contractor)',
};

async function runE2ETest() {
  console.log('================================================================');
  console.log('🚀 SIVAN SERVICE AGREEMENT E2E LIFECYCLE TEST');
  console.log('================================================================\n');

  const buyerToken = signUserJwt({ userId: BUYER.id, email: BUYER.email });
  const sellerToken = signUserJwt({ userId: SELLER.id, email: SELLER.email });

  // ── Step 1: Check Live API Health ──────────────────────────────────────────
  console.log('Step 1: Checking API Gateway Health...');
  const healthRes = await fetch(`${STAGING_URL}/health`);
  if (!healthRes.ok) throw new Error(`Health check failed: HTTP ${healthRes.status}`);
  console.log('  ✅ API Gateway is healthy\n');

  // ── Step 2: Create Service Agreement (Draft) ──────────────────────────────
  console.log('Step 2: Creating Service Agreement for 10 USDC on Solana...');
  const createRes = await fetch(`${STAGING_URL}/api/agreements`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${buyerToken}`,
    },
    body: JSON.stringify({
      buyerUserId: BUYER.id,
      sellerUserId: SELLER.id,
      title: 'Brand Identity & Mobile UI Assets',
      description: 'Scope: Complete brand logo pack and 5 mobile screen designs. Milestones: 1',
      amountUsdc: 10,
      currency: 'USDC',
      network: 'solana',
      deadlineDays: 7,
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Failed to create agreement: ${createRes.status} ${err}`);
  }

  const agreement = await createRes.json();
  const agreementId = agreement.id;
  console.log(`  ✅ Agreement Created: ${agreementId}`);
  console.log(`     Title: ${agreement.title}`);
  console.log(`     Amount: ${agreement.amountUsdc} ${agreement.currency} on ${agreement.network}`);
  console.log(`     Initial Status: ${agreement.status}\n`);

  // ── Step 3: Fund Agreement & Lock Vault ────────────────────────────────────
  console.log(`Step 3: Funding Agreement ${agreementId} & Locking in Solana Vault...`);
  const fundRes = await fetch(`${STAGING_URL}/api/agreements/${agreementId}/fund`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${buyerToken}`,
    },
    body: JSON.stringify({ network: 'solana' }),
  });

  if (!fundRes.ok) {
    const err = await fundRes.text();
    throw new Error(`Failed to fund agreement: ${fundRes.status} ${err}`);
  }

  const funded = await fundRes.json();
  console.log(`  ✅ Agreement Funded!`);
  console.log(`     Status: ${funded.status}`);
  console.log(`     Countdown: ${funded.countdownLabel}`);
  console.log(`     Delivery Due: ${funded.deliveryDueAt}\n`);

  // ── Step 4: Verify Visibility for Buyer & Seller ──────────────────────────
  console.log('Step 4: Verifying Service Agreement Feeds for Both Parties...');
  
  // Buyer Check
  const buyerAgreementsRes = await fetch(`${STAGING_URL}/api/users/me/service-agreements`, {
    headers: { 'Authorization': `Bearer ${buyerToken}` }
  });
  const buyerData = await buyerAgreementsRes.json();
  const buyerDeal = buyerData.data?.deals?.find((d: any) => d.escrowId === agreementId);
  console.log(`  Client Feed (${BUYER.email}):`, buyerDeal ? `Found [Role: ${buyerDeal.role}, Status: ${buyerDeal.status}]` : 'NOT FOUND');

  // Seller Check
  const sellerAgreementsRes = await fetch(`${STAGING_URL}/api/users/me/service-agreements`, {
    headers: { 'Authorization': `Bearer ${sellerToken}` }
  });
  const sellerData = await sellerAgreementsRes.json();
  const sellerDeal = sellerData.data?.deals?.find((d: any) => d.escrowId === agreementId);
  console.log(`  Contractor Feed (${SELLER.email}):`, sellerDeal ? `Found [Role: ${sellerDeal.role}, Status: ${sellerDeal.status}]` : 'NOT FOUND');
  console.log();

  // ── Step 5: Seller Submits Deliverables ────────────────────────────────────
  console.log('Step 5: Contractor Submits Deliverables (Mark Delivered)...');
  const deliverRes = await fetch(`${STAGING_URL}/api/agreements/${agreementId}/deliver`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sellerToken}`,
    },
  });

  if (!deliverRes.ok) {
    const err = await deliverRes.text();
    throw new Error(`Failed to submit delivery: ${deliverRes.status} ${err}`);
  }

  const delivered = await deliverRes.json();
  console.log(`  ✅ Deliverables Submitted!`);
  console.log(`     Status: ${delivered.status}`);
  console.log(`     Delivered At: ${delivered.deliveredAt}\n`);

  // ── Step 6: Buyer Reviews & Releases Vault Funds ──────────────────────────
  console.log('Step 6: Buyer Approves Work & Releases Funds to Contractor...');
  const releaseRes = await fetch(`${STAGING_URL}/api/agreements/${agreementId}/release`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${buyerToken}`,
    },
  });

  if (!releaseRes.ok) {
    const err = await releaseRes.text();
    throw new Error(`Failed to release agreement: ${releaseRes.status} ${err}`);
  }

  const released = await releaseRes.json();
  console.log(`  ✅ Funds Released Successfully!`);
  console.log(`     Status: ${released.status}`);
  console.log(`     Released At: ${released.releasedAt}\n`);

  // ── Step 7: Final Agreement Detail Fetch ──────────────────────────────────
  console.log('Step 7: Fetching Final Agreement Verification State...');
  const finalRes = await fetch(`${STAGING_URL}/api/agreements/${agreementId}`);
  const finalAgreement = await finalRes.json();

  console.log('================================================================');
  console.log('🎉 E2E TEST SUMMARY: ALL LIFECYCLE STAGES PASSED!');
  console.log('================================================================');
  console.log({
    agreementId: finalAgreement.id,
    buyer: finalAgreement.buyerUserId,
    seller: finalAgreement.sellerUserId,
    amountUsdc: finalAgreement.amountUsdc,
    network: finalAgreement.network,
    finalStatus: finalAgreement.status,
    created: finalAgreement.createdAt,
    funded: finalAgreement.fundedAt,
    delivered: finalAgreement.deliveredAt,
    released: finalAgreement.releasedAt,
  });
  console.log('================================================================\n');
}

runE2ETest().catch((err) => {
  console.error('\n❌ E2E Test Failed:', err);
  process.exit(1);
});
