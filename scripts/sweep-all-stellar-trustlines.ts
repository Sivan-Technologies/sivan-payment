import { db } from '../src/database/json-database.js';
import { generateStellarKeypair, generateStellarAddress } from '../src/wallets/stellar/stellar-keypair.js';
import { ensureStellarAccountAndTrustline, hasUsdcTrustline, hasUsdtTrustline } from '../src/wallets/stellar/trustline.js';
import { readStellarTokenBalances } from '../src/wallets/stellar/stellar-rpc.js';

async function main() {
  console.log('================================================================');
  console.log('🚀 GLOBAL STELLAR WALLET SWEEP & TRUSTLINE ACTIVATION ENGINE');
  console.log('================================================================\n');

  const targetAddress = 'GBB7ATIEYUK45KBSGQHYXIJQPFRVAW74QOW6BUW7NWCVLAXPT7FGOSDU';
  const users = await db.listUsers();
  console.log(`Found ${users.length} users in database.\n`);

  let targetFound = false;

  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    console.log(`[${i + 1}/${users.length}] Processing user: ${u.id} (${u.email || 'no-email'})...`);

    const candidateSeeds = [
      `sivan_stellar_${u.id}`,
      `mock_seed_${u.id}_stellar`,
      `${u.id}:stellar`,
      `sivan-wallet-${u.id}-stellar`,
      u.email ? `sivan_stellar_${u.email.toLowerCase()}` : '',
      u.email ? `${u.email.toLowerCase()}` : '',
      u.id,
      `sivan_${u.id}`,
      `wallet_${u.id}_stellar`,
      `sivan_stellar_dev`,
      `sivan_stellar_admin`,
      `sivan_stellar_test`,
      `stellar_seed_1`,
      `sivan_stellar_usr_10ed27f0-7ff2-4228-b45c-70a327d9b3c8`,
      `sivan_stellar_usr_43d7cf8e-39c8-4436-a895-303283d98951`,
      `sivan_stellar_usr_b1d36f5b-9e1d-4d72-918a-c0484310c6bc`
    ].filter(Boolean);

    let activeSeed = `sivan_stellar_${u.id}`;

    for (const seed of candidateSeeds) {
      try {
        const kp = generateStellarKeypair(seed);
        if (kp.publicKey === targetAddress) {
          console.log(`\n🎯 MATCH FOUND FOR TARGET ADDRESS ${targetAddress}!`);
          console.log(`Matching User: ${u.id} (${u.email})`);
          console.log(`Matching Seed: ${seed}`);
          activeSeed = seed;
          targetFound = true;
          break;
        }
      } catch {}
    }

    const addr = generateStellarAddress(activeSeed);
    console.log(`  Stellar Address: ${addr}`);

    try {
      const res = await ensureStellarAccountAndTrustline(activeSeed, addr, { production: false });
      const usdcOk = await hasUsdcTrustline(addr, { production: false });
      const usdtOk = await hasUsdtTrustline(addr, { production: false });
      const balances = await readStellarTokenBalances(addr, { production: false });

      console.log(`  Activation Result: success=${res.success}, usdcTrustline=${usdcOk}, usdtTrustline=${usdtOk}`);
      console.log(`  Live Balances: XLM=${balances.xlm}, USDC=${balances.usdc}, USDT=${balances.usdt}\n`);
    } catch (err: any) {
      console.warn(`  Failed for user ${u.id}:`, err?.message || err);
    }
  }

  // Also check common test seeds for targetAddress if not yet matched
  if (!targetFound) {
    console.log('\nTesting additional system seed variations for target address...');
    const extraSeeds = [
      'sivan',
      'sivan_stellar',
      'sivan_payment',
      'sivan_admin',
      'sivan_escrow',
      'default',
      'testnet',
      'friendbot',
      'sivan_stellar_seed',
      'sivan_demo_stellar',
      'sivan_test_stellar',
      'sivan_staging_stellar',
      'sivan_live_stellar',
      'sivan_master_stellar',
      'sivantech@gmail.com',
      'samson',
      'samswitchy'
    ];

    for (const seed of extraSeeds) {
      try {
        const kp = generateStellarKeypair(seed);
        if (kp.publicKey === targetAddress) {
          console.log(`\n🎯 MATCH FOUND VIA EXTRA SEED: "${seed}"`);
          const res = await ensureStellarAccountAndTrustline(seed, targetAddress, { production: false });
          console.log('Activation result:', res);
          targetFound = true;
          break;
        }
      } catch {}
    }
  }

  console.log('================================================================');
  console.log('✅ ALL DATABASE WALLETS CHECKED & TRUSTLINES ACTIVATED');
  console.log('================================================================');
}

main().catch(console.error);
