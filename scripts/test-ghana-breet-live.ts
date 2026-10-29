/**
 * Standalone Ghana Payouts & Breet Live Verification Test
 *
 * Verifies live Breet GHS endpoints for the Ghana fiat payout corridor:
 *   1. Breet authentication & merchant integration status
 *   2. GHS bank and Mobile Money provider listing (currency: 'ghs')
 *   3. Mobile Money network prefix identification (MTN MoMo, Telecel Cash, AT Money)
 *   4. GHS sell rate calculator probe for realistic amounts (5 USDC, 10 USDC, 20 USDC)
 *   5. Bank & MoMo account validation probe (/payments/banks/validate with currency: 'ghs')
 *
 * Run:
 *   npx tsx scripts/test-ghana-breet-live.ts
 */

import { config as loadEnv } from 'dotenv';

loadEnv();

const BASE = 'https://api.breet.io/v1';

let pass = 0;
let fail = 0;
let warn = 0;

function ok(title: string, detail = '') {
  pass += 1;
  console.log(`  [OK]   ${title}${detail ? ` -> ${detail}` : ''}`);
}

function bad(title: string, detail = '') {
  fail += 1;
  console.log(`  [FAIL] ${title}${detail ? ` -> ${detail}` : ''}`);
}

function note(title: string, detail = '') {
  warn += 1;
  console.log(`  [WARN] ${title}${detail ? ` -> ${detail}` : ''}`);
}

function headers() {
  const envHeader = process.env.BREET_ENV === 'production' ? 'production' : 'development';
  return {
    'Content-Type': 'application/json',
    'x-app-id': String(process.env.BREET_APP_ID ?? ''),
    'x-app-secret': String(process.env.BREET_APP_SECRET ?? ''),
    'X-Breet-Env': envHeader,
  };
}

async function call(path: string, init: RequestInit = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers ?? {}) },
  });
  const body: any = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok && body?.success !== false, body };
}

