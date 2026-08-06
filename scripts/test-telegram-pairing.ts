/**
 * TELEGRAM PAIRING, END TO END, AT THE SERVICE LAYER.
 *
 * This test exists because of three bugs that shipped invisibly.
 *
 * The Postgres adapter builds queries as raw SQL strings, so when `channel`
 * and the `telegram_*` columns were added to the record types, the INSERT
 * statements simply ignored them. `tsc --noEmit` was clean. The JSON database
 * used by every other test in this repo stores whole objects, so it carried
 * the new fields happily and would have passed too. The feature was dead only
 * on Postgres - which is the one place it has to work.
 *
 * So the assertions below deliberately go THROUGH the database and read back
 * out again, rather than inspecting the return value of the call that wrote
 * them. A mapper that drops a column cannot survive a round trip, and that is
 * the only property that actually distinguishes the fixed code from the broken
 * code.
 *
 * It is service-level rather than HTTP-level (unlike test-shared-identity.ts)
 * because the Telegram routes do not exist yet. When they land, the HTTP layer
 * should be covered there; this file is about persistence.
 *
 * Run against BOTH providers. Passing on JSON alone proves nothing:
 *   npm run test:telegram-pairing
 *   DATABASE_PROVIDER=postgres DATABASE_URL=... npx tsx scripts/test-telegram-pairing.ts
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import {
  startTelegramLink,
  startWhatsappLink,
  redeemTelegramLink,
  redeemWhatsappLink,
  lookupTelegramIdentity,
  unlinkTelegramIdentity,
  cancelTelegramLink,
  getIdentityStatus,
} from '../src/identity/identity.service.js';

let passed = 0;

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
}

/**
 * Asserts a call rejects FOR THE EXPECTED REASON.
 *
 * `expectedMessage` is not optional politeness - a rejection test that only
 * checks "it threw" passes when the call fails for a completely unrelated
 * reason (a validation error, a typo in a fixture), which silently stops
 * testing the boundary it claims to cover.
 */
async function rejects(fn: () => Promise<unknown>, expectedMessage: string, message: string) {
  try {
    await fn();
  } catch (error: any) {
    const actual = String(error?.message ?? error);
    if (!actual.toLowerCase().includes(expectedMessage.toLowerCase())) {
      throw new Error(`Assertion failed: ${message}\n  rejected, but for the wrong reason.\n  expected to contain: ${expectedMessage}\n  actual: ${actual}`);
    }
    passed += 1;
    console.log(`✓ ${message}`);
    return;
  }
  throw new Error(`Assertion failed: expected rejection but call succeeded - ${message}`);
}


