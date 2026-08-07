/**
 * BOOT-TIME REFUSAL FOR PRODUCTION MISCONFIGURATION.
 *
 * The existing guards in buildApp() catch a missing ADMIN_API_KEY, a default
 * USER_JWT_SECRET, and a stray sandbox bank-resolution override. This adds the
 * two that the custody model now depends on, and they share a failure shape
 * that the others do not:
 *
 *   THEY FAIL LATE, AND THEY FAIL QUIETLY.
 *
 * VIRTUAL_ACCOUNT_PROVIDER defaults to 'mock' in env.ts. The registry does
 * refuse mock in production - but only when someone ASKS for a provider, which
 * is when a user requests a virtual account. So a production deploy with the
 * variable unset boots green, serves every other route, and fails on one
 * user's request hours later. render.yaml's own comment records that this
 * already happened: "Was unset, and env.ts defaults VIRTUAL_ACCOUNT_PROVIDER
 * to mock. A production virtual account must be issued by Bridge, not
 * fabricated."
 *
 * BRIDGE_WALLETS_APPROVED is the same shape in reverse. Bridge require Legal &
 * Compliance sign-off on the wallet fund flow before production use, and
 * getWalletProvider('bridge') throws without it - again lazily. With virtual
 * accounts settling into Bridge wallets and the Bridge -> Privy sweep reading
 * them, a missing flag means VA settlement silently stops working for
 * everyone, discovered from a support ticket.
 *
 * Both are one-line environment mistakes with no visible symptom at deploy
 * time. That is precisely what a boot assertion is for.
 *
 * Run: npm run test:production-config-guards
 */

import assert from 'node:assert/strict';

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { assertProductionWalletConfig } = await import('../src/config/production-guards.js');

type Cfg = Parameters<typeof assertProductionWalletConfig>[0];

const base: Cfg = {
  appEnv: 'production',
  virtualAccountsEnabled: true,
  virtualAccountProvider: 'bridge',
  bridgeWalletsApproved: 'true',
  activeWalletProvider: 'privy',
};

function refusal(overrides: Partial<Cfg>): string | null {
  try {
    assertProductionWalletConfig({ ...base, ...overrides });
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 1. a correctly configured production boots ───────────────');

check('the known-good production config is accepted', refusal({}) === null, String(refusal({})));
check('and so is bridge as the active wallet provider',
  refusal({ activeWalletProvider: 'bridge' }) === null, String(refusal({ activeWalletProvider: 'bridge' })));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 2. a MOCK virtual account provider in production ─────────');

/**
 * The exact regression render.yaml documents. A fabricated virtual account
 * hands a user bank details that no bank will honour - they wire real money to
 * an account number that does not exist.
 */
const mockVa = refusal({ virtualAccountProvider: 'mock' });
check('mock VA provider is REFUSED at boot', Boolean(mockVa), String(mockVa));
check('and the message names the variable',
  /VIRTUAL_ACCOUNT_PROVIDER/.test(String(mockVa)), String(mockVa));
check('and says what it should be', /bridge/i.test(String(mockVa)), String(mockVa));

/**
 * UNSET is the real-world case, not an explicit 'mock'. env.ts turns an unset
 * variable INTO 'mock', so the guard has to catch the value, not the absence.
 */
check('an unset VA provider is refused the same way',
  Boolean(refusal({ virtualAccountProvider: undefined as any })),
  String(refusal({ virtualAccountProvider: undefined as any })));

/**
 * ONLY WHEN VIRTUAL ACCOUNTS ARE ON. A deployment that does not offer them at
 * all must not be crash-looped over a provider it never calls - that would
 * take down NGN off-ramp, balances and support over an unused feature.
 */
check('mock is tolerated when virtual accounts are DISABLED',
  refusal({ virtualAccountProvider: 'mock', virtualAccountsEnabled: false }) === null,
  'refusing here would crash-loop a deployment that never issues a VA');

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 3. BRIDGE_WALLETS_APPROVED ───────────────────────────────');

/**
 * Virtual accounts settle INTO a Bridge wallet. Without the flag,
 * getWalletProvider('bridge') throws, so settlement and the Bridge -> Privy
 * sweep both fail - for every user, silently, until someone reads an audit log.
 */
const noFlag = refusal({ bridgeWalletsApproved: '' });
check('a missing flag is refused when VAs are on', Boolean(noFlag), String(noFlag));
check('and the message names the variable',
  /BRIDGE_WALLETS_APPROVED/.test(String(noFlag)), String(noFlag));
check('and explains it is a compliance attestation, not a toggle',
  /compliance|approval|sign-off/i.test(String(noFlag)), String(noFlag));

check('an explicit false is refused', Boolean(refusal({ bridgeWalletsApproved: 'false' })));
check('a typo is refused rather than treated as true',
  Boolean(refusal({ bridgeWalletsApproved: 'yes' })),
  'only the literal string true may satisfy a compliance attestation');
check('TRUE in any case is accepted',
  refusal({ bridgeWalletsApproved: 'TRUE' }) === null && refusal({ bridgeWalletsApproved: ' True ' }) === null);

/**
 * Also required when Bridge ISSUES wallets, even with VAs off - that is the
 * other way a Bridge wallet comes into existence.
 */
check('required when bridge is the active wallet provider, even with VAs off',
  Boolean(refusal({ bridgeWalletsApproved: '', virtualAccountsEnabled: false, activeWalletProvider: 'bridge' })),
  'bridge issuing wallets needs the same approval');

check('NOT required when nothing uses Bridge wallets',
  refusal({ bridgeWalletsApproved: '', virtualAccountsEnabled: false, activeWalletProvider: 'privy' }) === null,
  'a Privy-only deployment with no VAs never constructs a Bridge wallet provider');

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 4. it only applies where it should ───────────────────────');

/**
 * The guard must not crash-loop the test rig. api-test runs APP_ENV=staging
 * with mock providers on purpose - a previous guard in this file was written
 * production-or-staging and would have taken it down, which is recorded in
 * app.ts. Staging is deliberately excluded here for that reason.
 */
for (const appEnv of ['development', 'test', 'staging'] as const) {
  check(`${appEnv} is left alone`,
    refusal({ appEnv, virtualAccountProvider: 'mock', bridgeWalletsApproved: '' }) === null,
    `${appEnv} must stay usable with mock providers`);
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 5. the real production values from render.yaml pass ──────');

/**
 * Read from the blueprint rather than retyped, so a value changed there
 * without thinking is caught here. This is the config that will actually boot.
 */
const fs = await import('node:fs');
const blueprint = fs.readFileSync('render.yaml', 'utf8');
const hasVaBridge = /VIRTUAL_ACCOUNT_PROVIDER\s*\n\s*value:\s*bridge/.test(blueprint);
const hasApproval = /BRIDGE_WALLETS_APPROVED\s*\n\s*value:\s*"true"/.test(blueprint);
check('render.yaml declares VIRTUAL_ACCOUNT_PROVIDER=bridge', hasVaBridge);
check('render.yaml declares BRIDGE_WALLETS_APPROVED="true"', hasApproval);
check('and those exact values satisfy the guard',
  refusal({ virtualAccountProvider: 'bridge', bridgeWalletsApproved: 'true' }) === null);

assert.ok(true);
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