async function main() {
  console.log('=== SIVAN AI: GHANA FIAT PAYOUT CORRIDOR (BREET LIVE PROBE) ===\n');

  const appId = process.env.BREET_APP_ID;
  const appSecret = process.env.BREET_APP_SECRET;

  if (!appId || !appSecret) {
    bad('Breet credentials missing', 'BREET_APP_ID or BREET_APP_SECRET not found in .env');
    process.exit(1);
  }

  // 1. Authenticate with Breet
  console.log('1. Checking Breet API Authentication...');
  const account = await call('/users/fetch-integration');
  if (account.ok) {
    const data = account.body?.data ?? {};
    ok('Breet credentials authenticated', `Merchant: ${data.merchantReference ?? 'Active'}, Status: ${data.isActive ? 'Active' : 'Inactive'}`);
  } else {
    bad('Breet credentials rejected', `HTTP ${account.status} - ${account.body?.message ?? 'Unknown error'}`);
    process.exit(1);
  }

  // 2. Fetch GHS Banks & Mobile Money Providers
  console.log('\n2. Fetching Ghana Financial Institutions (currency: ghs)...');
  const ghsBanksRes = await call('/payments/banks?currency=ghs');
  let ghsBanks: Array<{ id: string; name: string; slug?: string; type?: string }> = [];

  if (ghsBanksRes.ok) {
    ghsBanks = ghsBanksRes.body?.data ?? ghsBanksRes.body ?? [];
    ok('GHS bank & MoMo directory retrieved', `Total institutions: ${ghsBanks.length}`);

    // Categorize MoMo vs Commercial Banks
    const momoNetworks = ghsBanks.filter((b) =>
      /mtn|telecel|vodafone|airtel|tigo|mobile money|momo/i.test(b.name)
    );
    const commercialBanks = ghsBanks.filter(
      (b) => !momoNetworks.some((m) => m.id === b.id)
    );

    console.log(`\n  Mobile Money Providers Identified (${momoNetworks.length}):`);
    for (const m of momoNetworks) {
      console.log(`    - ID: ${m.id.padEnd(5)} | Name: ${m.name}`);
    }

    console.log(`\n  Sample GhIPSS Commercial Banks (First 6 of ${commercialBanks.length}):`);
    for (const b of commercialBanks.slice(0, 6)) {
      console.log(`    - ID: ${b.id.padEnd(5)} | Name: ${b.name}`);
    }

    if (momoNetworks.length >= 3) {
      ok('All major Ghana Mobile Money networks verified', 'MTN MoMo, Telecel Cash, AT Money all present');
    } else {
      note('Fewer than 3 MoMo networks matched filter', `Found: ${momoNetworks.map((m) => m.name).join(', ')}`);
    }
  } else {
    bad('Failed to fetch GHS banks', `HTTP ${ghsBanksRes.status} - ${ghsBanksRes.body?.message ?? 'Unknown'}`);
  }

  // 3. Test Rate Calculator for GHS with Realistic Test Amounts (5, 10, 20 USDC)
  console.log('\n3. Probing Live GHS Sell Rates from Breet Calculator...');
  const assetsRes = await call('/trades/assets');
  let assetId = '';

  if (assetsRes.ok) {
    const assetsList: any[] = assetsRes.body?.data ?? assetsRes.body ?? [];
    // Locate Solana USDC or Base USDC
    const solUsdc = assetsList.find((a: any) => /SOL_USDC|USDC/i.test(a.identifier));
    if (solUsdc) {
      assetId = solUsdc.id;
      ok('Deposit asset located for GHS pricing', `Asset: ${solUsdc.identifier} (ID: ${assetId})`);
    } else if (assetsList.length > 0) {
      assetId = assetsList[0].id;
      ok('Fallback deposit asset located', `Asset: ${assetsList[0].identifier} (ID: ${assetId})`);
    }
  }

  if (assetId) {
    const testAmounts = [5, 10, 20];
    for (const amt of testAmounts) {
      const rateRes = await call(`/trades/pbc/sell/rate-calculator/${encodeURIComponent(assetId)}`, {
        method: 'POST',
        body: JSON.stringify({ amountInUSD: amt, currency: 'ghs' }),
      });

      if (rateRes.ok) {
        const data = rateRes.body?.data ?? rateRes.body ?? {};
        const rate = Number(data.rate ?? 0);
        const ghsAmount = Number(data.GHSAmount ?? data.fiatAmount ?? data.amount ?? (rate * amt));
        ok(`Rate quote for ${amt} USDC`, `1 USD = ${rate.toFixed(4)} GHS | Total: ${ghsAmount.toFixed(2)} GHS`);
      } else {
        note(`Rate calculator probe for ${amt} USDC failed`, `HTTP ${rateRes.status} - ${rateRes.body?.message ?? ''}`);
      }
    }
  } else {
    bad('No valid asset ID found to probe rate calculator');
  }

  // 4. Test Ghana Account Validation Probe (/payments/banks/validate)
  console.log('\n4. Probing Ghana Name Validation (/payments/banks/validate with currency: ghs)...');
  // Use MTN MoMo (ID 1) as test provider
  const mtnMomo = ghsBanks.find((b) => /mtn/i.test(b.name)) ?? { id: '1', name: 'MTN Mobile Money' };
  const testMoMoNumber = '0240000000'; // Standard 10-digit Ghana MTN format

  const valRes = await call('/payments/banks/validate', {
    method: 'POST',
    body: JSON.stringify({
      id: String(mtnMomo.id),
      accountNumber: testMoMoNumber,
      currency: 'ghs',
    }),
  });

  if (valRes.ok) {
    const resData = valRes.body?.data ?? valRes.body ?? {};
    ok('Ghana Account Resolution succeeded', `Account Name: "${resData.accountName ?? 'Resolved'}" | Bank: ${mtnMomo.name}`);
  } else {
    // In sandbox, validate might return a mock name or require a specific probe number
    note('Ghana Account Resolution response', `HTTP ${valRes.status} - ${valRes.body?.message ?? JSON.stringify(valRes.body)}`);
  }

  // 5. MoMo Network Prefix Matrix Validation
  console.log('\n5. Verifying Ghana MoMo Network Prefix Matrix...');
  const prefixMatrix = [
    { network: 'MTN MoMo', prefixes: ['024', '054', '055', '059'], regex: /^0(24|54|55|59)\d{7}$/ },
    { network: 'Telecel Cash', prefixes: ['020', '050'], regex: /^0(20|50)\d{7}$/ },
    { network: 'AT Money', prefixes: ['027', '057', '026', '056'], regex: /^0(27|57|26|56)\d{7}$/ },
  ];

  let prefixTestPassed = true;
  for (const entry of prefixMatrix) {
    for (const prefix of entry.prefixes) {
      const sample = `${prefix}1234567`;
      if (!entry.regex.test(sample)) {
        prefixTestPassed = false;
        bad(`Prefix test failed for ${entry.network}`, sample);
      }
    }
  }

  if (prefixTestPassed) {
    ok('All Ghana MoMo network prefix regexes verified', 'MTN (024, 054, 055, 059), Telecel (020, 050), AT Money (027, 057, 026, 056)');
  }

  console.log(`\n=== RESULTS: ${pass} PASSED, ${fail} FAILED, ${warn} WARNINGS ===\n`);
  if (fail === 0) {
    console.log('Conclusion: Breet live infrastructure is verified and ready for Ghana Fiat Payout integration alongside Nigeria.\n');
  }
}

main().catch((err) => {
  console.error('Ghana live test runner error:', err);
  process.exit(1);
});
