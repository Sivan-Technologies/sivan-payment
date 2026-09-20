import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';

export async function runP2pTransferTest() {
  console.log('--- Starting P2P Direct Transfer Integration Test ---');
  const dbPath = path.isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : path.join(process.cwd(), env.DATABASE_FILE);
  await fs.rm(dbPath, { force: true });
  const app = await buildApp();

  async function signup(name: string, username: string) {
    const email = `${username.toLowerCase()}-${Date.now()}@sivan.test`;
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

    // Set custom username
    await app.inject({
      method: 'PUT',
      url: `/api/users/${user.id}/username`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { username },
    });

    return { user, token };
  }

  const senderSignup = await signup('Sender User', 'sender_tester');
  const recipSignup = await signup('Samson Micheal', 'samson_micheal');

  const senderUser = senderSignup.user;
  const recipUser = recipSignup.user;

  // Credit sender with 50 USDC via admin adjustment
  const creditRes = await app.inject({
    method: 'POST',
    url: '/api/admin/balance/adjustments',
    headers: { 'x-admin-api-key': 'test-admin-key' },
    payload: {
      userId: senderUser.id,
      asset: 'usdc',
      amount: 50,
      status: 'available',
      reason: 'Initial test funding for P2P test',
    },
  });
  assert.equal(creditRes.statusCode, 200, 'Admin funding succeeded');

  // Test 1: Resolve recipient by @username
  const resolveTagRes = await app.inject({
    method: 'GET',
    url: '/api/identity/resolve-target?target=@samson_micheal',
  });
  assert.equal(resolveTagRes.statusCode, 200);
  const resolveTagJson = resolveTagRes.json();
  assert.equal(resolveTagJson.data.found, true);
  assert.equal(resolveTagJson.data.user.userId, recipUser.id);
  console.log('✅ Verified: Resolved recipient by @samson_micheal');

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

  // Test 3: Execute P2P Transfer (15.00 USDC) with $0 Fee
  const transferRes = await app.inject({
    method: 'POST',
    url: `/api/users/${senderUser.id}/balance/p2p-transfer`,
    headers: { Authorization: `Bearer ${senderSignup.token}` },
    payload: {
      asset: 'usdc',
      amount: 15,
      recipientTarget: '@samson_micheal',
      note: 'Payment for design consultation',
    },
  });
  assert.equal(transferRes.statusCode, 200, `P2P transfer succeeded: ${transferRes.body}`);
  const transferJson = transferRes.json();
  assert.equal(transferJson.data.status, 'completed');
  assert.equal(transferJson.data.fee, 0, 'Internal P2P transfer fee is $0.00');
  assert.equal(transferJson.data.netAmount, 15, 'Net amount matches exact requested amount');
  assert.equal(transferJson.data.recipient.userId, recipUser.id);
  console.log('✅ Verified: Executed 15.00 USDC P2P transfer with $0.00 fee');

  // Test 4: Verify Recipient Received 15 USDC
  const recipBalRes = await app.inject({
    method: 'GET',
    url: `/api/users/${recipUser.id}/balance`,
    headers: { Authorization: `Bearer ${recipSignup.token}` },
  });
  assert.equal(recipBalRes.statusCode, 200);
  const recipBal = recipBalRes.json();
  const recipUsdc = recipBal.data.balances?.find((b: any) => b.asset === 'usdc') ?? recipBal.data;
  assert.equal(Number(recipUsdc.available), 15, 'Recipient balance is 15 USDC');
  console.log('✅ Verified: Recipient ledger credited with 15.00 USDC');

  // Test 5: Verify Sender Remaining Balance is 35 USDC
  const senderBalRes = await app.inject({
    method: 'GET',
    url: `/api/users/${senderUser.id}/balance`,
    headers: { Authorization: `Bearer ${senderSignup.token}` },
  });
  assert.equal(senderBalRes.statusCode, 200);
  const senderBal = senderBalRes.json();
  const senderUsdc = senderBal.data.balances?.find((b: any) => b.asset === 'usdc') ?? senderBal.data;
  assert.equal(Number(senderUsdc.available), 35, 'Sender balance is 35 USDC');
  console.log('✅ Verified: Sender balance deducted by exact 15.00 USDC');

  // Test 6: Case B - Create P2P Claim Vault for Unregistered Phone (+14159998877)
  const unregPhone = '+14159998877';
  const claimRes = await app.inject({
    method: 'POST',
    url: `/api/users/${senderUser.id}/balance/p2p-transfer`,
    headers: { Authorization: `Bearer ${senderSignup.token}` },
    payload: {
      asset: 'usdc',
      amount: 10,
      recipientTarget: unregPhone,
      note: 'Invite bonus test',
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
  assert.equal(inspectJson.data.amount, 10);
  assert.equal(inspectJson.data.asset, 'usdc');
  assert.equal(inspectJson.data.status, 'pending');
  assert.equal(inspectJson.data.recipientPhone, unregPhone);
  console.log('✅ Verified: Inspected claim via GET /api/claims/:token');

  // Test 8: New User Signs Up on Web & Redeems Claim
  const newSignup = await signup('New Invited User', 'newbie_claimant');
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
  assert.equal(redeemJson.data.amount, 10);
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
  const newUsdc = newBal.data.balances?.find((b: any) => b.asset === 'usdc') ?? newBal.data;
  assert.equal(Number(newUsdc.available), 10, 'New user balance is 10 USDC');

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

