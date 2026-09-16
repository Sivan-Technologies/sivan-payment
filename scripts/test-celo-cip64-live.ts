import { PrivyWalletProvider } from '../src/wallets/provider/privy-wallet.provider.js';
import { celoRpc } from '../src/wallets/celo/celo-rpc.js';

const SENDER_ADDR = '0xC8cAA84402b1397A055b0c2F388a510f58786285';
const SENDER_WALLET_ID = 'b908vk9zf51tmiqegokdj2be';
const RECIPIENT_ADDR = '0x901255F561BCf73688fa1b1c18a9cA836132d132';
const USDC_TESTNET = '0x01C5C0122039549AD1493B8220cABEdD739BC44E';

async function getUsdcBalance(address: string) {
  const clean = address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const data = '0x70a08231' + clean;
  const res = await celoRpc<string>('eth_call', [{ to: USDC_TESTNET, data }, 'latest'], { production: false });
  return res ? Number(BigInt(res)) / 1e6 : 0;
}

async function getCeloBalance(address: string) {
  const res = await celoRpc<string>('eth_getBalance', [address, 'latest'], { production: false });
  return res ? Number(BigInt(res)) / 1e18 : 0;
}

async function main() {
  console.log('=== Celo CIP-64 Live End-to-End Test ===');
  console.log('Sender Address:    ', SENDER_ADDR);
  console.log('Sender Native CELO:', await getCeloBalance(SENDER_ADDR));
  const senderUsdcBefore = await getUsdcBalance(SENDER_ADDR);
  console.log('Sender USDC Before: ', senderUsdcBefore);

  console.log('\nRecipient Address: ', RECIPIENT_ADDR);
  const recipientUsdcBefore = await getUsdcBalance(RECIPIENT_ADDR);
  console.log('Recipient USDC Before:', recipientUsdcBefore);

  const provider = new PrivyWalletProvider();
  const idemKey = `test_cip64_live_${Date.now()}`;

  console.log('\nSubmitting 5 USDC transfer with CIP-64 fee abstraction (zero native CELO)...');
  const transfer = await provider.createTransfer({
    userId: 'usr_10ed27f0-7ff2-4228-b45c-70a327d9b3c8',
    providerWalletId: SENDER_WALLET_ID,
    chain: 'celo',
    asset: 'usdc',
    amount: '5',
    toAddress: RECIPIENT_ADDR,
    idempotencyKey: idemKey,
    reference: idemKey,
    networkMode: 'testnet',
  });

  console.log('\nTransfer Result:');
  console.log('  Status:              ', transfer.status);
  console.log('  Provider Transfer ID:', transfer.providerTransferId);
  console.log('  Tx Hash:             ', transfer.txHash);

  if (transfer.txHash) {
    console.log('\nWaiting 6 seconds for transaction receipt...');
    await new Promise((r) => setTimeout(r, 6000));

    const receipt = await celoRpc<any>('eth_getTransactionReceipt', [transfer.txHash], { production: false });
    console.log('  Receipt Status:      ', receipt?.status);
    console.log('  Block Number:        ', receipt?.blockNumber ? parseInt(receipt.blockNumber, 16) : 'unknown');
    console.log('  Gas Used:            ', receipt?.gasUsed ? parseInt(receipt.gasUsed, 16) : 'unknown');

    const senderUsdcAfter = await getUsdcBalance(SENDER_ADDR);
    const recipientUsdcAfter = await getUsdcBalance(RECIPIENT_ADDR);
    console.log('\nPost-Transfer Balances:');
    console.log('  Sender USDC After:   ', senderUsdcAfter);
    console.log('  Recipient USDC After:', recipientUsdcAfter);
    console.log('  Sender Delta:        ', (senderUsdcAfter - senderUsdcBefore).toFixed(6), 'USDC (5 USDC transfer + gas in USDC)');
    console.log('  Recipient Delta:     ', (recipientUsdcAfter - recipientUsdcBefore).toFixed(6), 'USDC');
  }

  console.log('\n=== Test Completed Successfully ===');
}

main().catch((err) => {
  console.error('\n❌ Live E2E test failed:', err);
  process.exit(1);
});
