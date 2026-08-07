/**
 * Production must never reach a mock provider, and sandbox must use real
 * Bridge rather than a simulator.
 *
 * Mock providers invent customer ids (`mock_cust_*`), approve KYC without any
 * verification, and report transfers that never happened. In production that
 * is fabricated compliance data and imaginary money movement. In sandbox it is
 * merely useless: api.sandbox.bridge.xyz is a real Bridge environment, so
 * mocking it tests nothing.
 *
 * The gap this closes: getOfframpProvider() returned the mock immediately when
 * asked for provider 'mock', before any environment check. BRIDGE_MOCK_MODE
 * could be false and production could still get a mock, simply because a
 * routing decision or a stored provider name said 'mock'.
 *
 * Run: npm run test:no-mock-in-production
 */

import { fileURLToPath } from 'node:url';
import { getOfframpProvider } from '../src/providers/provider-registry.js';
import { isMockWalletAllowed } from '../src/wallets/provider/provider-registry.js';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`); }
}

/**
 * The rule is tested as a pure function of APP_ENV rather than by reimporting
 * the registry. config/env.ts caches at first import, so mutating process.env
 * and re-importing changes nothing - the earlier version of this test passed
 * for the wrong reason.
 */

async function main() {
  console.log('\nNo mock in production; real Bridge in sandbox\n');

  console.log('1. The current environment');
  const { env } = await import('../src/config/env.js');
  const offramp = getOfframpProvider();
  check('off-ramp provider is not mock', offramp.name !== 'mock', offramp.name);
  check('BRIDGE_MOCK_MODE is false', env.BRIDGE_MOCK_MODE === false, String(env.BRIDGE_MOCK_MODE));
  check('BRIDGE_BASE_URL points at a real Bridge host',
    /bridge\.xyz/.test(env.BRIDGE_BASE_URL), env.BRIDGE_BASE_URL);
  check('sandbox uses the real Bridge sandbox, not a simulator',
    env.BRIDGE_BASE_URL.includes('sandbox') || env.APP_ENV === 'production',
    env.BRIDGE_BASE_URL);

  console.log('\n2. Production refuses the mock off-ramp provider');
  const { isMockOfframpAllowed, mockOfframpBlockedMessage } =
    await import('../src/providers/provider-registry.js');

  check('production does not allow a mock off-ramp', !isMockOfframpAllowed('production'));
  check('the refusal explains the risk',
    /fabricates/i.test(mockOfframpBlockedMessage('production', 'test')),
    mockOfframpBlockedMessage('production', 'test').slice(0, 100));
  check('the refusal names the offending environment',
    mockOfframpBlockedMessage('production', 'test').includes('production'));

  // The bug this guards: getOfframpProvider() used to return the mock the
  // instant providerName === 'mock', before any environment check. A routing
  // decision or a stored provider name could therefore hand production a mock.
  const source = await import('node:fs/promises').then((fs) =>
    // fileURLToPath, not .pathname: .pathname leaves the URL percent-encoded, so
    // a checkout under a directory with a space (".../Project X/...") resolved to
    // ".../Project%20X/..." and the read failed with ENOENT. The suite passed in
    // CI purely because that path has no spaces.
    fs.readFile(fileURLToPath(new URL('../src/providers/provider-registry.ts', import.meta.url)), 'utf8')
  );
  check("an explicit 'mock' request now goes through the guard",
    /providerName === 'mock'[\s\S]{0,200}assertMockAllowed/.test(source),
    'the mock must not be returned before the environment is checked');
  check('BRIDGE_MOCK_MODE=true also goes through the guard',
    /env\.BRIDGE_MOCK_MODE[\s\S]{0,160}assertMockAllowed/.test(source));

  console.log('\n3. Non-production may still mock deliberately');
  check('development can use the mock for offline work', isMockOfframpAllowed('development'));
  check('staging can too, when explicitly asked', isMockOfframpAllowed('staging'));

  console.log('\n4. Wallet provider');
  check('production never allows mock wallets', !isMockWalletAllowed('production'));
  check('production ignores an ALLOW_MOCK_WALLETS override',
    !isMockWalletAllowed('production', 'true'),
    'no env var may point real money at an address nobody controls');
  check('staging blocks mock wallets by default', !isMockWalletAllowed('staging'));

  console.log('\n5. Sandbox KYC must be real, not forced');
  const customers = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../src/customers/customers.service.ts', import.meta.url), 'utf8')
  );
  check('force-approval is blocked in production',
    /APP_ENV === 'production'[\s\S]{0,120}throw forbidden/.test(customers));
  check('force-approval requires BRIDGE_MOCK_MODE, so it is inert against real Bridge',
    /!env\.BRIDGE_MOCK_MODE/.test(customers),
    'sandbox runs BRIDGE_MOCK_MODE=false, so this route cannot fire');
  check('force-approval refuses non-mock customers outright',
    /customer\.provider !== 'mock'[\s\S]{0,160}throw forbidden/.test(customers),
    'a real Bridge customer can only be approved by Bridge');

  console.log(`\n=====  PASS: ${pass}   FAIL: ${fail}  =====\n`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
