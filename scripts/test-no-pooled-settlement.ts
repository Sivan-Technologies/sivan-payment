/**
 * Pooled settlement must stay dead.
 *
 * Virtual accounts once settled into a single Sivan-owned wallet configured by
 * BRIDGE_VIRTUAL_ACCOUNT_BRIDGE_WALLET_ID / _DESTINATION_ADDRESS. Every user's
 * deposit landed in the same place, which made Sivan the holder of user funds
 * and is prohibited by Bridge ToS 2.1(m).
 *
 * The backend was fixed, but the configuration surface was not: the schema
 * still accepted the fields, the env still defined them, and the Admin Hub
 * still rendered inputs for them. An operator could set a pooled wallet id and
 * reasonably believe funds routed there.
 *
 * These assertions cover the whole surface, not just the provider:
 *   - the settings API REJECTS the pooled fields rather than ignoring them
 *   - a historical saved value cannot resurrect them on read
 *   - the env schema no longer defines them
 *   - the Admin Hub no longer offers them
 *   - settlement resolves per user
 *
 * Run: npm run test:no-pooled-settlement
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const hub = path.resolve(repo, '../sivan-admin-hub');

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    fail += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}

function read(rel: string, base = repo) {
  const file = path.join(base, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

async function main() {
  console.log('\nPooled settlement must stay removed\n');

  console.log('1. The settings API rejects the pooled fields');
  const { virtualAccountProviderSettingsSchema, redactVirtualAccountProviderSettings } =
    await import('../src/virtual-accounts/service/virtual-account-provider-settings.service.js');

  const withPooled = virtualAccountProviderSettingsSchema.safeParse({
    provider: 'bridge',
    enabled: true,
    defaultSettlementAsset: 'usdc',
    defaultSettlementNetwork: 'solana',
    bridgeWalletId: 'bw_pooled_treasury',
    updatedBy: 'ops.alice@sivantech.online',
  });
  check('a bridgeWalletId is rejected, not silently ignored', !withPooled.success,
    'ignoring it would let ops believe pooled settlement was configured');

  const withAddress = virtualAccountProviderSettingsSchema.safeParse({
    provider: 'bridge',
    enabled: true,
    defaultSettlementAsset: 'usdc',
    defaultSettlementNetwork: 'solana',
    destinationAddress: 'FcdXydhwo72qac4PsrTr8raKZJ3r6MCv2rKsbAv3ntKJ',
    updatedBy: 'ops.alice@sivantech.online',
  });
  check('a destinationAddress is rejected', !withAddress.success);

  const clean = virtualAccountProviderSettingsSchema.safeParse({
    provider: 'bridge',
    enabled: true,
    defaultSettlementAsset: 'usdc',
    defaultSettlementNetwork: 'solana',
    updatedBy: 'ops.alice@sivantech.online',
  });
  check('a settings update without them still succeeds', clean.success,
    clean.success ? '' : JSON.stringify(clean.error.issues[0]));

  console.log('\n2. A historical saved value cannot resurrect it');
  const redacted: any = redactVirtualAccountProviderSettings({
    provider: 'bridge',
    enabled: true,
    defaultSettlementAsset: 'usdc',
    defaultSettlementNetwork: 'solana',
    bridgeWalletId: 'bw_old_pooled',
    destinationAddress: 'FcdXyd_old_pooled',
    highRiskAutoDisable: true,
    updatedBy: 'env',
    updatedAt: new Date().toISOString(),
  } as any);
  check('bridgeWalletId is stripped from the API response', redacted.bridgeWalletId === undefined);
  check('destinationAddress is stripped', redacted.destinationAddress === undefined);
  check('the response states the settlement model plainly',
    redacted.settlementModel === 'per_user_wallet', String(redacted.settlementModel));
  check('and explains it in words ops will read',
    /own Bridge wallet/i.test(redacted.settlementNote || ''));

  const service = read('src/virtual-accounts/service/virtual-account-provider-settings.service.ts');
  check('a stale audit-log setting is deleted on read',
    /delete \(merged as any\)\.bridgeWalletId/.test(service));

  console.log('\n3. The env schema no longer defines them');
  const env = read('src/config/env.ts');
  check('BRIDGE_VIRTUAL_ACCOUNT_BRIDGE_WALLET_ID is not a schema key',
    !/^\s*BRIDGE_VIRTUAL_ACCOUNT_BRIDGE_WALLET_ID:\s*z\./m.test(env),
    'a stale Render value would otherwise still parse');
  check('BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_ADDRESS is not a schema key',
    !/^\s*BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_ADDRESS:\s*z\./m.test(env));
  check('the removal is explained for whoever looks next',
    /2\.1\(m\)/.test(env) && /pooled/i.test(env));

  console.log('\n4. The Admin Hub no longer offers them');
  const controls = read('app/dashboard/modules/sivan-payment/src/components/ControlsTab.tsx', hub);
  if (!controls) {
    check('admin hub ControlsTab found', false, 'file missing, cannot verify');
  } else {
    check('no Bridge wallet ID input is rendered', !/placeholder="Bridge wallet ID"/.test(controls));
    check('no destination address input is rendered',
      !/placeholder="0x\.\.\. or destination address"/.test(controls));
    check('pooled values are not sent on save',
      !/payload\.bridgeWalletId\s*=/.test(controls) && !/payload\.destinationAddress\s*=/.test(controls));
    check('ops are told where money actually goes',
      /per user wallet/i.test(controls));
  }

  console.log('\n5. Settlement still resolves per user');
  const provider = read('src/virtual-accounts/provider/bridge-virtual-account.provider.ts');
  check('the VA provider calls ensureUserWallet', /ensureUserWallet\(input\.userId\)/.test(provider));
  check('destination uses that wallet id', /bridge_wallet_id:\s*wallet\.providerWalletId/.test(provider));
  check('there is no pooled fallback',
    /no pooled fallback/i.test(provider),
    'a misconfiguration must fail loudly, not route to a shared treasury');

  const supplier = read('src/suppliers/supplier.service.ts');
  check('supplier payouts resolve the user\'s own wallet',
    /resolveSettlementWalletId\(payment\.userId\)/.test(supplier));

  console.log(`\n=====  PASS: ${pass}   FAIL: ${fail}  =====\n`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
