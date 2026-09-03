import { PrivyWalletProvider } from '../src/wallets/provider/privy-wallet.provider.js';
import { PublicKey } from '@solana/web3.js';

async function main() {
  console.log('--- 1. Initializing PrivyWalletProvider ---');
  const provider = new PrivyWalletProvider();
  console.log('Provider name:', provider.name);
  console.log('Custody model:', provider.custodyModel);
  console.log('Supported chains:', provider.supportedChains);

  const testUserId = `test_usr_${Date.now()}`;

  console.log(`\n--- 2. Creating Solana Wallet for user: ${testUserId} ---`);
  const solanaWallet = await provider.createWallet({
    userId: testUserId,
    chain: 'solana',
    idempotencyKey: `idem_sol_${testUserId}`,
  });
  console.log('Solana Wallet Result:');
  console.log('  Provider Wallet ID:', solanaWallet.providerWalletId);
  console.log('  On-Chain Address:  ', solanaWallet.address);
  console.log('  Status:            ', solanaWallet.status);

  // Validate on-curve Solana Ed25519
  const pubkey = new PublicKey(solanaWallet.address);
  const onCurve = PublicKey.isOnCurve(pubkey.toBuffer());
  console.log('  Is On-Curve (Valid Solana):', onCurve);
  if (!onCurve) throw new Error('Solana address failed on-curve validation!');

  console.log(`\n--- 3. Creating EVM (Base/Celo/BSC) Wallet for user: ${testUserId} ---`);
  const evmWallet = await provider.createWallet({
    userId: testUserId,
    chain: 'base',
    idempotencyKey: `idem_evm_${testUserId}`,
  });
  console.log('EVM Wallet Result:');
  console.log('  Provider Wallet ID:', evmWallet.providerWalletId);
  console.log('  On-Chain Address:  ', evmWallet.address);
  console.log('  Status:            ', evmWallet.status);

  if (!/^0x[a-fA-F0-9]{40}$/.test(evmWallet.address)) {
    throw new Error('EVM address failed regex validation!');
  }

  console.log('\n=======================================================');
  console.log('✅ SUCCESS: Privy Direct Server Wallets provisioned and validated!');
  console.log('=======================================================');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
