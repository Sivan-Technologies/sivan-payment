import assert from 'node:assert/strict';
import { executeNearOnchainTransfer } from '../src/wallets/near/near-transfer.js';
import { generateNearKeypair } from '../src/wallets/near/near-keypair.js';
import { db } from '../src/database/json-database.js';

async function main() {
  console.log('Testing NEAR Testnet Transfer Execution...');

  // Set isolated test database
  process.env.DATABASE_PROVIDER = 'json';
  process.env.DATABASE_FILE = '.data/test-near-transfer-e2e.json';

  const senderUserId = 'usr_sender_near_test_01';
  const recipientAddress = 'c253485b5adf41bcb0778b35f8271ef4595298ca2065de9fd6999ce94a2f4917';

  // 1. Test NEP-141 USDC Transfer execution on NEAR
  console.log('  1. Testing NEP-141 USDC transfer construction & signing...');
  const usdcTransfer = await executeNearOnchainTransfer({
    senderUserId,
    recipientAddress,
    amount: '15.000000',
    asset: 'usdc',
    production: false,
  });

  console.log('    USDC Transfer Result:', {
    success: usdcTransfer.success,
    txHash: usdcTransfer.txHash,
    sender: usdcTransfer.senderAddress,
    recipient: usdcTransfer.recipientAddress,
    amount: usdcTransfer.amount,
    asset: usdcTransfer.asset,
  });

  assert.ok(usdcTransfer.txHash, 'USDC transfer must return an authentic transaction hash');
  assert.equal(usdcTransfer.asset, 'usdc');
  assert.equal(usdcTransfer.amount, '15.000000');
  assert.equal(usdcTransfer.recipientAddress, recipientAddress);
  assert.equal(usdcTransfer.senderAddress.length, 64, 'Sender address must be 64-character implicit account');

  // 2. Test Native NEAR Transfer execution
  console.log('  2. Testing Native NEAR transfer construction & signing...');
  const nearTransfer = await executeNearOnchainTransfer({
    senderUserId,
    recipientAddress: 'alice.testnet',
    amount: '1.500000',
    asset: 'near',
    production: false,
  });

  console.log('    Native NEAR Transfer Result:', {
    success: nearTransfer.success,
    txHash: nearTransfer.txHash,
    sender: nearTransfer.senderAddress,
    recipient: nearTransfer.recipientAddress,
    amount: nearTransfer.amount,
    asset: nearTransfer.asset,
  });

  assert.ok(nearTransfer.txHash, 'Native NEAR transfer must return an authentic transaction hash');
  assert.equal(nearTransfer.asset, 'near');
  assert.equal(nearTransfer.amount, '1.500000');
  assert.equal(nearTransfer.recipientAddress, 'alice.testnet');

  // 3. Test balance.service executeBalanceTransfer wiring for NEAR
  console.log('  3. Testing balance.service.executeBalanceTransfer routing on NEAR...');
  const { ensureUserWallet } = await import('../src/wallets/user-wallet.service.js');
  const { executeBalanceTransfer } = await import('../src/balances/balance.service.js');

  // Provision sender NEAR wallet row
  await ensureUserWallet(senderUserId, 'near');

  const transferMetadata: any = {
    transferId: 'btx_test_near_001',
    userId: senderUserId,
    asset: 'usdc',
    network: 'near',
    amount: '15.000000',
    netAmount: '15.000000',
    fee: '0.000000',
    destinationAddress: recipientAddress,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  const executed = await executeBalanceTransfer(senderUserId, transferMetadata);
  console.log('    executeBalanceTransfer Result:', {
    transferId: executed.transferId,
    status: executed.status,
    network: executed.network,
  });

  assert.equal(executed.network, 'near');

  // Clean up test file
  const fs = await import('node:fs/promises');
  await fs.unlink('.data/test-near-transfer-e2e.json').catch(() => null);

  console.log('NEAR Testnet Transfer Execution tests passed 100%!');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
