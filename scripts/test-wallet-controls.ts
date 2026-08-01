/**
 * Wallet provider, chosen by an admin rather than by a redeploy.
 *
 * WALLET_PROVIDER lived only in the environment, so changing who custodies
 * user funds meant editing Render config and restarting. Same argument that
 * already moved the NGN provider and the verification ceilings into the
 * database.
 *
 * The property that makes this safe: every wallet row records the provider
 * that ISSUED it. Switching the default decides who issues the NEXT wallet and
 * never orphans an existing one - a Bridge wallet keeps resolving to Bridge
 * after the default becomes Privy.
 *
 * Run: npm run test:wallet-controls
 */

import {
  getWalletControls,
  updateWalletControls,
  resolveActiveWalletProvider,
  getWalletControlsView,
  defaultWalletControls,
} from '../src/wallets/wallet-controls.service.js';
import { env } from '../src/config/env.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

async function threw(fn: () => Promise<unknown>) {
  try { await fn(); return undefined; } catch (e: any) { return String(e?.message ?? e); }
}

async function main() {
  console.log('\nWITH NO OVERRIDE, THE ENVIRONMENT STILL WINS');
  {
    // The migration must change nothing on its own. A deployment that never
    // touches the admin toggle has to behave exactly as it did before.
    const controls = await getWalletControls();
    check('no override is set by default', controls.activeProvider === undefined,
      String(controls.activeProvider));

    process.env.WALLET_PROVIDER = 'bridge';
    check('the environment value is used', (await resolveActiveWalletProvider()) === 'bridge',
      await resolveActiveWalletProvider());

    process.env.WALLET_PROVIDER = 'privy';
    check('and it tracks changes to the environment',
      (await resolveActiveWalletProvider()) === 'privy');
  }

  console.log('\nAN ADMIN OVERRIDE BEATS THE ENVIRONMENT');
  {
    process.env.WALLET_PROVIDER = 'bridge';
    await updateWalletControls({ activeProvider: 'privy', reason: 'moving to non-custodial', updatedBy: 'test' });

    check('the override wins', (await resolveActiveWalletProvider()) === 'privy',
      await resolveActiveWalletProvider());
    check('even though the environment still says bridge', process.env.WALLET_PROVIDER === 'bridge');

    const stored = await getWalletControls();
    check('the reason is recorded for audit', stored.reason === 'moving to non-custodial', stored.reason);
    check('the actor is recorded', stored.updatedBy === 'test');
  }

  console.log('\nNULL CLEARS THE OVERRIDE, IT DOES NOT SET A PROVIDER');
  {
    // null and "unset" are different: null means fall back to the
    // environment, and confusing the two would pin a provider permanently.
    await updateWalletControls({ activeProvider: null, updatedBy: 'test' });
    check('the override is cleared', (await getWalletControls()).activeProvider === undefined);
    check('the environment takes over again', (await resolveActiveWalletProvider()) === 'bridge',
      await resolveActiveWalletProvider());

    // Omitting the field must LEAVE the current value alone.
    await updateWalletControls({ activeProvider: 'privy', updatedBy: 'test' });
    await updateWalletControls({ reason: 'unrelated edit', updatedBy: 'test' });
    check('omitting activeProvider leaves it unchanged',
      (await getWalletControls()).activeProvider === 'privy',
      String((await getWalletControls()).activeProvider));
  }

  console.log('\nMOCK CANNOT BE SWITCHED ON IN PRODUCTION');
  {
    // A mock wallet hands out an address nobody controls. The registry refuses
    // it too, but failing at configuration time beats failing when a user asks
    // for a wallet.
    const savedEnv = (env as any).APP_ENV;
    (env as any).APP_ENV = 'production';

    const message = await threw(() => updateWalletControls({ activeProvider: 'mock', updatedBy: 'test' }));
    check('production refuses mock', Boolean(message), 'mock was accepted in production');
    check('the refusal says why', /production/i.test(message ?? ''), message);

    const view = await getWalletControlsView();
    check('mock is not even offered in production',
      !view.availableProviders.includes('mock' as any), view.availableProviders.join(','));

    (env as any).APP_ENV = savedEnv;
    check('mock is available outside production',
      (await getWalletControlsView()).availableProviders.includes('mock' as any));
  }

  console.log('\nTHE ADMIN VIEW SHOWS WHAT IT IS SWITCHING FROM');
  {
    process.env.WALLET_PROVIDER = 'bridge';
    await updateWalletControls({ activeProvider: 'privy', reason: 'non-custodial', updatedBy: 'test' });

    const view = await getWalletControlsView();
    check('it reports the effective provider', view.activeProvider === 'privy', view.activeProvider);
    check('and the environment default alongside it',
      view.environmentProvider === 'bridge', view.environmentProvider);
    check('and flags that it is overridden', view.isOverridden === true);

    // The obvious wrong assumption is that flipping this migrates everybody.
    check('it states that existing wallets are unaffected',
      /NEWLY created|existing wallets/i.test(view.note), view.note);
    check('and that a signer cannot be added later',
      /delegated signer|cannot gain/i.test(view.note), view.note);
  }

  console.log('\nONLY KNOWN PROVIDERS ARE ACCEPTED');
  {
    const message = await threw(() => updateWalletControls({ activeProvider: 'ethereum' as any, updatedBy: 'test' }));
    check('an unknown provider is rejected', Boolean(message), 'a nonsense provider was accepted');
  }

  console.log('\nTHE DEFAULT RECORD IS INERT');
  {
    const fallback = defaultWalletControls();
    check('it sets no provider', fallback.activeProvider === undefined);
    check('so adding this table changes nothing on its own',
      fallback.activeProvider === undefined && fallback.id === 'global');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => { console.error('\nthrew:', error); process.exit(1); });
