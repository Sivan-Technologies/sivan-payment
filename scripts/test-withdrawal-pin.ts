/**
 * WITHDRAWAL PIN: THE PROPERTIES THAT MAKE IT WORTH HAVING.
 *
 * A PIN feature can be fully implemented, typecheck clean, and still protect
 * nothing. Every assertion below targets a specific way this could be true:
 *
 *   - a PIN the bot can set is not a second factor
 *   - a token not bound to the payout authorises any payout
 *   - a token that can be spent twice is a replay
 *   - a lockout that still admits the correct PIN is not a lockout
 *   - a PIN readable in the database is not a secret
 *
 * The binding tests are the centre of this file. They pass a VALID, unexpired,
 * unused token to consumeStepUpToken and change only the amount or only the
 * destination - the exact move an attacker holding the bot's secret would make.
 *
 * Run on both providers. JSON alone does not prove the Postgres mapper carries
 * these columns:
 *   npm run test:withdrawal-pin
 *   DATABASE_PROVIDER=postgres DATABASE_URL=... npx tsx scripts/test-withdrawal-pin.ts
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import {
  assertPinIsAcceptable,
  consumeStepUpToken,
  hasWithdrawalPin,
  setWithdrawalPin,
  verifyWithdrawalPin,
} from '../src/identity/withdrawal-pin.service.js';

const SERVICE_SECRET = process.env.IDENTITY_LINK_SERVICE_SECRET ?? 'pin-test-secret';

let passed = 0;

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
}

/**
 * Asserts a call rejects, and rejects for the REASON given.
 *
 * A bare "it threw" would pass if the call failed for an unrelated reason - a
 * typo in a field name throws too, and would silently masquerade as a security
 * control working.
 */
