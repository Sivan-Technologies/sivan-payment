/**
 * Can this deployment actually reach its wallet provider?
 *
 * The gap this closes: every credential check ran on a developer machine
 * against a local .env. A service on Render with a mistyped secret behaves
 * identically to a correct one until a user asks for a wallet - and that sits
 * BEHIND the KYC gate, so a broken deployment looks healthy to anyone testing
 * without a verified bank account. Exactly what happened while verifying
 * Render: the request was refused for "add your payout bank account" and never
 * touched Privy at all.
 *
 * Run: npm run test:wallet-health
 */

import 'dotenv/config';
import { getWalletProviderHealth, getAllWalletProviderHealth } from '../src/wallets/wallet-health.service.js';
import { env } from '../src/config/env.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

/** Both sources must move together: the provider falls back to parsed env. */
function setEnv(key: string, value: string) {
  (env as any)[key] = value;
  if (value) process.env[key] = value;
  else delete process.env[key];
}

async function main() {
  const savedSecret = env.PRIVY_APP_SECRET;
  const savedQuorum = env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID;
  const savedKey = env.PRIVY_AUTHORIZATION_PRIVATE_KEY;
  const savedProvider = process.env.WALLET_PROVIDER;

  process.env.WALLET_PROVIDER = 'privy';

  if (!savedSecret) {
    console.error('\nPRIVY credentials are not set locally. Nothing to check.\n');
    process.exit(1);
  }

  console.log('\nGOOD CREDENTIALS REPORT HEALTHY');
  {
    const health = await getWalletProviderHealth();
    check('the provider is reachable', health.available, health.message);
    check('it is reported as configured', health.configured);
    check('mode is live, not mock', health.mode === 'live', health.mode);
    check('latency is recorded', typeof health.latencyMs === 'number' && health.latencyMs >= 0);
    console.log(`       answered in ${health.latencyMs}ms`);
  }

  console.log('\nA WRONG SECRET IS CAUGHT - THE WHOLE POINT');
  {
    // This check first used GET /v1/apps/{id}, which does NOT authenticate:
    // verified directly, it returns 200 with the app's full details when
    // handed a fabricated secret. A health check built on it reports
    // "available" for a deployment whose credentials are wrong, which is worse
    // than no check at all because it manufactures false confidence.
    setEnv('PRIVY_APP_SECRET', 'privy_app_secret_definitely_not_real');
    const health = await getWalletProviderHealth();

    check('a bad secret is NOT reported as available', !health.available,
      'the endpoint being used does not actually authenticate');
    check('the message names the variable to fix',
      /PRIVY_APP_SECRET/.test(health.message ?? ''), health.message);
    check('it is still reported as configured, just rejected', health.configured,
      'unconfigured and rejected are different problems');

    setEnv('PRIVY_APP_SECRET', savedSecret);
  }

  console.log('\nA QUORUM FROM ANOTHER APP IS CAUGHT');
  {
    // Authenticates fine and then fails at SIGNING time, which is far harder
    // to diagnose than a rejected credential.
    setEnv('PRIVY_AUTHORIZATION_KEY_QUORUM_ID', 'quorum_that_belongs_elsewhere');
    const health = await getWalletProviderHealth();

    check('credentials still report available', health.available, health.message);
    check('but delegated signing is NOT ready', !health.delegatedSigningReady,
      'a quorum that does not exist cannot sign');
    check('the message explains which is wrong',
      /KEY_QUORUM_ID/.test(health.message ?? ''), health.message);
    check('the quorum is reported as missing', health.details.keyQuorumExists === false);

    setEnv('PRIVY_AUTHORIZATION_KEY_QUORUM_ID', savedQuorum);
  }

  console.log('\nNO SIGNING KEY IS A DIFFERENT STATE FROM BROKEN');
  {
    // Without a key, wallets still work - every withdrawal just falls back to
    // pending_user_signature. That is degraded, not broken, and the two must
    // not be conflated.
    setEnv('PRIVY_AUTHORIZATION_PRIVATE_KEY', '');
    const health = await getWalletProviderHealth();

    check('the provider is still available', health.available, health.message);
    check('but signing is not ready', !health.delegatedSigningReady);
    check('the missing key is visible', health.details.authorizationKeyConfigured === false);

    setEnv('PRIVY_AUTHORIZATION_PRIVATE_KEY', savedKey);
  }

  console.log('\nMISSING CREDENTIALS ARE NOT A NETWORK FAILURE');
  {
    setEnv('PRIVY_APP_SECRET', '');
    const health = await getWalletProviderHealth();

    check('it reports unconfigured, not unavailable-due-to-error',
      health.mode === 'unconfigured', health.mode);
    check('no pointless network call is made', health.latencyMs < 100, String(health.latencyMs));
    check('the message says what is missing',
      /not set/i.test(health.message ?? ''), health.message);

    setEnv('PRIVY_APP_SECRET', savedSecret);
  }

  console.log('\nTHE SECRET IS NEVER ECHOED BACK');
  {
    // An admin endpoint that leaks a prefix of the secret is a credential
    // disclosure. The app id is fine - it is in the dashboard URL and every
    // client bundle - but the secret must never appear, not even truncated.
    const health = await getWalletProviderHealth();
    const serialised = JSON.stringify(health);

    check('the app secret does not appear anywhere in the response',
      !serialised.includes(savedSecret), 'the secret was echoed back');
    check('not even a prefix of it',
      !serialised.includes(savedSecret.slice(0, 12)), 'a secret prefix was echoed');
    check('the app id IS exposed, which is safe and useful',
      serialised.includes(String(env.PRIVY_APP_ID)));
  }

  console.log('\nMOCK IS FLAGGED, NOT QUIETLY CALLED HEALTHY');
  {
    process.env.WALLET_PROVIDER = 'mock';
    const health = await getWalletProviderHealth();

    check('mock reports available', health.available);
    // available:true on a mock provider must not read as "ready".
    check('but says the addresses belong to nobody',
      /simulated|belong to nobody|lost/i.test(health.message ?? ''), health.message);
    check('and mode makes it obvious', health.mode === 'mock');

    process.env.WALLET_PROVIDER = 'privy';
  }

  console.log('\nALL PROVIDERS CAN BE COMPARED AT ONCE');
  {
    const all = await getAllWalletProviderHealth();
    check('the active provider is named', typeof all.activeProvider === 'string');
    check('every provider is listed', all.providers.length === 3, String(all.providers.length));
    check('privy is among them', all.providers.some((p) => p.provider === 'privy'));
  }

  if (savedProvider) process.env.WALLET_PROVIDER = savedProvider;
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => { console.error('\nthrew:', error); process.exit(1); });
