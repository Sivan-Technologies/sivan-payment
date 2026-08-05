/**
 * WHY IS WALLET CREATION FAILING? ASK PRIVY DIRECTLY.
 *
 * POST /api/users/:id/wallets returns 503 on live while the health probe says
 * credentials are fine. Both can be true, and the difference is which Privy
 * call is being tested - so this makes each one individually and reports what
 * came back.
 *
 * READ-ONLY. It never creates a wallet: Privy wallets are billable and cannot
 * be deleted, so a diagnostic that provisions one to see if provisioning works
 * leaves a permanent cost behind every time it runs.
 *
 * USAGE - run it against the LIVE values, from the Render shell or locally:
 *
 *   PRIVY_APP_ID=xxx \
 *   PRIVY_APP_SECRET=xxx \
 *   PRIVY_AUTHORIZATION_KEY_QUORUM_ID=xxx \
 *   npx tsx scripts/diagnose-privy.ts
 *
 * Run it once with the LIVE values and once with the SANDBOX values. The
 * summary at the end tells you whether sharing a quorum id between them is
 * safe, which depends entirely on whether both point at the same Privy app.
 */

// Marks this file as a module so top-level await typechecks.
export {};

const PRIVY_BASE = 'https://api.privy.io/v1';

const appId = (process.env.PRIVY_APP_ID || '').trim();
const appSecret = (process.env.PRIVY_APP_SECRET || '').trim();
const quorumId = (process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID || '').trim();
const authKey = (process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY || '').trim();

function mask(value: string): string {
  if (!value) return '(not set)';
  if (value.length <= 10) return `${value.slice(0, 2)}…${value.slice(-2)}`;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

async function call(path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${PRIVY_BASE}${path}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
      'privy-app-id': appId,
    },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

console.log('\n════════════════════════════════════════════════════════');
console.log('  PRIVY WALLET CREATION DIAGNOSTIC');
console.log('════════════════════════════════════════════════════════\n');

console.log('CONFIGURATION AS THIS PROCESS SEES IT');
console.log(`  PRIVY_APP_ID                       ${appId || '(NOT SET)'}`);
console.log(`  PRIVY_APP_SECRET                   ${mask(appSecret)}`);
console.log(`  PRIVY_AUTHORIZATION_KEY_QUORUM_ID  ${quorumId || '(not set)'}`);
console.log(`  PRIVY_AUTHORIZATION_PRIVATE_KEY    ${authKey ? 'set' : '(not set)'}`);
console.log();

if (!appId || !appSecret) {
  console.log('STOP: app id and secret are required. Nothing else can be checked.\n');
  process.exit(1);
}

let verdict: string[] = [];

// ---------------------------------------------------------------------------
// 1. Do the credentials authenticate at all?
// ---------------------------------------------------------------------------
console.log('1. CREDENTIALS  ->  GET /apps/{appId}');
const app = await call(`/apps/${encodeURIComponent(appId)}`);
if (app.status === 200) {
  console.log(`   OK (200). App name: ${app.body?.name ?? '(unnamed)'}`);
  console.log('   The app id and secret are a valid pair.');
} else {
  console.log(`   FAILED (${app.status}): ${JSON.stringify(app.body).slice(0, 200)}`);
  verdict.push('Credentials are rejected. Every Privy call fails until they are fixed.');
}
console.log();

// ---------------------------------------------------------------------------
// 2. The key quorum. THIS is what wallet creation sends and the read does not.
// ---------------------------------------------------------------------------
console.log('2. KEY QUORUM  ->  GET /key_quorums/{id}');
if (!quorumId) {
  console.log('   Not configured, so wallet creation does not send additional_signers.');
  console.log('   Wallets will be created WITHOUT a delegated signer, which means');
  console.log('   every withdrawal will require the user to sign in person.');
  verdict.push('No key quorum set: delegated signing is off, but this does NOT block wallet creation.');
} else {
  const quorum = await call(`/key_quorums/${encodeURIComponent(quorumId)}`);
  if (quorum.status === 200) {
    console.log(`   OK (200). Display name: ${quorum.body?.display_name ?? '(none)'}`);
    console.log(`   Authorization threshold: ${quorum.body?.authorization_threshold}`);
    console.log(`   Keys in quorum: ${(quorum.body?.authorization_keys ?? []).length}`);
    console.log('   This quorum EXISTS and belongs to this app. It is not the problem.');
  } else {
    console.log(`   FAILED (${quorum.status}): ${JSON.stringify(quorum.body).slice(0, 200)}`);
    console.log();
    console.log('   >>> THIS IS THE CAUSE. <<<');
    console.log('   Key quorum ids are per-app. This one is not visible to this app id,');
    console.log('   so every POST /wallets that sends it as additional_signers fails,');
    console.log('   even though the credentials above authenticate perfectly.');
    verdict.push(
      `Key quorum "${quorumId}" does not belong to app "${appId}". ` +
      'Create a quorum in THIS app and use its id here.'
    );
  }
}
console.log();

// ---------------------------------------------------------------------------
// 3. Is the chain enabled for this app? A disabled chain fails the create.
// ---------------------------------------------------------------------------
console.log('3. EXISTING WALLETS  ->  GET /wallets (read-only sample)');
const wallets = await call('/wallets?limit=1');
if (wallets.status === 200) {
  const count = (wallets.body?.data ?? []).length;
  console.log(`   OK (200). The wallets API is reachable and returned ${count} sample row(s).`);
  if (count > 0) {
    const w = wallets.body.data[0];
    console.log(`   Newest wallet: chain_type=${w?.chain_type} created=${w?.created_at ? new Date(w.created_at).toISOString() : '?'}`);
    console.log('   So this app HAS successfully created wallets before.');
  } else {
    console.log('   This app has never created a wallet.');
  }
} else {
  console.log(`   FAILED (${wallets.status}): ${JSON.stringify(wallets.body).slice(0, 200)}`);
  verdict.push('The wallets API itself is refusing reads - check the app plan and permissions.');
}
console.log();

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
console.log('════════════════════════════════════════════════════════');
console.log('  VERDICT');
console.log('════════════════════════════════════════════════════════');
if (verdict.length === 0) {
  console.log('  Every read-only check passed.');
  console.log();
  console.log('  Credentials authenticate, the key quorum exists in this app, and');
  console.log('  the wallets API answers. The failure is therefore in the CREATE');
  console.log('  request specifically - most likely the chain not being enabled for');
  console.log('  this app, or a plan limit.');
  console.log();
  console.log('  Next: read the `details` field on the Sentry event for the 503. It');
  console.log('  carries Privy\'s exact status and message, which names the reason.');
} else {
  for (const line of verdict) console.log(`  - ${line}`);
}
console.log();
console.log('  SHARING A QUORUM BETWEEN SANDBOX AND LIVE:');
console.log('  Safe ONLY if both environments use the SAME PRIVY_APP_ID. Quorums');
console.log('  belong to an app, not to an environment. Run this script against');
console.log(`  both and compare the PRIVY_APP_ID printed at the top. This one is:`);
console.log(`      ${appId}`);
console.log();
