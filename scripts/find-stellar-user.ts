import { db } from '../src/database/json-database.js';
import { generateStellarKeypair } from '../src/wallets/stellar/stellar-keypair.js';
import { ensureStellarAccountAndTrustline, hasUsdcTrustline } from '../src/wallets/stellar/trustline.js';

async function main() {
  const target = 'GBB7ATIEYUK45KBSGQHYXIJQPFRVAW74QOW6BUW7NWCVLAXPT7FGOSDU';
  console.log('Target address:', target);
  
  const users = await db.listUsers();
  console.log('Total users:', users.length);
  
  let foundSeed = null;
  for (const u of users) {
    const seed1 = 'sivan_stellar_' + u.id;
    const kp1 = generateStellarKeypair(seed1);
    if (kp1.publicKey === target) {
      console.log('Match found on seed1:', seed1, 'User:', u.id, u.email);
      foundSeed = seed1;
      break;
    }

    const seed2 = `mock_seed_${u.id}_stellar`;
    const kp2 = generateStellarKeypair(seed2);
    if (kp2.publicKey === target) {
      console.log('Match found on seed2:', seed2, 'User:', u.id, u.email);
      foundSeed = seed2;
      break;
    }
  }

  if (foundSeed) {
    console.log('Establishing trustline on Stellar testnet...');
    const res = await ensureStellarAccountAndTrustline(foundSeed, target, { production: false });
    console.log('Result:', res);
    console.log('Has USDC trustline now:', await hasUsdcTrustline(target, { production: false }));
  } else {
    console.log('Address not matched by standard user seeds. Testing with direct target address or common seeds...');
  }
}

main().catch(console.error);
