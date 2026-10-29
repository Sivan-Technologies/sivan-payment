/**
 * REAL-TIME ARC TESTNET LIVE ON-CHAIN TRANSFER TEST
 *
 * Sender Account: Derived dynamically from ARC_TESTNET_PRIVATE_KEY
 * Network: Arc Testnet (Chain ID 5042002)
 * RPC: https://rpc.testnet.arc.io
 * Native Gas Asset: USDC (18 decimals)
 *
 * Tests live on-chain direct transfers of 3 USDC with Sivan protocol fees inclusive:
 * - Gross Amount: 3.00 USDC per transfer
 * - Dynamic Sivan Fee: 0.10 USDC (0.5% with $0.10 floor) to Sivan Protocol Fee Wallet
 * - Net to Recipient: 2.90 USDC
 * - Verified on Arc Testnet via live receipts and ArcScan explorer links.
 */

import { createPublicClient, createWalletClient, http, formatEther, parseEther, defineChain, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { resolveNetworkFeeConfig, quoteTransferFee } from '../src/balances/transfer-fee-policy.js';
import { nativeBalanceOf } from '../src/wallets/evm/evm-rpc.js';
import { getNetworkExplorer } from '../src/utils/explorers.js';

// Deterministically derive test EVM address from user seed as per protocol rules
function deriveDeterministicEvmAddress(seed: string): `0x${string}` {
  return privateKeyToAccount(keccak256(toHex(seed))).address;
}

// Define Arc Testnet Chain for viem
const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: {
    name: 'USDC',
    symbol: 'USDC',
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ['https://rpc.testnet.arc.io'],
    },
  },
  blockExplorers: {
    default: {
      name: 'ArcScan',
      url: 'https://testnet.arcscan.io',
    },
  },
});

const rawKey = (process.env.ARC_TESTNET_PRIVATE_KEY || process.env.TESTNET_PRIVATE_KEY || '').trim();
const SENDER_KEY = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as `0x${string}`;
const SIVAN_FEE_WALLET = (
  process.env.SIVAN_FEE_WALLET_ARC ||
  process.env.SIVAN_FEE_WALLET_EVM ||
  deriveDeterministicEvmAddress('sivan_protocol_fee_wallet')
) as `0x${string}`;
const RECIPIENT_1 = (
  process.env.TESTNET_RECIPIENT_1 ||
  deriveDeterministicEvmAddress('sivan_arc_test_recipient_1')
) as `0x${string}`;
const RECIPIENT_2 = (
  process.env.TESTNET_RECIPIENT_2 ||
  deriveDeterministicEvmAddress('sivan_arc_test_recipient_2')
) as `0x${string}`;