async function assertRejects(fn: () => Promise<unknown>, expectedFragment: string, message: string) {
  try {
    await fn();
  } catch (error) {
    const text = (error as Error).message ?? '';
    if (!text.toLowerCase().includes(expectedFragment.toLowerCase())) {
      throw new Error(`${message}: rejected, but for the wrong reason -> ${text}`);
    }
    passed += 1;
    console.log(`✓ ${message}`);
    return;
  }
  throw new Error(`${message}: expected a rejection, but the call succeeded`);
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

  async function createUser(label: string) {
    const email = `pin-${label}+${Date.now()}@sivan.test`;
    const startRes = await fetch(`${baseUrl}/api/auth/email/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        fullName: `Pin ${label}`,
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
    const token = verified.token ?? verified.accessToken ?? verified.sessionToken;
    if (!token) throw new Error(`no session token in verify response: ${JSON.stringify(Object.keys(verified))}`);
    return { email, id: verified.user.id as string, jwt: token as string };
  }

  try {
    console.log(`\n--- provider: ${env.DATABASE_PROVIDER} ---\n`);

    const alice = await createUser('alice');
    const bob = await createUser('bob');

    // Resolves a chat identity the way the route does, without needing a real
    // linked WhatsApp or Telegram account for every case under test.
    const resolver = async (_channel: string, identity: string) =>
      identity === 'alice-chat' ? alice.id : identity === 'bob-chat' ? bob.id : undefined;

    // 1. WEAK PINS ---------------------------------------------------------
    assertRejectsSync(() => assertPinIsAcceptable('123456'), 'PIN 123456 is refused as guessable');
    assertRejectsSync(() => assertPinIsAcceptable('111111'), 'a repeated-digit PIN is refused');

    // 2. THE BOT CANNOT MINT ITS OWN SECOND FACTOR -------------------------
    //
    // The single most important test here. If holding the service secret is
    // enough to SET a PIN, then an attacker who has the secret can set one and
    // satisfy it, and every other control below is theatre.
    const botSetsPin = await fetch(`${baseUrl}/api/users/me/withdrawal-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sivan-identity-link-secret': SERVICE_SECRET },
      body: JSON.stringify({ pin: '824193' }),
    });
    assert(botSetsPin.status === 401 || botSetsPin.status === 403,
      `service secret alone cannot set a PIN (got ${botSetsPin.status})`);

    // 3a. THE BOT CAN ASK WHETHER A PIN EXISTS -----------------------------
    //
    // This is the FIRST call the bot makes: it decides between "enter your
    // PIN" and "set one up first". Same exemption bug class as the block
    // below - a missing entry in app.ts would 401 every bot call and make the
    // prompt unreachable, while every unit test still passed.
    const statusNoSecret = await fetch(`${baseUrl}/api/identity/withdrawal-pin-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'whatsapp', identity: 'alice-chat' }),
    });
    assert(statusNoSecret.status === 403,
      `withdrawal-pin-status without the service secret is refused (got ${statusNoSecret.status})`);

    const statusUnknown = await fetch(`${baseUrl}/api/identity/withdrawal-pin-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sivan-identity-link-secret': SERVICE_SECRET },
      body: JSON.stringify({ channel: 'whatsapp', identity: '+000000000000' }),
    });
    const statusUnknownBody: any = await statusUnknown.json().catch(() => ({}));
    assert(statusUnknownBody?.error?.code !== 'auth_required',
      'withdrawal-pin-status is reachable with a service secret and no user JWT');

    // An identity with no account answers exactly as an account with no PIN.
    // If these ever differ, anyone holding the bot secret can test a list of
    // phone numbers for Sivan membership - so this asserts the SHAPE of the
    // answer, not just that it did not throw.
    assert(statusUnknownBody?.data?.hasPin === false,
      'an unknown identity reports hasPin:false rather than erroring');
    assert(!JSON.stringify(statusUnknownBody).includes('userId'),
      'the status response never carries a userId');

    // 3. THE BOT CAN REACH verify-pin AT ALL -------------------------------

    //
    // Regression test for a real bug: /api/identity/verify-pin was missing from
    // the JWT exemption list in app.ts, so every bot call would have been
    // rejected as auth_required before reaching the handler. The PIN prompt
    // would have been unusable in production while passing every unit test.
    const botReachesVerify = await fetch(`${baseUrl}/api/identity/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sivan-identity-link-secret': SERVICE_SECRET },
      body: JSON.stringify({
        channel: 'whatsapp', identity: 'alice-chat', pin: '824193',
        amount: '100', currency: 'NGN', destinationRef: 'acct-1',
      }),
    });
    const verifyBody: any = await botReachesVerify.json().catch(() => ({}));
    assert(verifyBody?.error?.code !== 'auth_required',
      'verify-pin is reachable with a service secret and no user JWT');

    // And an anonymous caller still cannot reach it.
    const anonVerify = await fetch(`${baseUrl}/api/identity/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'whatsapp', identity: 'alice-chat', pin: '824193',
        amount: '100', currency: 'NGN', destinationRef: 'acct-1',
      }),
    });
    assert(anonVerify.status === 403, `verify-pin without the service secret is refused (got ${anonVerify.status})`);

    // 4. A SIGNED-IN USER CAN SET ONE --------------------------------------
    const webSetsPin = await fetch(`${baseUrl}/api/users/me/withdrawal-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.jwt}` },
      body: JSON.stringify({ pin: '824193' }),
    });
    assert(webSetsPin.ok, `a signed-in user can set a PIN (got ${webSetsPin.status})`);
    assert((await hasWithdrawalPin(alice.id)) === true, 'hasWithdrawalPin reports true after setting');
    assert((await hasWithdrawalPin(bob.id)) === false, "another user's account is unaffected");

    // 5. STORED AS A HASH ---------------------------------------------------
    if (env.DATABASE_PROVIDER === 'json') {
      const dbPath = path.isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : path.join(process.cwd(), env.DATABASE_FILE);
      const raw = await fs.readFile(dbPath, 'utf8');
      assert(!raw.includes('824193'), 'the PIN does not appear in the database in plaintext');
    }

    // 6. WRONG PIN, AND AN UNKNOWN IDENTITY, ARE INDISTINGUISHABLE ---------
    //
    // If an unknown identity produced a different error, this endpoint would
    // answer "does this phone number have a Sivan account?" for anyone holding
    // the bot's secret.
    let wrongPinMessage = '';
    let unknownIdentityMessage = '';
    try {
      await verifyWithdrawalPin(
        { channel: 'whatsapp', identity: 'alice-chat', pin: '999999', amount: '100', currency: 'NGN', destinationRef: 'acct-1' } as any,
        resolver as any, { ipAddress: '127.0.0.1' });
    } catch (error) { wrongPinMessage = (error as Error).message; }
    try {
      await verifyWithdrawalPin(
        { channel: 'whatsapp', identity: 'nobody-here', pin: '824193', amount: '100', currency: 'NGN', destinationRef: 'acct-1' } as any,
        resolver as any, { ipAddress: '127.0.0.1' });
    } catch (error) { unknownIdentityMessage = (error as Error).message; }
    assert(wrongPinMessage.length > 0 && wrongPinMessage === unknownIdentityMessage,
      'an unknown identity and a wrong PIN return the identical message');

    // 7. THE TOKEN IS BOUND TO ONE SPECIFIC PAYOUT -------------------------
    const payout = { amount: '5000', currency: 'NGN', destinationRef: 'bank-acct-0001' };
    const minted: any = await verifyWithdrawalPin(
      { channel: 'whatsapp', identity: 'alice-chat', pin: '824193', ...payout } as any,
      resolver as any, { ipAddress: '127.0.0.1' });
    assert(typeof minted.stepUpToken === 'string' && minted.stepUpToken.length > 20,
      'a correct PIN mints a step-up token');
    assert(minted.userId === alice.id, 'the token is minted for the resolved user');

    /**
     * Amount and destination mismatches expect the SAME message, deliberately.
     *
     * "Amount does not match" versus "destination does not match" would be an
     * oracle: it lets someone holding a captured token discover, field by
     * field, what it was minted for. One message for every binding mismatch
     * tells the honest user exactly what to do (confirm again) and the
     * attacker nothing.
     *
     * The cross-USER case is a different rejection on purpose, and it must
     * stay that way. consumeStepUpToken looks the token up first and refuses
     * with "needs your PIN" when the record belongs to someone else - so Bob
     * cannot even learn that Alice's token exists, let alone what it was
     * minted for. Asserting the two separately pins both behaviours.
     *
     * The assertions are still specific: each pins its exact rejection, so an
     * unrelated throw (a renamed field, a bad argument) cannot pass as a
     * working control.
     */
    const detailsChanged = 'changed after you confirmed';

    await assertRejects(
      () => consumeStepUpToken({ token: minted.stepUpToken, userId: alice.id, ...payout, amount: '500000' }),
      detailsChanged,
      'a token minted for 5,000 cannot authorise 500,000');

    await assertRejects(
      () => consumeStepUpToken({ token: minted.stepUpToken, userId: alice.id, ...payout, destinationRef: 'bank-acct-9999' }),
      detailsChanged,
      'a token minted for one account cannot pay a different account');

    await assertRejects(
      () => consumeStepUpToken({ token: minted.stepUpToken, userId: bob.id, ...payout }),
      'needs your PIN',
      "one user's token cannot authorise another user's withdrawal");

    // 8. SINGLE USE ---------------------------------------------------------
    await consumeStepUpToken({ token: minted.stepUpToken, userId: alice.id, ...payout });
    assert(true, 'the token spends successfully against the payout it was minted for');

    await assertRejects(
      () => consumeStepUpToken({ token: minted.stepUpToken, userId: alice.id, ...payout }),
      'already used',
      'the same token cannot be spent twice');

    // 9. LOCKOUT ------------------------------------------------------------
    //
    // Uses Bob so Alice's state above stays clean. The real property is the
    // last assertion: once locked, the CORRECT PIN is refused too. A lockout
    // that still admits the right PIN only annoys the attacker.
    await setWithdrawalPin(bob.id, { pin: '735018' } as any, { ipAddress: '127.0.0.1' });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await verifyWithdrawalPin(
        { channel: 'whatsapp', identity: 'bob-chat', pin: '000000', amount: '10', currency: 'NGN', destinationRef: 'x' } as any,
        resolver as any, { ipAddress: '127.0.0.1' }).catch(() => undefined);
    }
    await assertRejects(
      () => verifyWithdrawalPin(
        { channel: 'whatsapp', identity: 'bob-chat', pin: '735018', amount: '10', currency: 'NGN', destinationRef: 'x' } as any,
        resolver as any, { ipAddress: '127.0.0.1' }),
      // The lockout message itself, not the word "locked" - asserting the real
      // string keeps this test honest if the wording is ever softened into
      // something that no longer tells the user their PIN still works.
      'Too many incorrect PIN attempts',
      'after 5 wrong PINs the correct PIN is refused too');

    console.log(`\nAll ${passed} assertions passed on ${env.DATABASE_PROVIDER}.\n`);
  } finally {
    await app.close();
  }
}

/** Synchronous sibling of assertRejects, for the validation helpers. */
function assertRejectsSync(fn: () => unknown, message: string) {
  try {
    fn();
  } catch {
    passed += 1;
    console.log(`✓ ${message}`);
    return;
  }
  throw new Error(`${message}: expected a rejection, but the call succeeded`);
}

main().catch((error) => {
  console.error(`\n✗ ${(error as Error).message}\n`);
  process.exit(1);
});
