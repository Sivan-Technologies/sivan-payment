/**
 * TEST CHAT EMAIL OTP LINKING & PHONE-EMAIL RACE CONDITION RESOLUTION
 *
 * Verifies:
 * 1. Email OTP start and verification for new chat users.
 * 2. Invalid code rejection.
 * 3. Phone-Email Race Condition: Web user registered first -> Telegram user onboarded second ->
 *    Email OTP links Telegram to the canonical web userId without duplicate key conflicts.
 */
import {
  startChatEmailOtp,
  verifyChatEmailOtp,
} from '../src/identity/email-otp.service.js';
import { db } from '../src/database/json-database.js';
import { activeLinkForTelegram } from '../src/identity/identity.service.js';

let passed = 0;
function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
}

async function run() {
  console.log('Testing Chat Email OTP & Race Condition Resolution...');

  const ts = Date.now();
  const newEmail = `bob_${ts}@example.com`;
  const tgUser1 = `tg_bob_${ts}`;

  // 1. New Email OTP Start
  const startResult = await startChatEmailOtp({
    email: newEmail,
    channel: 'telegram',
    identifier: tgUser1,
  });

  assert(startResult.isExistingAccount === false, 'New email detected as isExistingAccount: false');
  assert(startResult.devCode && /^\d{6}$/.test(startResult.devCode), 'Generated valid 6-digit OTP code');

  const correctCode = startResult.devCode!;

  // 2. Verify with wrong code -> rejects
  try {
    await verifyChatEmailOtp({
      email: newEmail,
      code: '000000',
      channel: 'telegram',
      identifier: tgUser1,
    });
    throw new Error('Expected invalid code rejection');
  } catch (err: any) {
    assert(err?.details?.code === 'INVALID_CODE' || String(err?.message).includes('Invalid'), 'Wrong code is rejected');
  }

  // 3. Verify with correct code -> succeeds
  const verifyResult = await verifyChatEmailOtp({
    email: newEmail,
    code: correctCode,
    channel: 'telegram',
    identifier: tgUser1,
    firstName: 'Bob',
    lastName: 'Builder',
  });

  assert(verifyResult.verified === true, 'New user email verified');
  assert(verifyResult.isExistingAccount === false, 'New user isExistingAccount is false');
  assert(Boolean(verifyResult.paymentUserId), 'New user received canonical paymentUserId');

  const bobUser = await db.findUserById(verifyResult.paymentUserId);
  assert(bobUser?.email === newEmail, 'User in DB has correct verified email');
  assert(Boolean(bobUser?.emailVerifiedAt), 'User in DB has emailVerifiedAt set');

  // ── RACE CONDITION TEST ─────────────────────────────────────────────────────
  // Scenario:
  // Alice previously registered on Web with alice@example.com (user id usr_web_alice)
  const aliceEmail = `alice_${ts}@example.com`;
  const webAlice = await db.insertUserRecord({
    id: `usr_web_alice_${ts}`,
    email: aliceEmail,
    fullName: 'Alice Web User',
    emailVerifiedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  assert(Boolean(webAlice.id), 'Pre-existing Web Alice created');

  // Alice now starts onboarding on Telegram with her phone number
  const tgAliceId = `tg_alice_${ts}`;
  const alicePhone = `+234800${String(ts).slice(-6)}`;
  const temporaryTgAlice = await db.insertUserRecord({
    id: `usr_tg_alice_${ts}`,
    email: `${alicePhone.replace(/\D/g, '')}@sivantech.online`,
    fullName: 'Alice Telegram',
    whatsappNumber: alicePhone,
    telegramUserId: tgAliceId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await db.upsertCustomerIdentityLinkRecord({
    id: `link_tg_alice_${ts}`,
    paymentUserId: temporaryTgAlice.id,
    email: temporaryTgAlice.email,
    channel: 'telegram',
    telegramUserId: tgAliceId,
    status: 'linked',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  assert(Boolean(temporaryTgAlice.id), 'Temporary Telegram Alice created');

  // Alice enters alice@example.com in Telegram onboarding
  const aliceStartResult = await startChatEmailOtp({
    email: aliceEmail,
    channel: 'telegram',
    identifier: tgAliceId,
  });

  assert(aliceStartResult.isExistingAccount === true, 'Existing Web account detected: isExistingAccount is TRUE');
  const aliceCode = aliceStartResult.devCode!;

  // Alice verifies the 6-digit OTP code in Telegram
  const aliceVerifyResult = await verifyChatEmailOtp({
    email: aliceEmail,
    code: aliceCode,
    channel: 'telegram',
    identifier: tgAliceId,
    firstName: 'Alice',
  });

  assert(aliceVerifyResult.verified === true, 'Alice email verified');
  assert(aliceVerifyResult.isExistingAccount === true, 'Alice account linking confirmed');
  assert(aliceVerifyResult.paymentUserId === webAlice.id, 'CANONICAL USER ID SYNCHRONIZED: paymentUserId matches webAlice.id');

  // Check identity link record is now pointing to webAlice.id
  const activeLink = await activeLinkForTelegram(tgAliceId);
  assert(activeLink?.paymentUserId === webAlice.id, 'Telegram identity link now points directly to webAlice.id');

  // Check webAlice record in DB has telegramUserId attached
  const refreshedWebAlice = await db.findUserById(webAlice.id);
  assert(refreshedWebAlice?.telegramUserId === tgAliceId, 'Web Alice now holds telegramUserId');

  // Check temporary user email was freed to prevent any duplicate key error
  const refreshedTempUser = await db.findUserById(temporaryTgAlice.id);
  assert(refreshedTempUser?.email.startsWith('merged_'), 'Temporary user email renamed to avoid duplicate key conflict');

  console.log(`\nAll ${passed} assertions passed successfully!`);
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
