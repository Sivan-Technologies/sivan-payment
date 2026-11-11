import assert from 'node:assert/strict';
import { generateNearKeypair, generateNearAddress, signNearPayload } from '../src/wallets/near/near-keypair.js';
import { validateAddressForChain } from '../src/wallets/address-validation.js';
import { readNearBalances } from '../src/wallets/near/near-rpc.js';

async function main() {
  console.log('Testing NEAR Wallet Generation & RPC Integration...');

  // 1. Keypair derivation
  const seed = 'sivan_near_usr_test_user_42';
  const kp = generateNearKeypair(seed);

  console.log('  Account ID:', kp.accountId);
  console.log('  Public Key:', kp.publicKey);

  // Validate 64-character lowercase hex string
  assert.equal(kp.accountId.length, 64, 'Implicit account ID must be 64 characters');
  assert.match(kp.accountId, /^[0-9a-f]{64}$/, 'Implicit account ID must be lowercase hex');

  // Validate ed25519: base58 formatting
  assert.ok(kp.publicKey.startsWith('ed25519:'), 'Public key must start with ed25519:');
  assert.ok(kp.secretKey.startsWith('ed25519:'), 'Secret key must start with ed25519:');

  // 2. Determinism check
  const kp2 = generateNearKeypair(seed);
  assert.equal(kp.accountId, kp2.accountId, 'Key derivation must be deterministic');
  assert.equal(kp.publicKey, kp2.publicKey, 'Public key derivation must be deterministic');
  assert.equal(kp.secretKey, kp2.secretKey, 'Secret key derivation must be deterministic');

  // 3. Address validation check
  const check = validateAddressForChain(kp.accountId, 'near');
  assert.equal(check.valid, true, 'validateAddressForChain must accept generated 64-char hex NEAR address');

  // 4. Cryptographic signing check
  const message = Buffer.from('NEAR testnet transaction payload to sign');
  const signature = signNearPayload(seed, message);
  assert.equal(signature.length, 64, 'Ed25519 signature must be exactly 64 bytes');

  // 5. RPC Balance read (handles un-funded account gracefully)
  const balances = await readNearBalances(kp.accountId, false);
  console.log('  Balances for fresh account:', balances);
  assert.equal(typeof balances.near, 'string', 'NEAR balance must be a string');
  assert.equal(typeof balances.usdc, 'string', 'USDC balance must be a string');
  assert.equal(balances.near, '0.000000', 'Unfunded account must return 0.000000 NEAR');
  assert.equal(balances.usdc, '0.000000', 'Unfunded account must return 0.000000 USDC');

  // 6. Test User Wallet Provisioning Integration
  process.env.DATABASE_PROVIDER = 'json';
  process.env.DATABASE_FILE = '.data/test-near-wallet-e2e.json';
  const { ensureUserWallet, listUserWallets } = await import('../src/wallets/user-wallet.service.js');
  const testUserId = 'usr_near_tester_99';
  const provisioned = await ensureUserWallet(testUserId, 'near');
  console.log('  Provisioned User Wallet for NEAR:', {
    chain: provisioned.chain,
    address: provisioned.address,
    provider: provisioned.provider,
  });
  assert.equal(provisioned.chain, 'near');
  assert.equal(provisioned.address.length, 64);
  assert.match(provisioned.address, /^[0-9a-f]{64}$/);

  const allWallets = await listUserWallets(testUserId);
  const nearWalletInList = allWallets.find((w) => w.chain === 'near');
  assert.ok(nearWalletInList, 'NEAR wallet must be present in listUserWallets');
  assert.equal(nearWalletInList.address, provisioned.address);

  // Clean up temporary test database
  const fs = await import('node:fs/promises');
  await fs.unlink('.data/test-near-wallet-e2e.json').catch(() => null);

  console.log('NEAR Wallet Generation & RPC Integration tests passed 100%!');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
