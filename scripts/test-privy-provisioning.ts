/**
 * Wallet provisioning end to end, through the real service.
 *
 * The question this answers: can a user with BASIC INFORMATION and no Bridge
 * customer actually get a wallet? Until now that was asserted by a pure
 * eligibility function; here it runs through ensureUserWallet, the provider
 * registry and the database.
 *
 * What used to happen: ensureUserWallet required a Bridge customer with
 * kycStatus 'kyc_approved' AND a providerCustomerId. Bridge bills $2 per KYC,
 * so provisioning a wallet forced a Bridge onboarding even for a user who
 * would only ever hold USDC and off-ramp to naira - a flow Bridge plays no
 * part in.
 *
 * Run: npm run test:privy-provisioning
 */

import { db } from '../src/database/json-database.js';
import { ensureUserWallet, listUserWallets } from '../src/wallets/user-wallet.service.js';
import { getWalletProvider } from '../src/wallets/provider/provider-registry.js';

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

async function threw(fn: () => Promise<unknown>): Promise<string | undefined> {
  try { await fn(); return undefined; } catch (e: any) { return String(e?.message ?? e); }
}

const now = new Date().toISOString();

/**
 * u_basic  - name + verified payout account. NO Bridge customer. The case
 *            that matters: this user must get a wallet.
 * u_none   - signed up, nothing else. Must NOT get a wallet.
 * u_bridge - has a Bridge customer too.
 */
async function seed() {
  await db.mutate((d: any) => {
    d.users = [
      { id: 'u_basic', email: 'basic@t.ng', createdAt: now, updatedAt: now },
      { id: 'u_none', email: 'none@t.ng', createdAt: now, updatedAt: now },
      { id: 'u_bridge', email: 'bridge@t.ng', createdAt: now, updatedAt: now },
    ];
    d.customers = [
      {
        id: 'cus_b', userId: 'u_bridge', provider: 'bridge', providerCustomerId: 'bridge_cus_1',
        kycStatus: 'kyc_approved', tosStatus: 'approved', createdAt: now, updatedAt: now,
      },
    ];
    d.externalAccounts = [
      { id: 'e1', userId: 'u_basic', status: 'verified', currency: 'ngn', createdAt: now, updatedAt: now },
      { id: 'e2', userId: 'u_bridge', status: 'verified', currency: 'ngn', createdAt: now, updatedAt: now },
    ];
    d.userWallets = [];
    d.ngnControls = [{
      id: 'global', onrampEnabled: true, offrampEnabled: true, mockProviderEnabled: true,
      bankSettlementEnabled: false, virtualAccountEnabled: false, activeProvider: 'mock',
      identityVerificationEnabled: false, maxTransactionNgn: '100000000',
      dailyLimitNgn: '100000000', highValueReviewThresholdNgn: '100000000',
      updatedBy: 'test', updatedAt: now,
    }];
  });
}

async function main() {
  await seed();

  console.log('\nBASIC INFORMATION IS ENOUGH - no Bridge customer needed');
  {
    // The whole point. This user has never been registered with Bridge, so no
    // $2 has been spent, and they still get a wallet.
    const wallet = await ensureUserWallet('u_basic', 'solana');
    check('a user with only a verified payout account gets a wallet',
      Boolean(wallet?.address), JSON.stringify(wallet));
    check('and it is recorded with NO Bridge customer id',
      wallet.customerId === undefined, String(wallet.customerId));
    check('the address is non-empty', Boolean(wallet.address) && wallet.address.length > 20,
      wallet.address);
  }

  console.log('\nsignup alone is still not enough');
  {
    const error = await threw(() => ensureUserWallet('u_none', 'solana'));
    check('a user with no payout account is refused', error !== undefined);
    check('and is told what to add, not to complete Bridge KYC',
      /payout bank account/i.test(error ?? ''), error);
    check('the old Bridge wording is gone',
      !/Complete verification before creating a wallet/i.test(error ?? ''), error);
  }

  console.log('\nprovisioning is idempotent');
  {
    // A second call must return the SAME wallet. Two addresses for one user on
    // one chain means one of them receives deposits nobody is watching.
    const first = await ensureUserWallet('u_basic', 'solana');
    const second = await ensureUserWallet('u_basic', 'solana');
    check('a repeat call returns the same wallet', first.id === second.id,
      `${first.id} vs ${second.id}`);
    check('and the same address', first.address === second.address);

    const all = await listUserWallets('u_basic');
    const solana = all.filter((w) => w.chain === 'solana');
    check('exactly one solana wallet is stored', solana.length === 1, String(solana.length));
  }

  console.log('\nTWO KEYS, THREE CHAINS');
  {
    // Solana is ed25519, EVM is secp256k1 - genuinely different keys. Ethereum
    // and Base share both curve and address, so one EVM wallet serves both.
    const evm = await ensureUserWallet('u_basic', 'ethereum');
    const solana = await ensureUserWallet('u_basic', 'solana');
    check('the EVM address differs from the Solana address',
      evm.address !== solana.address);
    check('the EVM address is 0x-prefixed', evm.address.startsWith('0x'), evm.address);
    check('the Solana address is not', !solana.address.startsWith('0x'), solana.address);
  }

  console.log('\na Bridge-verified user still works');
  {
    const wallet = await ensureUserWallet('u_bridge', 'solana');
    check('a user with a Bridge customer also gets a wallet', Boolean(wallet?.address));
    check('and the Bridge customer id IS recorded for them',
      wallet.customerId === 'cus_b', String(wallet.customerId));
  }

  console.log('\nthe provider in use reports its custody model');
  {
    const provider = getWalletProvider();
    check('a custody model is declared',
      ['custodial', 'non_custodial'].includes(provider.custodyModel), provider.custodyModel);
    check('the provider names itself', Boolean(provider.name), provider.name);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
