/**
 * MONEYGRAM TRANSACTION STATUS AND WEBHOOK AUTHENTICATION.
 *
 * Two defects, both of which made a broken system look like a working one.
 *
 * 1. THE STATUS ENDPOINT INVENTED ITS ANSWER.
 *
 *    getMoneyGramSep24Transaction returned, for ANY id the anchor and the
 *    local store had never heard of:
 *
 *      status "ready_for_pickup", pin "4829-1049", amount "25.00"
 *
 *    Verified by querying a freshly generated id. Those were development
 *    placeholders that had become the fallback branch, so the case of
 *    knowing nothing produced the most reassuring possible output. A user
 *    would have gone to a counter with a pin that was never issued.
 *
 * 2. UNSIGNED WEBHOOKS WERE ACCEPTED BY DEFAULT.
 *
 *    The verifier returned valid:true whenever the public key was missing
 *    and the environment was sandbox, and moneyGramEnvironment() defaults to
 *    sandbox. So forgetting two environment variables, both silently, meant
 *    every unauthenticated POST was trusted and written to the database.
 *
 * Signatures here are generated with a real RSA keypair and verified through
 * the real code path.
 */

import crypto from 'node:crypto';
import {
  getMoneyGramSep24Transaction,
  MoneyGramTransactionNotFound,
} from '../src/moneygram/service/moneygram-session.service.js';
import { verifyMoneyGramSignature } from '../src/webhooks/moneygramWebhookHandler.js';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

function equals(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, `expected ${String(expected)}, got ${String(actual)}`);
}

async function rejectsWith(name: string, fn: () => Promise<unknown>, pattern: RegExp) {
  try {
    await fn();
    check(name, false, 'did not reject at all');
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    check(name, pattern.test(msg), `message did not match ${pattern}: ${msg}`);
  }
}

// A real RSA keypair. Signing with the private half and verifying with the
// public half is the only way to know the digest construction is right.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const { publicKey: otherPublicKey, privateKey: otherPrivateKey } = crypto.generateKeyPairSync(
  'rsa',
  {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }
);

function sign(digest: string, key: string = privateKey): string {
  return crypto.sign('RSA-SHA256', Buffer.from(digest, 'utf8'), key).toString('base64');
}

