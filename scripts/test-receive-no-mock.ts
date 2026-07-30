/**
 * The Receive screen must never show a mock address.
 *
 * A mock address is a deterministic string that belongs to nobody. Anything
 * sent to one is gone. The wallet adapter is selected by WALLET_PROVIDER,
 * which defaulted to 'mock' when unset - so simply forgetting to set it meant
 * the Receive screen would hand out a fake address that looks entirely real.
 *
 * These assertions verify the configured environment resolves to a genuine
 * provider and that the data reaching the UI is real, rather than checking
 * that some code path exists.
 *
 * Run: npm run test:receive-no-mock
 */

import { getWalletProvider } from '../src/wallets/provider/provider-registry.js';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`); }
}

const SANDBOX_CUSTOMER =
  process.env.SANDBOX_TEST_CUSTOMER_ID || '49a3dfe9-9a5b-42ce-aa7c-bb0d68ac4580';

async function main() {
  console.log('\nReceive screen uses real wallets, not mock\n');

  console.log('1. Configured provider');
  const provider = getWalletProvider();
  check('WALLET_PROVIDER resolves to a real provider, not mock',
    provider.name !== 'mock',
    `got "${provider.name}" - unset WALLET_PROVIDER silently defaults to mock`);
  check('provider is bridge', provider.name === 'bridge', provider.name);
  check('custody model is stated as custodial', provider.custodyModel === 'custodial');

  if (provider.name !== 'bridge') {
    console.log('\n  Not pointed at Bridge; skipping live checks.\n');
    console.log(`\n=====  PASS: ${pass}   FAIL: ${fail}  =====\n`);
    process.exit(fail > 0 ? 1 : 0);
  }

  const base = process.env.BRIDGE_BASE_URL || '';
  check('pointed at Bridge sandbox, not production', base.includes('sandbox'), base);

  console.log('\n2. The address shown is a real Bridge wallet');
  const wallets = await provider.listWallets(SANDBOX_CUSTOMER);
  check('the customer has at least one wallet', wallets.length > 0,
    'run sandbox:e2e-wallet-va --apply first');

  if (!wallets.length) {
    console.log(`\n=====  PASS: ${pass}   FAIL: ${fail}  =====\n`);
    process.exit(1);
  }

  const wallet = wallets.find((w) => w.chain === 'solana') ?? wallets[0];
  console.log(`  ${wallet.chain} ${wallet.address}`);

  // The mock adapter generates addresses from a seeded hash. A real Solana
  // address is base58, 32-44 chars, and will not carry a mock marker.
  check('the provider id is a real Bridge id, not mock_wallet_*',
    !wallet.providerWalletId.startsWith('mock_'),
    wallet.providerWalletId);
  check('the address is Solana base58, not 0x',
    !wallet.address.startsWith('0x') && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet.address),
    wallet.address);
  check('the wallet is reported as custodial, so the UI can say who holds it',
    wallet.custodyModel === 'custodial');
  check('no user signature is required, as Bridge signs server-side',
    wallet.requiresUserSignature === false);

  console.log('\n3. Balances are read through to Bridge');
  const balances = await provider.getBalances(wallet.providerWalletId, SANDBOX_CUSTOMER);
  check('balances come back as an array', Array.isArray(balances));
  check('amounts are strings, never floats',
    balances.every((b) => typeof b.amount === 'string'),
    'parsing money to a number introduces drift');

  const assets = balances.map((b) => b.asset);
  check('USDC is available on this wallet', assets.includes('usdc'), JSON.stringify(assets));
  check('USDT is available on the SAME wallet', assets.includes('usdt'),
    'this is why Solana was chosen: Base cannot carry USDT');
  check('assets Sivan does not support are filtered out',
    !assets.some((a) => !['usdc', 'usdt'].includes(a)),
    `Bridge also returns eurc/pyusd/usdb; got ${JSON.stringify(assets)}`);

  console.log('\n4. One wallet serves both doors');
  // The Receive address and the virtual account destination must be the same
  // wallet, or a user would have two balances and no way to reconcile them.
  const { BridgeClient } = await import('../src/providers/bridge/bridge.client.js');
  const client = new BridgeClient();
  const vas = await client.request<any>(`/customers/${SANDBOX_CUSTOMER}/virtual_accounts`);
  const va = (vas.data || [])[0];

  if (!va) {
    check('a virtual account exists to compare against', false,
      'run sandbox:e2e-wallet-va --apply to create one');
  } else {
    // Bridge does not echo bridge_wallet_id on read; it returns the wallet's
    // on-chain address instead. Comparing addresses is the reliable check.
    check('the VA settles into the SAME address Receive displays',
      va.destination?.address === wallet.address,
      `VA -> ${va.destination?.address}, Receive -> ${wallet.address}`);
    check('the VA rail matches the wallet chain',
      String(va.destination?.payment_rail).toLowerCase() === wallet.chain);
  }

  console.log(`\n=====  PASS: ${pass}   FAIL: ${fail}  =====\n`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error('\nFAILED:', error?.message || error);
  process.exit(1);
});
