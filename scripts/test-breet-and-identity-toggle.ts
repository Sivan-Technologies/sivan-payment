/**
 * Breet as primary NGN provider, and the admin identity toggle.
 *
 * Two features, one script, because they interact: the toggle decides whether a
 * user can reach Level 2 at all, and Level 2 is what the NGN rails check.
 *
 * The cases that matter:
 *
 *   - the toggle actually changes who can transact, in both positions
 *   - Breet's webhook secret is compared safely and fails CLOSED when unset
 *   - Breet's on-ramp refuses loudly rather than inventing an instruction
 *   - a flagged deposit lands in review, not in "completed"
 *
 * Run: npm run test:breet-identity
 */

process.env.BREET_APP_ID = process.env.BREET_APP_ID || 'test_app_id';
process.env.BREET_APP_SECRET = process.env.BREET_APP_SECRET || 'test_app_secret';
process.env.BREET_WEBHOOK_SECRET = process.env.BREET_WEBHOOK_SECRET || 'whsec_breet_test';
process.env.BREET_DEFAULT_ASSET_ID = process.env.BREET_DEFAULT_ASSET_ID || 'asset_usdt_sol';

import { db } from '../src/database/json-database.js';
import { BreetNgnProvider, BREET_WEBHOOK_IPS } from '../src/ngn/provider/breet.provider.js';
import { getNgnProvider } from '../src/ngn/provider/ngn-provider-registry.js';
import { getVerificationState } from '../src/kyc/service/verification-state.js';
import { VerificationLevel } from '../src/kyc/types/verification.types.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function threwAsync(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error: any) {
    return String(error?.message ?? error);
  }
}

async function setIdentityToggle(enabled: boolean) {
  await db.mutate((data: any) => {
    data.ngnControls = [
      {
        id: 'global',
        onrampEnabled: true,
        offrampEnabled: true,
        mockProviderEnabled: true,
        bankSettlementEnabled: false,
        virtualAccountEnabled: false,
        activeProvider: 'mock',
        identityVerificationEnabled: enabled,
        maxTransactionNgn: '100000000',
        dailyLimitNgn: '100000000',
        highValueReviewThresholdNgn: '100000000',
        updatedBy: 'test',
        updatedAt: new Date().toISOString(),
      },
    ];
  });
}

