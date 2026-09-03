import { db } from '../src/db/db.js';
import { getUserByEmail } from '../src/users/user.service.js';
import { ensureAllMultiChainWalletsForUser } from '../src/wallets/user-wallet.service.js';

async function main() {
  const user = await getUserByEmail('sivantech@gmail.com');
  console.log('USER_ID:', user?.id);
  console.log('USER_EMAIL:', user?.email);
  if (user) {
    await ensureAllMultiChainWalletsForUser(user.id);
    const wallets = await db.walletsForUser(user.id);
    console.log('=== MULTI-CHAIN WALLETS FOR SIVANTECH@GMAIL.COM ===');
    for (const w of wallets) {
      console.log(`[${w.chain.toUpperCase()}]: ${w.address}`);
    }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
