/**
 * Breet sandbox smoke test — against REAL Breet infrastructure.
 *
 * Everything else in this repo tests the Breet adapter against stubs. Stubs
 * agree with whatever I believed when I wrote them, which is exactly how the
 * two real bugs already found here survived: the network capability mismatch
 * (Sivan defaulted to Base and Avalanche, which Breet cannot withdraw to) and
 * the missing webhook route. Neither showed up in unit tests.
 *
 * This script talks to api.breet.io with X-Breet-Env: development. It is
 * read-mostly and creates nothing that costs money.
 *
 * Run: npm run breet:smoke
 *
 * Requires, from the Breet dashboard (Developers -> API Credentials):
 *   BREET_APP_ID
 *   BREET_APP_SECRET
 * Optional but recommended:
 *   BREET_DEFAULT_ASSET_ID   verified against the live asset list here
 */

import { BreetNgnProvider } from '../src/ngn/provider/breet.provider.js';
import {
  BREET_NETWORKS,
  breetDepositAssetId,
  canDeposit,
  canWithdraw,
} from '../src/ngn/provider/breet-networks.js';

const BASE = 'https://api.breet.io/v1';

let pass = 0;
let fail = 0;
let warn = 0;

function ok(name: string, detail = '') {
  pass += 1;
  console.log(`  ok    ${name}${detail ? ` -> ${detail}` : ''}`);
}
function bad(name: string, detail = '') {
  fail += 1;
  console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
}
function note(name: string, detail = '') {
  warn += 1;
  console.log(`  warn  ${name}${detail ? ` -> ${detail}` : ''}`);
}

function headers() {
  return {
    'Content-Type': 'application/json',
    'x-app-id': String(process.env.BREET_APP_ID ?? ''),
    'x-app-secret': String(process.env.BREET_APP_SECRET ?? ''),
    'X-Breet-Env': 'development',
  };
}

async function call(path: string, init: RequestInit = {}) {
  const response = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers(), ...(init.headers ?? {}) } });
  const body: any = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok && body?.success !== false, body };
}

