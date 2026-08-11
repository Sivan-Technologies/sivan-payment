/**
 * The Bridge -> Privy sweep must be OFF by default and must obey the admin
 * switch, and turning it off must not strand a user's money.
 *
 * These assertions drive the real service, not a copy of its logic. The whole
 * point of the switch is that it stops an on-chain transfer, so a test that
 * only inspected the settings object would prove nothing about the money.
 */
import assert from 'node:assert/strict';
import { adminPlatformSettingsSchema } from '../src/admin/admin-settings.service.js';

let failures = 0;
const check = (name: string, fn: () => void | Promise<void>) => {
  try {
    const out = fn();
    if (out instanceof Promise) return out.then(
      () => console.log('PASS ', name),
      (err) => { failures++; console.log('FAIL ', name, '\n      ', (err as Error).message); }
    );
    console.log('PASS ', name);
  } catch (err) {
    failures++;
    console.log('FAIL ', name, '\n      ', (err as Error).message);
  }
  return undefined;
};

const run = async () => {
  // ---------------------------------------------------------------- defaults
  await check('sweep defaults to OFF in the schema', () => {
    const parsed = adminPlatformSettingsSchema.parse({});
    assert.equal(parsed.bridgeToPrivySweepEnabled, false,
      'a capability that moves funds must fail closed');
  });

  await check('an explicit true is still honoured', () => {
    const parsed = adminPlatformSettingsSchema.parse({ bridgeToPrivySweepEnabled: true });
    assert.equal(parsed.bridgeToPrivySweepEnabled, true);
  });

  // ------------------------------------------------------------ the real gate
  // Drive the REAL service against the REAL settings store. ES module exports
  // are read-only so they cannot be monkey-patched, and that is for the best:
  // writing the setting the way an admin does exercises the path that actually
  // ships, including the audit-log read getAdminPlatformSettings() performs.
  await check('a settled deposit is NOT swept while disabled', async () => {
    const { updateAdminPlatformSettings, getAdminPlatformSettings, adminPlatformSettingsSchema: schema } =
      await import('../src/admin/admin-settings.service.js');

    await updateAdminPlatformSettings(
      schema.parse({ bridgeToPrivySweepEnabled: false, updatedBy: 'test_sweep_control' })
    );
    const persisted = await getAdminPlatformSettings();
    assert.equal(persisted.bridgeToPrivySweepEnabled, false, 'setup: switch should be off');

    const { sweepVirtualAccountDepositToPrivy } = await import(
      '../src/virtual-accounts/service/bridge-to-privy-sweep.service.js'
    );
    const outcome = await sweepVirtualAccountDepositToPrivy({
      id: 'vatx_test_1',
      userId: 'user_test_1',
      status: 'completed',
      destinationAmount: '250',
      sourceAmount: '250',
    } as any);

    assert.equal(outcome.swept, false, 'the sweep must not move funds while disabled');
    /*
     * The reason string is 'auto_sweep_disabled' after a parallel change
     * (854d9f0) merged a second switch, walletControls.autoSweepBridgeWallet,
     * into the same guard. Assert on the BEHAVIOUR plus either owner's reason:
     * what must hold is that a settled deposit does not move, not which of the
     * two flags said no.
     */
    assert.ok(
      ['auto_sweep_disabled', 'sweep_disabled_by_admin'].includes(String(outcome.reason)),
      `expected an admin gate to stop it, got: ${outcome.reason}`
    );
  });

  // The reason string must be load-bearing, not cosmetic: with the switch ON
  // the same transaction has to get PAST the gate and stop for a later reason.
  await check('with the switch ON the gate is no longer the blocker', async () => {
    const { updateAdminPlatformSettings, adminPlatformSettingsSchema: schema } =
      await import('../src/admin/admin-settings.service.js');

    await updateAdminPlatformSettings(
      schema.parse({ bridgeToPrivySweepEnabled: true, updatedBy: 'test_sweep_control' })
    );

    const { sweepVirtualAccountDepositToPrivy } = await import(
      '../src/virtual-accounts/service/bridge-to-privy-sweep.service.js'
    );
    const outcome = await sweepVirtualAccountDepositToPrivy({
      id: 'vatx_test_2',
      userId: 'user_test_2',
      status: 'completed',
      destinationAmount: '250',
      sourceAmount: '250',
    } as any);

    assert.ok(
      !['auto_sweep_disabled', 'sweep_disabled_by_admin'].includes(String(outcome.reason)),
      `with the switch on, no admin gate should stop it -- got: ${outcome.reason}`
    );

    // Leave the platform as we found it: OFF is the shipped default.
    await updateAdminPlatformSettings(
      schema.parse({ bridgeToPrivySweepEnabled: false, updatedBy: 'test_sweep_control' })
    );
  });

  // ----------------------------------------------- money is not stranded
  await check('the send path resolves each wallet\'s own custodian', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/balances/balance.service.ts', 'utf8'));
    // Comments are stripped so a sentence ABOUT the fix cannot satisfy the
    // assertion -- a mistake this repo has shipped four times.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.match(code, /getWalletProvider\(wallet\.provider \?\?/,
      'the transfer must sign through the wallet\'s recorded provider');
    assert.match(code, /pickFundedWallet/,
      'the send must choose the funded wallet when a user holds several');
  });

  await check('the balance read resolves each wallet\'s own custodian', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/balances/unified-balance.service.ts', 'utf8'));
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.match(code, /providerFor\(wallet\)\.getBalances/,
      'balances must be read per wallet provider, not via one active provider');
    assert.doesNotMatch(code, /const provider = getWalletProvider\(await resolveActiveWalletProvider\(\)\)/,
      'the single-provider read is what hid Bridge balances');
  });

  console.log('-'.repeat(64));
  console.log(failures ? `${failures} FAIL` : 'sweep control verified');
  process.exit(failures ? 1 : 0);
};

void run();