async function main() {
  if (env.DATABASE_PROVIDER === 'json') {
    const dbPath = path.isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : path.join(process.cwd(), env.DATABASE_FILE);
    await fs.rm(dbPath, { force: true });
  }

  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Could not resolve test server address');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // Users are created over HTTP because signup owns a good deal of setup
  // (legal acceptance, verification timestamps) that this test should not be
  // reimplementing. Everything after this point is called directly.
  async function createUser(label: string) {
    const email = `tg-${label}+${Date.now()}@sivan.test`;
    const startRes = await fetch(`${baseUrl}/api/auth/email/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        fullName: `Telegram ${label}`,
        intent: 'signup',
        legalAcceptance: { accepted: true, termsVersion: 'test', privacyVersion: 'test', riskDisclosureVersion: 'test' },
      }),
    });
    const startJson: any = await startRes.json();
    if (!startRes.ok) throw new Error(`signup start failed: ${JSON.stringify(startJson)}`);
    const started = startJson.data ?? startJson;

    const verifyRes = await fetch(`${baseUrl}/api/auth/email/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code: started.devCode }),
    });
    const verifyJson: any = await verifyRes.json();
    if (!verifyRes.ok) throw new Error(`signup verify failed: ${JSON.stringify(verifyJson)}`);
    const verified = verifyJson.data ?? verifyJson;
    return { email, id: verified.user.id as string };
  }

  try {
    console.log(`\n--- provider: ${env.DATABASE_PROVIDER} ---\n`);

    const alice = await createUser('alice');
    const bob = await createUser('bob');
    assert(Boolean(alice.id && bob.id), 'two payment users created');

    // 1. START -----------------------------------------------------------
    const started: any = await startTelegramLink(alice.id);
    assert(typeof started.token === 'string' && started.token.length >= 6, 'startTelegramLink returns a token');

    // NOTE: the top-level `pendingPairing` / `linked` fields on getIdentityStatus
    // are WhatsApp-specific, kept for backwards compatibility with the existing
    // frontend. Per-channel state lives under `channels.<channel>`. Asserting on
    // the top-level fields here would silently be asserting about WhatsApp.
    const pending: any = await getIdentityStatus(alice.id);
    assert(pending.channels.telegram.pendingPairing?.status === 'pending', 'pending telegram pairing is visible under channels.telegram');
    assert(!pending.channels.whatsapp.pendingPairing, 'starting a telegram pairing does not create a whatsapp pending token');

    // 2. CANCEL, then start again ----------------------------------------
    const canceled: any = await cancelTelegramLink(alice.id);
    assert(canceled.canceled === true, 'cancelTelegramLink cancels the pending token');
    await rejects(
      () => redeemTelegramLink({ token: started.token, telegramUserId: '111000111' }),
      'Invalid or expired pairing code',
      'a canceled token cannot be redeemed',
    );

    // 3. REDEEM ----------------------------------------------------------
    const live: any = await startTelegramLink(alice.id);
    const redeemed: any = await redeemTelegramLink({
      token: live.token,
      telegramUserId: '555000555',
      telegramUsername: 'alice_tg',
      escrowUserId: 'escrow_alice',
    });
    assert(redeemed.linked === true, 'redeemTelegramLink links the identity');

    // THE REGRESSION GUARD. Reads back through the database rather than
    // trusting the object the write returned - a mapper that drops a column
    // still returns a correct-looking object in memory.
    // lookupTelegramIdentity resolves by querying on telegram_user_id AND
    // channel. So `linked === true` here is precisely the round-trip proof: if
    // either column failed to persist, this query matches nothing and comes
    // back false. (It returns { linked: false }, never null - so asserting on
    // truthiness of the object would pass even when the lookup found nothing.)
    const lookup: any = await lookupTelegramIdentity('555000555');
    assert(lookup.linked === true, 'telegram_user_id and channel survive the DB round trip');
    assert(lookup.paymentUserId === alice.id, 'looked-up link resolves to the right payment user');
    assert(lookup.escrowUserId === 'escrow_alice', 'escrow_user_id survives the DB round trip');
    // Alice has no WhatsApp number, so she can pair and read but not transact.
    assert(lookup.canTransact === false, 'telegram-only user is correctly not transactable');

    const linkedStatus: any = await getIdentityStatus(alice.id);
    assert(linkedStatus.channels.telegram.linked === true, 'channels.telegram reports linked');
    assert(linkedStatus.channels.whatsapp.linked === false, 'linking telegram does not report whatsapp as linked');

    // 4. TOKEN REUSE -----------------------------------------------------
    await rejects(
      () => redeemTelegramLink({ token: live.token, telegramUserId: '555000555' }),
      'Invalid or expired pairing code',
      'a consumed token cannot be redeemed twice',
    );

    // 5. CROSS-CHANNEL REJECTION -----------------------------------------
    // The bug that made this whole test necessary: if `channel` is not
    // persisted, a WhatsApp token reads back as... whatever the column
    // default says, and this boundary silently disappears.
    // NOTE ON TOKEN REUSE BELOW: startChannelLink refuses to mint a second
    // code while one is pending, and in that case returns the EXISTING token
    // as an object rather than a string. So each channel's code is minted
    // exactly once here and reused across the negative cases.
    const bobWhatsappToken: string = (await startWhatsappLink(bob.id)).token as string;
    await rejects(
      () => redeemTelegramLink({ token: bobWhatsappToken, telegramUserId: '777000777' }),
      'not issued for Telegram',
      'a WhatsApp token is REJECTED by the telegram redeemer',
    );

    // ...and the mirror image. This is the direction that was unguarded: a
    // Telegram code could be redeemed by the WhatsApp bot, letting whoever got
    // there first bind their own number to someone else's account.
    const bobTelegramToken: string = (await startTelegramLink(bob.id)).token as string;
    await rejects(
      () => redeemWhatsappLink({ token: bobTelegramToken, whatsappNumber: 'whatsapp:+2348000000123' }),
      'not issued for WhatsApp',
      'a Telegram token is REJECTED by the whatsapp redeemer',
    );

    // 6. DUPLICATE TELEGRAM ACCOUNT --------------------------------------
    // Reuses Bob's still-pending telegram code against Alice's telegram id.
    await rejects(
      () => redeemTelegramLink({ token: bobTelegramToken, telegramUserId: '555000555' }),
      'already linked to another Sivan payment account',
      'a telegram account already linked elsewhere cannot be linked again',
    );

    // 7. BOTH CHANNELS ON ONE USER ---------------------------------------
    // Generalising to multi-channel must not have made the channels exclusive.
    await redeemWhatsappLink({ token: bobWhatsappToken, whatsappNumber: 'whatsapp:+2348000000456' });
    await redeemTelegramLink({ token: bobTelegramToken, telegramUserId: '999000999', telegramUsername: 'bob_tg' });

    const bobTgLink: any = await lookupTelegramIdentity('999000999');
    assert(bobTgLink.linked === true, 'telegram link survives alongside a whatsapp link on the same user');
    assert(bobTgLink.paymentUserId === bob.id, 'coexisting telegram link resolves to the right user');
    // Bob DOES have a WhatsApp number, so the same lookup reports transactable.
    assert(bobTgLink.canTransact === true, 'user with both channels is transactable from telegram');

    // 8. UNLINK ----------------------------------------------------------
    const unlinked: any = await unlinkTelegramIdentity(alice.id);
    assert(unlinked.unlinked === true, 'unlinkTelegramIdentity reports success');
    const afterUnlink: any = await lookupTelegramIdentity('555000555');
    assert(afterUnlink.linked === false, 'unlinked telegram account no longer resolves');

    // Unlinking one user must not have collaterally unlinked another's.
    const bobStillLinked: any = await lookupTelegramIdentity('999000999');
    assert(bobStillLinked.linked === true, "one user's unlink does not affect another user's link");

    await app.close();
    console.log(`\n✅ Telegram pairing E2E passed (${passed} assertions, provider=${env.DATABASE_PROVIDER})`);
  } catch (error) {
    await app.close();
    throw error;
  }
}

main().catch((error) => {
  console.error(`\n❌ Telegram pairing E2E FAILED\n`);
  console.error(error);
  process.exit(1);
});