async function seedUsers() {
  await db.mutate((data: any) => {
    data.users = [
      { id: 'u_bank', email: 'bank@t.ng', createdAt: new Date().toISOString() },
      { id: 'u_bridge', email: 'bridge@t.ng', createdAt: new Date().toISOString() },
    ];
    // u_bank: payout account verified, no Bridge customer.
    // u_bridge: same, plus Bridge KYC approved.
    data.customers = [
      {
        id: 'cus_b', userId: 'u_bridge', provider: 'bridge', providerCustomerId: 'br_1',
        kycStatus: 'kyc_approved', tosStatus: 'approved',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ];
    data.externalAccounts = [
      { id: 'e1', userId: 'u_bank', status: 'verified', currency: 'ngn', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: 'e2', userId: 'u_bridge', status: 'verified', currency: 'ngn', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ];
    data.ngnTransfers = [];
    data.ngnQuotes = [];
  });
}

async function main() {
  await seedUsers();

  console.log('\nidentity toggle OFF - the MVP position');
  {
    await setIdentityToggle(false);

    // The point of the toggle: no NIN/BVN provider exists, so requiring
    // identity would strand everyone at Level 1 with no way to clear it.
    const bank = await getVerificationState('u_bank');
    check('a bank-verified user reaches Level 2 without any NIN/BVN',
      bank.level === VerificationLevel.IDENTITY, `level ${bank.level}`);
    check('and can therefore transact up to the Level 2 ceiling',
      bank.level >= VerificationLevel.IDENTITY);
  }

  console.log('\nidentity toggle ON - the post-provider position');
  {
    await setIdentityToggle(true);

    const bank = await getVerificationState('u_bank');
    check('the same user now stops at Level 1',
      bank.level === VerificationLevel.BANK, `level ${bank.level}`);

    // Bridge-approved users still clear, because Bridge verifies a national
    // identity number for non-US residents and accepts nin/bvn/tin for Nigeria.
    const bridge = await getVerificationState('u_bridge');
    check('a Bridge-approved user still reaches Level 2',
      bridge.level === VerificationLevel.IDENTITY, `level ${bridge.level}`);
  }

  console.log('\nthe toggle is genuinely load-bearing');
  {
    await setIdentityToggle(false);
    const off = (await getVerificationState('u_bank')).level;
    await setIdentityToggle(true);
    const on = (await getVerificationState('u_bank')).level;
    check('flipping it changes the outcome for the same user', off !== on,
      `off=${off} on=${on}`);
    await setIdentityToggle(false);
  }

  console.log('\nBreet is registered as a provider');
  {
    const provider = getNgnProvider('breet' as any);
    check('the registry returns the Breet adapter', provider.name === 'breet', provider.name);
    check('it is not silently falling back to mock', !(provider as any).constructor.name.includes('Mock'));
  }

  console.log('\nBreet webhook verification');
  {
    const breet = new BreetNgnProvider();

    const good = await breet.verifyWebhook(
      { id: 'trade_1', event: 'trade.completed' },
      { 'x-webhook-secret': 'whsec_breet_test' }
    );
    check('a correct secret verifies', good.providerEventId === 'trade_1:trade.completed',
      good.providerEventId);

    // Breet's own guidance: use id AND event together to detect duplicates,
    // because one trade emits pending then completed.
    const pending = await breet.verifyWebhook(
      { id: 'trade_1', event: 'trade.pending' },
      { 'x-webhook-secret': 'whsec_breet_test' }
    );
    check('the same trade at a different stage is a DIFFERENT event',
      pending.providerEventId !== good.providerEventId);

    const wrong = await threwAsync(() =>
      breet.verifyWebhook({ id: 'x' }, { 'x-webhook-secret': 'wrong_secret_here' })
    );
    check('a wrong secret is rejected', wrong !== undefined);

    const missing = await threwAsync(() => breet.verifyWebhook({ id: 'x' }, {}));
    check('a missing secret header is rejected', missing !== undefined);

    // Fails CLOSED. An unauthenticated webhook that credits balances is worse
    // than a broken one. Asserted on the source rather than by reloading the
    // module: tsx compiles to CJS here, so a cache-busted dynamic import does
    // not produce a fresh module and the test would silently prove nothing.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/ngn/provider/breet.provider.ts', import.meta.url), 'utf8')
    );
    check('an unconfigured secret fails CLOSED, not open',
      /if \(!configured\) throw forbidden\('BREET_WEBHOOK_SECRET is not configured/.test(source),
      'the guard is missing from verifyWebhook');
  }

  console.log('\nBreet IP allowlist is available for defence in depth');
  {
    check('the documented IPs are exported', BREET_WEBHOOK_IPS.length === 5,
      `${BREET_WEBHOOK_IPS.length} entries`);
    check('and include a known Breet address', BREET_WEBHOOK_IPS.includes('46.101.201.155'));
  }

  console.log('\nBreet on-ramp: validation before any float leaves');
  {
    const breet = new BreetNgnProvider();
    const quote = (over: any = {}) => ({
      id: 'q_on_1', userId: 'u_bank', destinationAmount: '10',
      destinationCurrency: 'usdc', metadata: {}, ...over,
    }) as any;

    // Breet's on-ramp spends SIVAN'S pre-funded USD balance. Every guard here
    // exists because getting it wrong sends real working capital somewhere
    // unrecoverable.
    const noAddress = await threwAsync(() => breet.createOnrampTransfer(quote()));
    check('refuses with no destination wallet', noAddress !== undefined);
    check('and says so plainly', /destination wallet/i.test(noAddress ?? ''), noAddress);

    const badToken = await threwAsync(() =>
      breet.createOnrampTransfer(quote({ metadata: { recipientAddress: 'A1', token: 'DAI' } }))
    );
    check('refuses an unsupported token', /USDC and USDT/i.test(badToken ?? ''), badToken);

    // Breet documents USDC as unavailable on TON.
    const usdcOnTon = await threwAsync(() =>
      breet.createOnrampTransfer(quote({ metadata: { recipientAddress: 'A1', token: 'USDC', network: 'TON' } }))
    );
    check('refuses USDC on TON, which Breet does not support',
      /USDC on TON/i.test(usdcOnTon ?? ''), usdcOnTon);

    const badAmount = await threwAsync(() =>
      breet.createOnrampTransfer(quote({
        destinationAmount: '0', metadata: { recipientAddress: 'A1', token: 'USDC' },
      }))
    );
    check('refuses a zero amount', /invalid on-ramp amount/i.test(badAmount ?? ''), badAmount);
  }

  console.log('\nBreet on-ramp is float-funded, and says so');
  {
    // Stated in code because it is a commercial commitment, not a detail:
    // Breet's on-ramp spends Sivan's own pre-funded USD balance, so every
    // on-ramp draws down working capital.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/ngn/provider/breet.provider.ts', import.meta.url), 'utf8')
    );
    check('the float model is documented at the call site',
      /FLOAT MODEL, NOT A PASS-THROUGH/.test(source));
    check('the balance is checked before sending',
      /insufficient balance|usdBalance < amountUsd/.test(source));
    check('transfers are marked as float-funded for operations',
      /fundedFromSivanFloat: true/.test(source));
    check('externalId is the quote id, so a retry cannot double-send',
      /externalId = `sivan_onramp_\$\{quote\.id\}`/.test(source),
      'retrying a quote could send stablecoin twice');
  }

  console.log('\nBreet requires configuration before it will act');
  {
    // Credentials cannot genuinely be unset at runtime here: env.ts parses once
    // at import, and this script's npm invocation supplies them, so deleting
    // process.env afterwards proves nothing. Assert the guard on the source
    // instead - a test that appears to pass while exercising nothing is worse
    // than no test.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/ngn/provider/breet.provider.ts', import.meta.url), 'utf8')
    );
    check('health() short-circuits when credentials are absent',
      /const configured = Boolean\(appId && appSecret\);/.test(source) &&
      /if \(!configured\) \{[\s\S]{0,400}available: false/.test(source),
      'health() would call Breet even with no credentials');
    check('every request requires both credentials',
      /if \(!appId \|\| !appSecret\) throw forbidden\('Breet credentials are not configured/.test(source),
      'headers() does not guard on credentials');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
