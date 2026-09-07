import { db } from '../src/database/json-database.js';
import { ensureUserWallet, getUserWalletWithBalances } from '../src/wallets/user-wallet.service.js';
import { ensureStellarAccountAndTrustline, hasUsdcTrustline, hasUsdtTrustline } from '../src/wallets/stellar/trustline.js';
import { readStellarTokenBalances, isStellarHorizonHealthy } from '../src/wallets/stellar/stellar-rpc.js';

async function main() {
  console.log('================================================================');
  console.log('🚀 SIVAN STELLAR E2E WALLET & TRUSTLINE VERIFICATION SUITE');
  console.log('================================================================\n');

  // 1. Verify Horizon RPC Health
  const healthy = await isStellarHorizonHealthy({ production: false });
  console.log('1. Horizon Testnet RPC Health Check:', healthy ? '✅ Operational' : '⚠️ Unreachable');
  if (!healthy) {
    console.warn('Warning: Stellar Horizon Testnet returned non-OK status. Continuing with failover...');
  }

  // 2. Fetch Users from Database
  const users = await db.listUsers();
  console.log(`\n2. Inspecting ${users.length} registered user account(s)...\n`);

  if (!users.length) {
    console.log('No users found in database.');
    return;
  }

  let allTrustlinesActive = true;
  const summary: Array<{
    userId: string;
    email: string;
    stellarAddress: string;
    usdcTrustline: boolean;
    usdtTrustline: boolean;
    xlmBalance: number;
    usdcBalance: number;
    usdtBalance: number;
  }> = [];

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    console.log(`--- [${i + 1}/${users.length}] User: ${user.id} (${user.email || 'no-email'}) ---`);

    // A. Ensure Stellar Wallet exists
    const wallet = await ensureUserWallet(user.id, 'stellar');
    console.log('  Deterministic Stellar Address:', wallet.address);

    // B. Ensure Account funding and Trustlines on-chain
    const activation = await ensureStellarAccountAndTrustline(
      `sivan_stellar_${user.id}`,
      wallet.address,
      { production: false }
    );
    console.log('  Trustline Activation Result:', activation.success ? '✅ Success' : `❌ Error: ${activation.error}`);

    // C. Verify On-Chain Trustline Status
    const usdcActive = await hasUsdcTrustline(wallet.address, { production: false });
    const usdtActive = await hasUsdtTrustline(wallet.address, { production: false });
    console.log('  USDC Trustline Status:', usdcActive ? '✅ Active' : '❌ Inactive');
    console.log('  USDT Trustline Status:', usdtActive ? '✅ Active' : '❌ Inactive');

    if (!usdcActive || !usdtActive) {
      allTrustlinesActive = false;
    }

    // D. Query Live Balances
    const balances = await readStellarTokenBalances(wallet.address, { production: false });
    console.log(`  Live On-Chain Balances: ${balances.xlm} XLM | ${balances.usdc} USDC | ${balances.usdt} USDT`);

    // E. Verify Sivan Unified / Wallet Service integration
    const walletWithBalances = await getUserWalletWithBalances(user.id, 'stellar');
    const serviceBalances = walletWithBalances?.balances || [];
    console.log('  Wallet Service Balances:', JSON.stringify(serviceBalances));

    summary.push({
      userId: user.id,
      email: user.email || '—',
      stellarAddress: wallet.address,
      usdcTrustline: usdcActive,
      usdtTrustline: usdtActive,
      xlmBalance: balances.xlm,
      usdcBalance: balances.usdc,
      usdtBalance: balances.usdt,
    });

    console.log('');
  }

  // 3. Final Summary Report
  console.log('================================================================');
  console.log('📊 STELLAR WALLETS VERIFICATION SUMMARY');
  console.log('================================================================');
  console.table(summary);

  if (allTrustlinesActive) {
    console.log('\n🎉 ALL USER STELLAR WALLETS HAVE ACTIVE USDC & USDT TRUSTLINES!');
  } else {
    console.error('\n❌ WARNING: Some wallets have incomplete trustlines.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error in Stellar E2E suite:', err);
  process.exit(1);
});