async function main() {
  console.log('\n== 1. An unknown transaction is an error, not a reassuring default ==');

  const neverExisted = `never-existed-${crypto.randomUUID()}`;

  await rejectsWith(
    'an unknown transaction id is refused',
    () => getMoneyGramSep24Transaction(neverExisted, 'nobody'),
    /is not known to the anchor or to Sivan/
  );

  /**
   * The specific placeholders that used to be returned. Asserting only that
   * it threw would not catch someone reintroducing them on a different
   * branch of the function, so the forbidden values are named.
   */
  let leaked = '';
  try {
    const res: any = await getMoneyGramSep24Transaction(neverExisted, 'nobody');
    leaked = JSON.stringify(res);
  } catch (err: any) {
    leaked = String(err?.message ?? err);
  }
  check(
    'the placeholder pin 4829-1049 is gone',
    !leaked.includes('4829-1049') && !leaked.includes('48291049'),
    leaked
  );
  check('the placeholder status ready_for_pickup is gone', !leaked.includes('ready_for_pickup'), leaked);
  check('the placeholder amount 25.00 is gone', !leaked.includes('25.00'), leaked);

  try {
    await getMoneyGramSep24Transaction(neverExisted, 'nobody');
    check('the error is a typed MoneyGramTransactionNotFound', false, 'did not throw');
  } catch (err: any) {
    check(
      'the error is a typed MoneyGramTransactionNotFound',
      err instanceof MoneyGramTransactionNotFound,
      err?.name
    );
    equals('it carries a 404 status code for the route', err?.statusCode, 404);
    equals('it names the transaction it could not find', err?.transactionId, neverExisted);
  }

  console.log('\n== 2. Webhook signatures are verified against a real RSA key ==');

  process.env.MONEYGRAM_WEBHOOK_PUBLIC_KEY = publicKey;
  process.env.MONEYGRAM_WEBHOOK_HOST = 'webhooks.example.test';
  delete process.env.MONEYGRAM_ALLOW_UNSIGNED_WEBHOOKS;

  const body = JSON.stringify({ transaction: { id: 'mg_test_1', status: 'completed' } });
  const ts = String(Math.floor(Date.now() / 1000));
  const goodDigest = `${ts}.webhooks.example.test.${body}`;

  const ok = verifyMoneyGramSignature({
    rawBody: Buffer.from(body),
    signatureHeader: sign(goodDigest),
    timestampHeader: ts,
    host: 'attacker-controlled-host.example',
  });
  check('a correctly signed callback is accepted', ok.valid, ok.reason);

  // The host is part of the signed digest. If the request's Host header could
  // override the configured one, the caller would choose what was signed.
  const hostOverride = verifyMoneyGramSignature({
    rawBody: Buffer.from(body),
    signatureHeader: sign(`${ts}.attacker-controlled-host.example.${body}`),
    timestampHeader: ts,
    host: 'attacker-controlled-host.example',
  });
  check(
    'a caller-supplied Host cannot override the configured signing host',
    !hostOverride.valid,
    hostOverride.reason
  );

  const tampered = verifyMoneyGramSignature({
    rawBody: Buffer.from(JSON.stringify({ transaction: { id: 'mg_test_1', status: 'refunded' } })),
    signatureHeader: sign(goodDigest),
    timestampHeader: ts,
    host: 'webhooks.example.test',
  });
  check('a modified body invalidates the signature', !tampered.valid, tampered.reason);
  equals('and it says why', tampered.reason, 'signature mismatch');

  const wrongKey = verifyMoneyGramSignature({
    rawBody: Buffer.from(body),
    signatureHeader: sign(goodDigest, otherPrivateKey),
    timestampHeader: ts,
    host: 'webhooks.example.test',
  });
  check('a signature from a different key is rejected', !wrongKey.valid, wrongKey.reason);

  const stale = String(Math.floor(Date.now() / 1000) - 3600);
  const replayed = verifyMoneyGramSignature({
    rawBody: Buffer.from(body),
    signatureHeader: sign(`${stale}.webhooks.example.test.${body}`),
    timestampHeader: stale,
    host: 'webhooks.example.test',
  });
  check('a correctly signed but hour-old callback is rejected', !replayed.valid, replayed.reason);
  check('the replay rejection names the skew', /skew/.test(replayed.reason ?? ''), replayed.reason);

  const noSig = verifyMoneyGramSignature({
    rawBody: Buffer.from(body),
    timestampHeader: ts,
    host: 'webhooks.example.test',
  });
  check('a callback with no signature header is rejected', !noSig.valid, noSig.reason);

  const noTs = verifyMoneyGramSignature({
    rawBody: Buffer.from(body),
    signatureHeader: sign(goodDigest),
    host: 'webhooks.example.test',
  });
  check('a callback with no timestamp header is rejected', !noTs.valid, noTs.reason);

  console.log('\n== 3. Missing configuration fails closed, not open ==');

  delete process.env.MONEYGRAM_WEBHOOK_PUBLIC_KEY;
  delete process.env.MONEYGRAM_ALLOW_UNSIGNED_WEBHOOKS;
  delete process.env.MONEYGRAM_ENVIRONMENT; // defaults to sandbox, the old bypass condition

  const unconfigured = verifyMoneyGramSignature({
    rawBody: Buffer.from(body),
    signatureHeader: 'anything',
    timestampHeader: ts,
    host: 'webhooks.example.test',
  });
  check(
    'an unconfigured sandbox no longer accepts unsigned callbacks',
    !unconfigured.valid,
    unconfigured.reason
  );
  check(
    'the rejection explains both ways to fix it',
    /MONEYGRAM_WEBHOOK_PUBLIC_KEY/.test(unconfigured.reason ?? '') &&
      /MONEYGRAM_ALLOW_UNSIGNED_WEBHOOKS/.test(unconfigured.reason ?? ''),
    unconfigured.reason
  );

  // The bypass still exists, but only when someone types it.
  process.env.MONEYGRAM_ALLOW_UNSIGNED_WEBHOOKS = 'true';
  const optedIn = verifyMoneyGramSignature({
    rawBody: Buffer.from(body),
    signatureHeader: 'anything',
    timestampHeader: ts,
    host: 'webhooks.example.test',
  });
  check('an explicit opt-in is honoured outside production', optedIn.valid, optedIn.reason);
  equals('and is labelled as such', optedIn.reason, 'unsigned_webhooks_explicitly_allowed');

  // ... and never in production, however it is typed.
  process.env.MONEYGRAM_ENVIRONMENT = 'production';
  const prodOptIn = verifyMoneyGramSignature({
    rawBody: Buffer.from(body),
    signatureHeader: 'anything',
    timestampHeader: ts,
    host: 'webhooks.example.test',
  });
  check('production refuses the opt-in outright', !prodOptIn.valid, prodOptIn.reason);
  delete process.env.MONEYGRAM_ENVIRONMENT;
  delete process.env.MONEYGRAM_ALLOW_UNSIGNED_WEBHOOKS;

  console.log('\n== 4. The signing host must come from somewhere ==');

  process.env.MONEYGRAM_WEBHOOK_PUBLIC_KEY = publicKey;
  delete process.env.MONEYGRAM_WEBHOOK_HOST;

  const noHost = verifyMoneyGramSignature({
    rawBody: Buffer.from(body),
    signatureHeader: sign(goodDigest),
    timestampHeader: ts,
    host: undefined,
  });
  check('no configured host and no Host header is refused', !noHost.valid, noHost.reason);
  check(
    'the refusal explains that the host is part of the signature',
    /host is part of what MoneyGram signs/.test(noHost.reason ?? ''),
    noHost.reason
  );

  // With no configured host, the request Host is used. That is the documented
  // behaviour behind a proxy that sets it, and it must still verify.
  const viaRequestHost = verifyMoneyGramSignature({
    rawBody: Buffer.from(body),
    signatureHeader: sign(`${ts}.proxy.example.test.${body}`),
    timestampHeader: ts,
    host: 'proxy.example.test',
  });
  check('the request Host is used when nothing is configured', viaRequestHost.valid, viaRequestHost.reason);

  check('the unused second keypair was really distinct', publicKey !== otherPublicKey);

  console.log(`\nPassed ${passed}, failed ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nSUITE CRASHED:', err?.message ?? err);
  process.exit(1);
});
