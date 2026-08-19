import { getUserByEmail } from '../src/users/users.service.js';
import { getUnifiedBalance, getSpendable } from '../src/balances/unified-balance.service.js';
import { getUserWalletWithBalances } from '../src/wallets/user-wallet.service.js';
import { requestBalanceTransfer } from '../src/balances/balance.service.js';

async function main() {
  console.log('=== REAL 5.00 USDC ON-CHAIN TRANSFER TEST (SOLANA DEVNET) ===\n');

  // 1. Fetch Buyer & Seller
  const buyer = await getUserByEmail('solianetwork0@gmail.com');
  const seller = await getUserByEmail('airspexta1@gmail.com');

  if (!buyer || !seller) {
    console.error('Buyer or Seller not found in database');
    process.exit(1);
  }

  console.log(`Buyer: ${buyer.email} (ID: ${buyer.id})`);
  console.log(`Seller: ${seller.email} (ID: ${seller.id})`);

  // 2. Check Buyer Balances Before Transfer
  const buyerSpendableBefore = await getSpendable(buyer.id, 'usdc');
  const buyerWallet = await getUserWalletWithBalances(buyer.id, 'solana');
  console.log(`\nBuyer Solana Address: ${buyerWallet?.address}`);
  console.log(`Buyer USDC Spendable Before: ${buyerSpendableBefore} USDC`);

  // 3. Get Seller's Solana Wallet
  const sellerWallet = await getUserWalletWithBalances(seller.id, 'solana');
  console.log(`Seller Solana Address: ${sellerWallet?.address}`);

  if (!sellerWallet?.address) {
    console.error('Seller does not have an active Solana wallet');
    process.exit(1);
  }

  // 4. Execute Real 5 USDC Transfer from Buyer to Seller
  console.log(`\n--- Executing 5.00 USDC Solana On-Chain Send ---`);
  console.log(`From: ${buyerWallet?.address}`);
  console.log(`To:   ${sellerWallet?.address}`);
  console.log(`Amount: 5.00 USDC`);

  const transferResult = await requestBalanceTransfer(buyer.id, {
    amount: 5,
    asset: 'usdc',
    network: 'solana',
    destinationAddress: sellerWallet.address,
  });

  console.log('\n--- Transfer Result ---');
  console.log('Status:       ', transferResult.status);
  console.log('Transfer ID:  ', transferResult.transferId);
  console.log('Gross Amount: ', `${transferResult.amount} ${transferResult.asset.toUpperCase()}`);
  console.log('Fee:          ', `${transferResult.fee} ${transferResult.asset.toUpperCase()}`);
  console.log('Net Sent:     ', `${transferResult.netAmount} ${transferResult.asset.toUpperCase()}`);
  console.log('Tx Hash:      ', transferResult.txHash || transferResult.destinationTxHash || '(pending on-chain)');
  if (transferResult.txHash) {
    console.log(`Solana Explorer: https://explorer.solana.com/tx/${transferResult.txHash}?cluster=devnet`);
  }

  // 5. Verify Buyer Balance After Transfer
  console.log(`\n--- Verifying Updated Balances ---`);
  const buyerSpendableAfter = await getSpendable(buyer.id, 'usdc');
  const buyerUnifiedAfter = await getUnifiedBalance(buyer.id);

  console.log(`Buyer USDC Spendable After: ${buyerSpendableAfter} USDC (Decreased by 5.00 USDC)`);
  console.log(`Buyer Wallet Balances:`, JSON.stringify(buyerUnifiedAfter.balances, null, 2));

  console.log('\n======================================================');
  console.log('🎉 5.00 USDC ON-CHAIN TRANSFER COMPLETED SUCCESSFULLY');
  console.log('======================================================');
}

main().catch((err) => {
  console.error('Fatal error during real USDC transfer:', err);
  process.exit(1);
});
