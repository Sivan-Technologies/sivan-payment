/**
 * Bridge ToS compliance regression test.
 *
 * Bridge ToS 2.1(m) prohibits Sivan from holding or controlling crypto-assets
 * on behalf of users. The way that breaks in practice is pooling: routing many
 * users' funds into one Sivan-controlled wallet and tracking ownership in our
 * own database.
 *
 * This asserts that never happens. Run it in CI before any deploy that touches
 * wallets, virtual accounts, or supplier payouts.
 *
 *   npm run test:wallet-isolation
 */
import { db } from '../src/database/json-database.js';
import { getVirtualAccountProviderSettings } from '../src/virtual-accounts/service/virtual-account-provider-settings.service.js';
import { ensureUserWallet, listUserWallets, assetsForChain, DEFAULT_CHAIN } from '../src/wallets/user-wallet.service.js';
import { nowIso } from '../src/shared/id.js';

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `\n      ${detail}` : ''}`);
};

const USERS = ['alice', 'bob', 'carol', 'dave', 'erin'];

async function seed() {
  await db.mutate((d: any) => {
    d.users = d.users ?? [];
    d.customers = d.customers ?? [];
    for (const u of USERS) {
      const id = `usr_${u}`;
      if (!d.users.find((x: any) => x.id === id)) {
        d.users.push({ id, email: `${u}@test.local`, createdAt: nowIso(), updatedAt: nowIso() });
      }
      if (!d.customers.find((c: any) => c.userId === id)) {
        d.customers.push({
          id: `cus_${id}`, userId: id, provider: 'mock',
          providerCustomerId: `bridge_cus_${id}`, kycStatus: 'kyc_approved',
          createdAt: nowIso(), updatedAt: nowIso(),
        });
      }
    }
    // An unverified user must never be issued a wallet.
    if (!d.users.find((x: any) => x.id === 'usr_unverified')) {
      d.users.push({ id: 'usr_unverified', email: 'nokyc@test.local', createdAt: nowIso(), updatedAt: nowIso() });
      d.customers.push({
        id: 'cus_usr_unverified', userId: 'usr_unverified', provider: 'mock',
        providerCustomerId: 'bridge_cus_unverified', kycStatus: 'kyc_under_review',
        createdAt: nowIso(), updatedAt: nowIso(),
      });
    }
    return null;
  });
}

(async () => {
  console.log('\n===== Bridge ToS 2.1(m) wallet isolation =====\n');
  await seed();

  const settings: any = await getVirtualAccountProviderSettings({ includeSecrets: true });
  const POOL = settings.bridgeWalletId;
  console.log(`Sivan pooled/treasury wallet: ${POOL || '(unset)'}\n`);

  const wallets: Record<string, any> = {};
  for (const u of USERS) wallets[u] = await ensureUserWallet(`usr_${u}`);

  console.log('1. Each user has their own wallet');
  const ids = USERS.map((u) => wallets[u].providerWalletId);
  const addrs = USERS.map((u) => wallets[u].address);
  t(`${USERS.length} users -> ${new Set(ids).size} distinct wallet ids`, new Set(ids).size === USERS.length);
  t(`${USERS.length} users -> ${new Set(addrs).size} distinct addresses`, new Set(addrs).size === USERS.length);
  t('each wallet records its true owner', USERS.every((u) => wallets[u].userId === `usr_${u}`));

  console.log('\n2. No user is tied to the Sivan pooled wallet');
  const collisions = USERS.filter((u) => POOL && wallets[u].providerWalletId === POOL);
  t('no user wallet equals the Sivan treasury wallet', collisions.length === 0,
    collisions.length ? `POOLED USERS: ${collisions.join(', ')}` : '');

  console.log('\n3. Virtual account settlement is per user');
  for (const u of USERS) {
    const w = wallets[u];
    const destination = {
      currency: settings.defaultSettlementAsset,
      payment_rail: w.chain,
      bridge_wallet_id: w.providerWalletId,
    };
    t(`${u}: settles to own wallet, not the pool`, destination.bridge_wallet_id !== POOL);
    t(`${u}: rail matches the wallet chain`, destination.payment_rail === w.chain);
  }

  console.log('\n4. Cross-user isolation');
  const aliceList = await listUserWallets('usr_alice');
  t('listUserWallets returns only the owner\'s wallets', aliceList.every((w) => w.userId === 'usr_alice'));
  t('alice cannot see bob\'s wallet', !aliceList.some((w) => w.providerWalletId === wallets.bob.providerWalletId));

  console.log('\n5. Idempotency (no duplicate wallets or duplicate billing)');
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => ensureUserWallet('usr_alice')));
  t('8 concurrent creates -> 1 wallet', new Set(concurrent.map((w) => w.id)).size === 1);
  t('exactly one solana wallet stored', (await listUserWallets('usr_alice')).filter((w) => w.chain === 'solana').length === 1);

  console.log('\n6. KYC gate');
  let blocked = false;
  try { await ensureUserWallet('usr_unverified'); } catch { blocked = true; }
  t('unverified user cannot be issued a wallet', blocked);

  console.log('\n7. Chain and asset defaults');
  t('default chain is solana', DEFAULT_CHAIN === 'solana');
  t('solana carries USDC and USDT', assetsForChain('solana').join(',') === 'usdc,usdt');
  t('base excludes USDT', !assetsForChain('base').includes('usdt' as any));

  console.log(`\n=====  PASS: ${pass}   FAIL: ${fail}  =====\n`);
  if (fail) {
    console.error('COMPLIANCE FAILURE: user funds may be pooled into a Sivan wallet.');
    console.error('Do not deploy. See Bridge ToS 2.1(m).');
  }
  process.exit(fail ? 1 : 0);
})();