async function main() {
  if (!rawKey || rawKey === '0x') {
    console.error('Error: ARC_TESTNET_PRIVATE_KEY or TESTNET_PRIVATE_KEY environment variable is required.');
    process.exit(1);
  }

  console.log('\n================================================================');
  console.log('🌐 ARC TESTNET REAL-TIME ON-CHAIN DIRECT TRANSFER SUITE');
  console.log('================================================================\n');

  // 1. Initialize Clients
  const account = privateKeyToAccount(SENDER_KEY);
  console.log(`Sender Address:  ${account.address}`);

  const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http('https://rpc.testnet.arc.io'),
  });

  const walletClient = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http('https://rpc.testnet.arc.io'),
  });

  // 2. Verify Initial Live Balance on Arc Testnet
  const initialBalanceWei = await publicClient.getBalance({ address: account.address });
  const initialBalanceUsdc = formatEther(initialBalanceWei);
  console.log(`Initial Arc Testnet Balance: ${initialBalanceUsdc} USDC (${initialBalanceWei} wei)`);

  // Verify internal Sivan nativeBalanceOf helper reads identically
  const internalBalanceStr = await nativeBalanceOf('arc', account.address, 18, { production: false });
  console.log(`Sivan nativeBalanceOf:        ${internalBalanceStr} USDC`);

  // 3. Compute Dynamic Fee
  const transferAmount = 3.0; // 3 USDC
  const feeConfig = resolveNetworkFeeConfig('arc');
  const feeQuote = quoteTransferFee(transferAmount, feeConfig);

  console.log('\n--- Sivan Dynamic Fee Engine ---');
  console.log(`Network:             arc`);
  console.log(`Gross Amount:        ${transferAmount.toFixed(2)} USDC`);
  console.log(`Applied Fee Rule:    ${feeQuote.appliedRule} (${feeQuote.effectivePercent}%)`);
  console.log(`Sivan Transfer Fee:  ${feeQuote.fee} USDC`);
  console.log(`Net To Recipient:    ${feeQuote.netAmount} USDC`);
  console.log(`Protocol Fee Wallet: ${SIVAN_FEE_WALLET}`);

  const netSendWei = parseEther(feeQuote.netAmount);
  const feeWei = parseEther(feeQuote.fee);

  // 4. Execute Real Transfer #1 (3.00 USDC Gross: 2.90 Net + 0.10 Fee)
  console.log('\n================================================================');
  console.log('🚀 EXECUTING TRANSFER #1: 3.00 USDC DIRECT TRANSFER (FEES INCLUSIVE)');
  console.log('================================================================');

  console.log(`Sending ${feeQuote.netAmount} USDC to Recipient 1 (${RECIPIENT_1})...`);
  const tx1Hash = await walletClient.sendTransaction({
    to: RECIPIENT_1 as `0x${string}`,
    value: netSendWei,
  });
  console.log(`Tx 1 Submitted: ${tx1Hash}`);
  console.log(`Waiting for block inclusion on Arc Testnet...`);

  const receipt1 = await publicClient.waitForTransactionReceipt({ hash: tx1Hash });
  console.log(`✅ Tx 1 Confirmed in block ${receipt1.blockNumber}! Gas Used: ${receipt1.gasUsed}`);
  console.log(`ArcScan Explorer: https://testnet.arcscan.io/tx/${tx1Hash}`);

  console.log(`\nCollecting Sivan Protocol Fee of ${feeQuote.fee} USDC to ${SIVAN_FEE_WALLET}...`);
  const fee1Hash = await walletClient.sendTransaction({
    to: SIVAN_FEE_WALLET as `0x${string}`,
    value: feeWei,
  });
  console.log(`Fee Tx 1 Submitted: ${fee1Hash}`);
  const feeReceipt1 = await publicClient.waitForTransactionReceipt({ hash: fee1Hash });
  console.log(`✅ Fee Tx 1 Confirmed in block ${feeReceipt1.blockNumber}! Gas Used: ${feeReceipt1.gasUsed}`);
  console.log(`ArcScan Explorer: https://testnet.arcscan.io/tx/${fee1Hash}`);

  // 5. Execute Real Transfer #2 (3.00 USDC Gross: 2.90 Net + 0.10 Fee)
  console.log('\n================================================================');
  console.log('🚀 EXECUTING TRANSFER #2: 3.00 USDC DIRECT TRANSFER (FEES INCLUSIVE)');
  console.log('================================================================');

  console.log(`Sending ${feeQuote.netAmount} USDC to Recipient 2 (${RECIPIENT_2})...`);
  const tx2Hash = await walletClient.sendTransaction({
    to: RECIPIENT_2 as `0x${string}`,
    value: netSendWei,
  });
  console.log(`Tx 2 Submitted: ${tx2Hash}`);
  console.log(`Waiting for block inclusion on Arc Testnet...`);

  const receipt2 = await publicClient.waitForTransactionReceipt({ hash: tx2Hash });
  console.log(`✅ Tx 2 Confirmed in block ${receipt2.blockNumber}! Gas Used: ${receipt2.gasUsed}`);
  console.log(`ArcScan Explorer: https://testnet.arcscan.io/tx/${tx2Hash}`);

  console.log(`\nCollecting Sivan Protocol Fee of ${feeQuote.fee} USDC to ${SIVAN_FEE_WALLET}...`);
  const fee2Hash = await walletClient.sendTransaction({
    to: SIVAN_FEE_WALLET as `0x${string}`,
    value: feeWei,
  });
  console.log(`Fee Tx 2 Submitted: ${fee2Hash}`);
  const feeReceipt2 = await publicClient.waitForTransactionReceipt({ hash: fee2Hash });
  console.log(`✅ Fee Tx 2 Confirmed in block ${feeReceipt2.blockNumber}! Gas Used: ${feeReceipt2.gasUsed}`);
  console.log(`ArcScan Explorer: https://testnet.arcscan.io/tx/${fee2Hash}`);

  // 6. Verify Updated Live Balance
  const finalBalanceWei = await publicClient.getBalance({ address: account.address });
  const finalBalanceUsdc = formatEther(finalBalanceWei);
  const diffWei = initialBalanceWei - finalBalanceWei;
  const diffUsdc = formatEther(diffWei);

  console.log('\n================================================================');
  console.log('📊 FINAL ON-CHAIN RECONCILIATION SUMMARY');
  console.log('================================================================');
  console.log(`Initial Balance:   ${initialBalanceUsdc} USDC`);
  console.log(`Final Balance:     ${finalBalanceUsdc} USDC`);
  console.log(`Total Spent:       ${diffUsdc} USDC (6.00 USDC transfers & fees + ~${(Number(diffUsdc) - 6.0).toFixed(6)} USDC gas)`);

  const updatedSivanBalance = await nativeBalanceOf('arc', account.address, 18, { production: false });
  console.log(`Sivan Live Balance: ${updatedSivanBalance} USDC`);

  console.log('\n✅ All transfers completed successfully on Arc Testnet!');
  console.log('================================================================\n');

  return {
    tx1Hash,
    fee1Hash,
    tx2Hash,
    fee2Hash,
    initialBalance: initialBalanceUsdc,
    finalBalance: finalBalanceUsdc,
  };
}

main().catch((err) => {
  console.error('\n❌ ERROR during Arc live transfer:', err);
  process.exit(1);
});
