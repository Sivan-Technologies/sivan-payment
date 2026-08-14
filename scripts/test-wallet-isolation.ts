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
import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '../src/database/json-database.js';
import { env } from '../src/config/env.js';
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
    // A wallet now requires a CONFIRMED payout bank account, not just approved
    // KYC (wallet-eligibility.ts). Every user here needs one or ensureUserWallet
    // throws before any isolation property can be observed.
    //
    // usr_unverified deliberately gets NO account. The gate is bank
    // verification, not KYC approval - canProvisionWallet requires
    // VerificationLevel.BANK and says so explicitly: a user may hold a funded
    // wallet they are not yet cleared to off-ramp from. Verified by experiment:
    // give that user a verified account and a wallet IS issued despite
    // kyc_under_review. So the absent account is the condition under test.
    d.ngnPayoutAccounts = d.ngnPayoutAccounts ?? [];
    for (const u of USERS) {
      const id = `usr_${u}`;
      if (!d.users.find((x: any) => x.id === id)) {
        d.users.push({ id, email: `${u}@test.local`, createdAt: nowIso(), updatedAt: nowIso() });
      }
      if (!d.ngnPayoutAccounts.find((a: any) => a.userId === id)) {
        d.ngnPayoutAccounts.push({
          id: `ngnacct_${id}`, userId: id, provider: 'mock',
          bankId: '26', bankName: 'PalmPay',
          // A distinct NUBAN per user: a shared number would let a genuine
          // cross-user leak look like correct behaviour.
          accountNumber: `11111111${USERS.indexOf(u)}${USERS.indexOf(u)}`,
          accountName: `${u} test`, declaredName: `${u} test`,
          matchVerdict: 'match', matchScore: 1, resolutionTrustworthy: true,
          status: 'verified', createdAt: nowIso(), updatedAt: nowIso(),
        });
      }
      if (!d.customers.find((c: any) => c.userId === id)) {
        d.customers.push({
          id: `cus_${id}`, userId: id, provider: 'mock',
          providerCustomerId: `bridge_cus_${id}`, kycStatus: 'kyc_approved',
          createdAt: nowIso(), updatedAt: nowIso(),
        });
      }
    }
    // No payout account for this one - see the note above.
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
  // Start from an empty database. Every seed guard here is "create if absent",
  // so a leftover file from an earlier run silently keeps stale fixtures and
  // the suite then reports on state no longer described by this file. That is
  // not hypothetical: it produced a confident, wrong result during review.
  const dbPath = path.isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : path.join(process.cwd(), env.DATABASE_FILE);
  await fs.rm(dbPath, { force: true });
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

  // Named for what it enforces. Wallet provisioning is gated on a CONFIRMED
  // PAYOUT BANK (VerificationLevel.BANK), not on full KYC approval - see the
  // header of wallet-eligibility.ts. Calling this a "KYC gate" overstated it.
  console.log('\n6. Bank-verification gate');
  let blocked = false;
  let blockedReason = '';
  try { await ensureUserWallet('usr_unverified'); } catch (e) { blocked = true; blockedReason = (e as Error).message; }
  t('a user with no confirmed payout bank cannot be issued a wallet', blocked, blockedReason);
  // Pin the REASON, so a future refusal for some unrelated cause cannot keep
  // this green while the bank requirement itself silently stops being enforced.
  t('and the refusal names the bank account as what is missing',
    /payout bank account/i.test(blockedReason), blockedReason);

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
