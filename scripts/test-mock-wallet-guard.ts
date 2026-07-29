/**
 * Mock wallet addresses belong to nobody. Funds sent to one are gone.
 *
 * The original guard only blocked mock in production, but the test service
 * runs APP_ENV=staging, so a real user on sivan-payments-user-test could have
 * been handed a fake address presented as real. These assertions lock the
 * corrected behaviour in place:
 *
 *   development           -> mock allowed (normal local work)
 *   staging/test/anything -> mock BLOCKED unless ALLOW_MOCK_WALLETS=true
 *   production            -> mock ALWAYS blocked, no override honoured
 *
 * Run: npm run test:mock-wallet-guard
 */

import {
  isMockWalletAllowed,
  mockWalletBlockedMessage,
} from '../src/wallets/provider/provider-registry.js';

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    fail += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}

console.log('\nMock wallet provider guard\n');

check('development allows mock', isMockWalletAllowed('development'));
check('development allows mock without the flag', isMockWalletAllowed('development', undefined));

check('staging blocks mock by default', !isMockWalletAllowed('staging'));
check('test blocks mock by default', !isMockWalletAllowed('test'));
check('an unknown env blocks mock by default', !isMockWalletAllowed('preview'));
check('empty APP_ENV blocks mock', !isMockWalletAllowed(''));

check('staging allows mock with ALLOW_MOCK_WALLETS=true', isMockWalletAllowed('staging', 'true'));
check('the flag is case-insensitive', isMockWalletAllowed('staging', 'TRUE'));
check('ALLOW_MOCK_WALLETS=false does not unlock staging', !isMockWalletAllowed('staging', 'false'));
check('a junk flag value does not unlock staging', !isMockWalletAllowed('staging', 'yes'));
check('an empty flag does not unlock staging', !isMockWalletAllowed('staging', ''));

check('production blocks mock', !isMockWalletAllowed('production'));

// The critical one. An override variable must never be able to point real
// customer money at an address nobody controls.
check(
  'production ignores ALLOW_MOCK_WALLETS=true',
  !isMockWalletAllowed('production', 'true'),
  'override leaked into production'
);
check('production ignores ALLOW_MOCK_WALLETS=TRUE', !isMockWalletAllowed('production', 'TRUE'));

const message = mockWalletBlockedMessage('staging');
check('the refusal names the offending environment', message.includes('staging'), message);
check(
  'the refusal explains funds are unrecoverable',
  /cannot be recovered/i.test(message),
  message
);
check(
  'the refusal points at the real fix',
  /WALLET_PROVIDER=bridge/.test(message),
  message
);

console.log(`\n=====  PASS: ${pass}   FAIL: ${fail}  =====\n`);
if (fail > 0) process.exit(1);
