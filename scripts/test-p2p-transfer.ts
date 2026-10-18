import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';

export async function runP2pTransferTest() {
  console.log('--- Starting P2P Direct Transfer Integration Test ---');

  // Unique run suffix so each test run creates fresh users on a persistent Postgres DB
  const runId = Date.now();
  const senderUsername = `sender_tester_${runId}`;
  const recipUsername = `samson_micheal_${runId}`;
  const newbieUsername = `newbie_claimant_${runId}`;

  const app = await buildApp();

  async function signup(name: string, username: string) {
    const email = `${username.toLowerCase().replace(/_/g, '')}@sivan.test`;
    const startRes = await app.inject({
      method: 'POST',
      url: '/api/auth/email/start',
      payload: {
        email,
        fullName: name,
        intent: 'signup',
        legalAcceptance: { accepted: true, termsVersion: 'test', privacyVersion: 'test', riskDisclosureVersion: 'test' },
      },
    });
    const startJson = startRes.json();
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/api/auth/email/verify',
      payload: { email, code: startJson.data.devCode },
    });
    const authData = verifyRes.json().data;
    const token = authData.token;
    const user = authData.user;

    // Set custom username — ignore 409 (already taken) since we use unique run IDs
    await app.inject({
      method: 'PUT',
      url: `/api/users/${user.id}/username`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { username },
    });

    return { user, token, username };
  }

  const senderSignup = await signup('Sender User', senderUsername);
  const recipSignup = await signup('Samson Micheal', recipUsername);

  const senderUser = senderSignup.user;
  const recipUser = recipSignup.user;

  // Set sender PIN
  const setPinRes = await app.inject({
    method: 'POST',
    url: '/api/users/me/withdrawal-pin',
    headers: { Authorization: `Bearer ${senderSignup.token}` },
    payload: { pin: '829471' },
  });
  assert.equal(setPinRes.statusCode, 200, 'Sender PIN setup succeeded');

  // Credit sender with 50,000 NGN via admin adjustment (backed by Paystack float)
  const creditRes = await app.inject({
    method: 'POST',
    url: '/api/admin/balance/adjustments',
    headers: { 'x-admin-api-key': env.ADMIN_API_KEY },
    payload: {
      userId: senderUser.id,
      asset: 'ngn',
      amount: 50000,
      status: 'available',
      reason: 'Initial test funding for NGN P2P test',
    },
  });
  assert.equal(creditRes.statusCode, 200, 'Admin funding succeeded');

  // Ensure P2P transfers are enabled for this test run (may be disabled in persistent DB)
  const enableP2pRes = await app.inject({
    method: 'PUT',
    url: '/api/admin/balance/controls',
    headers: { 'x-admin-api-key': env.ADMIN_API_KEY },
    payload: { p2pTransfersEnabled: true, updatedBy: 'p2p_test_setup' },
  });
  assert.equal(enableP2pRes.statusCode, 200, `P2P transfers enabled: ${enableP2pRes.body}`);

  // Test 1: Resolve recipient by @username
  const resolveTagRes = await app.inject({
    method: 'GET',
    url: `/api/identity/resolve-target?target=@${recipUsername}`,
  });
  assert.equal(resolveTagRes.statusCode, 200);
  const resolveTagJson = resolveTagRes.json();
  assert.equal(resolveTagJson.data.found, true);
  assert.equal(resolveTagJson.data.user.userId, recipUser.id);
  console.log(`✅ Verified: Resolved recipient by @${recipUsername}`);

  // Test 2: Resolve recipient by userId
  const resolveIdRes = await app.inject({
    method: 'GET',
    url: `/api/identity/resolve-target?target=${recipUser.id}`,
  });
  assert.equal(resolveIdRes.statusCode, 200);
  const resolveIdJson = resolveIdRes.json();
  assert.equal(resolveIdJson.data.found, true);
  assert.equal(resolveIdJson.data.user.userId, recipUser.id);
  console.log(`✅ Verified: Resolved recipient by userId ${recipUser.id}`);

  // Test 2b: USDC internal transfer is blocked (requires on-chain send via blockchain resolver)
  const usdcAttempt = await app.inject({
    method: 'POST',
    url: `/api/users/${senderUser.id}/balance/p2p-transfer`,
    headers: { Authorization: `Bearer ${senderSignup.token}` },
    payload: {
      asset: 'usdc',
      amount: 15,
      recipientTarget: `@${recipUsername}`,
      pin: '829471',
    },
  });
  assert.equal(usdcAttempt.statusCode, 400, 'USDC internal P2P is blocked');
  console.log('✅ Verified: Internal USDC P2P blocked (on-chain transfer required for crypto)');

  // Test 3: Execute NGN P2P Transfer (15,000 NGN) with $0 Fee
  const transferRes = await app.inject({
    method: 'POST',
    url: `/api/users/${senderUser.id}/balance/p2p-transfer`,
    headers: { Authorization: `Bearer ${senderSignup.token}` },
    payload: {
      asset: 'ngn',
      amount: 15000,
      recipientTarget: `@${recipUsername}`,
      note: 'Payment for design consultation',
      pin: '829471',
    },
  });
  assert.equal(transferRes.statusCode, 200, `P2P transfer succeeded: ${transferRes.body}`);
  const transferJson = transferRes.json();
  assert.equal(transferJson.data.status, 'completed');
  assert.equal(transferJson.data.fee, 0, 'Internal P2P transfer fee is $0.00');
  assert.equal(transferJson.data.netAmount, 15000, 'Net amount matches exact requested amount');
  assert.equal(transferJson.data.recipient.userId, recipUser.id);
  console.log('✅ Verified: Executed 15,000 NGN P2P transfer with $0.00 fee');

  // Test 4: Verify Recipient Received 15,000 NGN
  const recipBalRes = await app.inject({
    method: 'GET',
    url: `/api/users/${recipUser.id}/balance`,
    headers: { Authorization: `Bearer ${recipSignup.token}` },
  });
  assert.equal(recipBalRes.statusCode, 200);
  const recipBal = recipBalRes.json();
  const recipNgn = recipBal.data.balances?.find((b: any) => b.asset === 'ngn') ?? recipBal.data;
  assert.equal(Number(recipNgn.available), 15000, 'Recipient balance is 15,000 NGN');
  console.log('✅ Verified: Recipient ledger credited with 15,000 NGN');

  // Test 5: Verify Sender Remaining Balance is 35,000 NGN
  const senderBalRes = await app.inject({
    method: 'GET',
    url: `/api/users/${senderUser.id}/balance`,
    headers: { Authorization: `Bearer ${senderSignup.token}` },
  });
  assert.equal(senderBalRes.statusCode, 200);
  const senderBal = senderBalRes.json();
  const senderNgn = senderBal.data.balances?.find((b: any) => b.asset === 'ngn') ?? senderBal.data;
  assert.equal(Number(senderNgn.available), 35000, 'Sender balance is 35,000 NGN');
  console.log('✅ Verified: Sender balance deducted by exact 15,000 NGN');

  // Test 6: Case B - Create P2P Claim Vault for Unregistered Phone
  const unregPhone = `+1415${String(runId).slice(-7)}`;
  const claimRes = await app.inject({
    method: 'POST',
    url: `/api/users/${senderUser.id}/balance/p2p-transfer`,
    headers: { Authorization: `Bearer ${senderSignup.token}` },
    payload: {
      asset: 'ngn',
      amount: 10000,
      recipientTarget: unregPhone,
      note: 'Invite bonus test',
      pin: '829471',
    },
  });
  assert.equal(claimRes.statusCode, 200, `Claim vault creation succeeded: ${claimRes.body}`);
  const claimJson = claimRes.json();
  assert.equal(claimJson.data.status, 'pending_claim');
  assert.equal(claimJson.data.isClaim, true);
  assert.equal(claimJson.data.fee, 0, 'Zero fee on claim creation');
  assert.equal(claimJson.data.recipientPhone, unregPhone);
  const claimToken = claimJson.data.claimToken;
  assert.ok(claimToken, 'Claim token generated');

  // Test 7: Public Claim Inspection via GET /api/claims/:token
  const inspectRes = await app.inject({
    method: 'GET',
    url: `/api/claims/${claimToken}`,
  });
  assert.equal(inspectRes.statusCode, 200, 'Claim inspection succeeded');
  const inspectJson = inspectRes.json();
  assert.equal(inspectJson.data.amount, 10000);
  assert.equal(inspectJson.data.asset, 'ngn');
  assert.equal(inspectJson.data.status, 'pending');
  assert.equal(inspectJson.data.recipientPhone, unregPhone);
  console.log('✅ Verified: Inspected claim via GET /api/claims/:token');

  // Test 8: New User Signs Up on Web & Redeems Claim
  const newSignup = await signup('New Invited User', newbieUsername);
  const newUser = newSignup.user;

  const redeemRes = await app.inject({
    method: 'POST',
    url: `/api/claims/${claimToken}/redeem`,
    payload: { userId: newUser.id },
  });
  assert.equal(redeemRes.statusCode, 200, `Claim redemption succeeded: ${redeemRes.body}`);
  const redeemJson = redeemRes.json();
  assert.equal(redeemJson.data.success, true);
  assert.equal(redeemJson.data.status, 'claimed');
  assert.equal(redeemJson.data.amount, 10000);
  assert.equal(redeemJson.data.creditedToUserId, newUser.id);
  console.log('✅ Verified: Successfully redeemed claim into newly registered account');

  // Test 9: Verify New User Balance & Auto-Linked Phone
  const newBalRes = await app.inject({
    method: 'GET',
    url: `/api/users/${newUser.id}/balance`,
    headers: { Authorization: `Bearer ${newSignup.token}` },
  });
  assert.equal(newBalRes.statusCode, 200);
  const newBal = newBalRes.json();
  const newNgn = newBal.data.balances?.find((b: any) => b.asset === 'ngn') ?? newBal.data;
  assert.equal(Number(newNgn.available), 10000, 'New user balance is 10,000 NGN');

  // Verify Phone Auto-Linked to New User Profile
  const resolveNewPhoneRes = await app.inject({
    method: 'GET',
    url: `/api/identity/resolve-target?target=${unregPhone}`,
  });
  assert.equal(resolveNewPhoneRes.statusCode, 200);
  const resolveNewPhoneJson = resolveNewPhoneRes.json();
  assert.equal(resolveNewPhoneJson.data.found, true);
  assert.equal(resolveNewPhoneJson.data.user.userId, newUser.id);
  console.log('✅ Verified: Phone number automatically linked to new user profile upon claim!');

  console.log('🎉 ALL P2P DIRECT TRANSFER & CLAIM REDEMPTION TESTS PASSED 100% GREEN!');
}

runP2pTransferTest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