async function main() {
  const appId = process.env.BREET_APP_ID;
  const appSecret = process.env.BREET_APP_SECRET;

  console.log('\nBreet sandbox smoke test (X-Breet-Env: development)\n');

  if (!appId || !appSecret) {
    console.log('  BREET_APP_ID and BREET_APP_SECRET are not set.\n');
    console.log('  Get them from the Breet dashboard: Developers -> API Credentials,');
    console.log('  then run:\n');
    console.log('    BREET_APP_ID=... BREET_APP_SECRET=... npm run breet:smoke\n');
    process.exit(2);
  }

  // 1. Credentials. Everything else is meaningless if this fails.
  console.log('authentication');
  // /integration, /account and /integrations/me all 400 in the sandbox despite
  // the docs. /trades/assets is authenticated and real, so it proves the
  // credentials without depending on an endpoint that may not exist.
  const account = await call('/trades/assets');
  if (account.ok) {
    ok('credentials accepted');
    note('no account/balance endpoint found', 'on-ramp float cannot be pre-checked from the API');
  } else {
    bad('credentials rejected', `${account.status} ${account.body?.message ?? ''}`);
    console.log('\n  Stopping: nothing below can be trusted without auth.\n');
    process.exit(1);
  }

  // 2. The live asset list. This is the check that would have caught the
  //    network mismatch before it reached a user.
  console.log('\nassets — does the capability map match reality?');
  const assets = await call('/trades/assets');
  if (!assets.ok) {
    bad('could not fetch the asset list', `${assets.status} ${assets.body?.message ?? ''}`);
  } else {
    const list: any[] = assets.body?.data ?? assets.body ?? [];
    ok('asset list fetched', `${list.length} assets`);

    // Keyed by IDENTIFIER. Breet returns both: `identifier` is the stable
    // doc-style string the capability map stores, `id` is the ObjectId that
    // asset-keyed endpoints actually require.
    const byIdentifier = new Map(list.map((a: any) => [String(a.identifier), a]));

    // Every testnet id the map claims must actually exist and be active.
    for (const entry of BREET_NETWORKS) {
      for (const asset of ['usdc', 'usdt'] as const) {
        const id = breetDepositAssetId(entry.network, asset, 'development');
        if (!id) continue;
        const live = byIdentifier.get(id);
        if (!live) {
          bad(`${entry.network}/${asset} id not in Breet's list`, id);
        } else if (live.isActive === false) {
          note(`${entry.network}/${asset} exists but is inactive`, id);
        } else {
          ok(`${entry.network}/${asset} confirmed`, `${id} -> ${live.id} (min $${live.minimum})`);
        }
      }
    }

    if (process.env.BREET_DEFAULT_ASSET_ID) {
      const configured = byIdentifier.get(String(process.env.BREET_DEFAULT_ASSET_ID));
      if (configured) ok('BREET_DEFAULT_ASSET_ID is a real asset');
      else bad('BREET_DEFAULT_ASSET_ID is not in the live list', String(process.env.BREET_DEFAULT_ASSET_ID));
    }
  }

  // 3. Withdrawal networks. Drives ON-RAMP, and is where Sivan's float goes.
  console.log('\nwithdrawal networks — can Breet send where we think?');
  const withdrawAssets = await call('/payments/supported-assets-info');
  if (!withdrawAssets.ok) {
    note('could not fetch withdrawal assets', `${withdrawAssets.status} ${withdrawAssets.body?.message ?? ''}`);
  } else {
    const raw = JSON.stringify(withdrawAssets.body?.data ?? withdrawAssets.body ?? {}).toUpperCase();
    for (const entry of BREET_NETWORKS) {
      const net = entry.breetWithdrawalNetwork;
      if (!net) continue;
      if (raw.includes(net)) ok(`withdrawal network ${net} present (${entry.network})`);
      else note(`withdrawal network ${net} not found in the response`, entry.network);
    }
  }

  // 4. Rates. Quotes are priced from this, so a shape change misprices users.
  console.log('\nrate calculator');
  const identifier = process.env.BREET_DEFAULT_ASSET_ID || breetDepositAssetId('solana', 'usdc', 'development');
  const liveList: any[] = (assets.body?.data ?? []) as any[];
  const assetId = liveList.find((a: any) => a.identifier === identifier)?.id;
  if (!assetId) {
    note('no asset id available to price with', String(identifier));
  } else {
    const rate = await call(`/trades/pbc/sell/rate-calculator/${encodeURIComponent(assetId)}`, {
      method: 'POST',
      body: JSON.stringify({ amountInUSD: 1, currency: 'ngn' }),
    });
    if (!rate.ok) {
      bad('rate calculator failed', `${rate.status} ${rate.body?.message ?? ''}`);
    } else {
      const value = Number(rate.body?.data?.rate);
      if (Number.isFinite(value) && value > 0) ok('NGN rate returned', `1 USD = NGN ${value}`);
      else bad('rate missing or not a number', JSON.stringify(rate.body?.data));
    }
  }

  // 5. Banks. Needed for payout and for Sivan's Level 1 identity evidence.
  console.log('\nbanks');
  // currency is REQUIRED - omitting it returns 422, which the docs omit.
  const banks = await call('/payments/banks?currency=ngn');
  if (banks.ok) {
    const list: any[] = banks.body?.data ?? banks.body ?? [];
    if (list.length) ok('bank list fetched', `${list.length} banks, e.g. ${list[0]?.name}`);
    else note('bank list is empty');
  } else {
    note('bank list failed', `${banks.status} ${banks.body?.message ?? ''}`);
  }

  // 6. The adapter's own health check, through the real client.
  console.log('\nadapter health');
  const health = await new BreetNgnProvider().health();
  if (health.available) ok('adapter reports healthy', health.message);
  else bad('adapter reports unhealthy', health.message);

  // 7. Restate the capability facts the map encodes, so a change at Breet is
  //    visible here rather than at a user.
  console.log('\ncapability summary (from the map, verified above)');
  console.log(`  on-ramp capable : ${BREET_NETWORKS.filter((n) => canWithdraw(n.network, 'usdc') || canWithdraw(n.network, 'usdt')).map((n) => n.network).join(', ')}`);
  console.log(`  off-ramp capable: ${BREET_NETWORKS.filter((n) => canDeposit(n.network, 'usdc') || canDeposit(n.network, 'usdt')).map((n) => n.network).join(', ')}`);

  console.log(`\n${pass} passed, ${fail} failed, ${warn} warnings\n`);

  if (fail === 0) {
    console.log('  Next: point the Breet dashboard webhook at');
    console.log('    https://<your-api>/api/webhooks/breet');
    console.log('  then use their mock-trade endpoint to simulate a deposit.\n');
  }

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\n  Smoke test crashed:', error?.message ?? error, '\n');
  process.exit(1);
});
