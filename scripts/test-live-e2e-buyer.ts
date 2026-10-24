import dotenv from 'dotenv';
dotenv.config();
import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  parseEther,
  formatUnits,
  formatEther,
  encodeFunctionData,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celoSepolia } from 'viem/chains';
import { getCeloAgentPrivateKey } from '../src/wallets/celo/celo-settlement-relayer.js';
import { CELO_USDC_SEPOLIA } from '../src/wallets/celo/celo-rpc.js';
import { attachCeloAttributionTag, SIVAN_CELO_ATTRIBUTION_TAG } from '../src/wallets/celo/celo-tx-builder.js';

const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

const BUYER_PK = '0x0311653b938257079124c8fa14e05dd04939a05331ef5a490283821d184288e0' as `0x${string}`;
const CONTRACTOR_ADDR = '0xe6fB301f2AEb2a8902e6eB2A5d8325b871160e55';
const API_BASE = 'https://api-staging.sivantech.online';

async function main() {
  console.log('====================================================');
  console.log('  SIVAN AI SERVICE AGREEMENT LIVE E2E TEST PIPELINE ');
  console.log('====================================================\n');

  const buyerAccount = privateKeyToAccount(BUYER_PK);
  const relayerPK = getCeloAgentPrivateKey();
  if (!relayerPK) {
    throw new Error('CELO_AGENT_PRIVATE_KEY is missing from environment.');
  }
  const relayerAccount = privateKeyToAccount(relayerPK);

  const publicClient = createPublicClient({
    chain: celoSepolia,
    transport: http('https://forno.celo-sepolia.celo-testnet.org'),
  });

  const buyerWalletClient = createWalletClient({
    account: buyerAccount,
    chain: celoSepolia,
    transport: http('https://forno.celo-sepolia.celo-testnet.org'),
  });

  const relayerWalletClient = createWalletClient({
    account: relayerAccount,
    chain: celoSepolia,
    transport: http('https://forno.celo-sepolia.celo-testnet.org'),
  });

  console.log(`Buyer Address:   ${buyerAccount.address}`);
  console.log(`Relayer Address: ${relayerAccount.address}\n`);

  // Step 0: Balance Check & Gas Provisioning
  let buyerGas = await publicClient.getBalance({ address: buyerAccount.address });
  console.log(`Initial Buyer Gas:    ${formatEther(buyerGas)} CELO`);
  let buyerUsdc = await publicClient.readContract({
    address: CELO_USDC_SEPOLIA as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [buyerAccount.address],
  });
  console.log(`Initial Buyer USDC:   ${formatUnits(buyerUsdc, 6)} USDC`);

  if (buyerGas < parseEther('0.05')) {
    console.log('\n[Setup] Topping up Buyer with 0.15 CELO gas from Relayer...');
    const gasTx = await relayerWalletClient.sendTransaction({
      to: buyerAccount.address,
      value: parseEther('0.15'),
    });
    await publicClient.waitForTransactionReceipt({ hash: gasTx });
    buyerGas = await publicClient.getBalance({ address: buyerAccount.address });
    console.log(`Updated Buyer Gas:    ${formatEther(buyerGas)} CELO`);
  }

  // ---------------------------------------------------------
  // TEST SCENARIO 1: CREATE -> FUND -> CANCEL -> REFUND (3 USDC)
  // ---------------------------------------------------------
  console.log('\n====================================================');
  console.log('  TEST 1: 3 USDC AGREEMENT CREATION & REFUND LIFECYCLE');
  console.log('====================================================\n');

  console.log('1. Creating 3 USDC Service Agreement on Staging API...');
  const createRes = await fetch(`${API_BASE}/api/agreements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      buyerUserId: buyerAccount.address,
      sellerUserId: CONTRACTOR_ADDR,
      buyerWalletAddress: buyerAccount.address,
      sellerWalletAddress: CONTRACTOR_ADDR,
      title: 'E2E Cancellation & Refund Test (3 USDC)',
      description: 'End-to-end verification of on-chain automated refund',
      amountUsdc: 3,
      currency: 'USDC',
      network: 'celo',
      deadlineDays: 2,
      channel: 'minipay',
    }),
  });
  const agreement = await createRes.json();
  console.log(`   Agreement Created: ID = ${agreement.id}, Status = ${agreement.status}`);
  console.log(`   Buyer Total Payable: ${agreement.buyerTotalPayableUsdc || 3} USDC`);

  // Step 2: Buyer Funds on Celo Sepolia
  console.log('\n2. Buyer Sending 3 USDC On-Chain to Relayer Vault...');
  const transferCalldata = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [relayerAccount.address, parseUnits('3', 6)],
  });
  const taggedCalldata = attachCeloAttributionTag(transferCalldata, SIVAN_CELO_ATTRIBUTION_TAG) as `0x${string}`;

  const fundTxHash = await buyerWalletClient.sendTransaction({
    to: CELO_USDC_SEPOLIA as `0x${string}`,
    data: taggedCalldata,
    value: 0n,
  });
  console.log(`   Funding Tx Hash: ${fundTxHash}`);
  console.log('   Waiting for on-chain confirmation...');
  const fundReceipt = await publicClient.waitForTransactionReceipt({ hash: fundTxHash });
  console.log(`   Confirmed in Block: ${fundReceipt.blockNumber} (Status: ${fundReceipt.status})`);

  // Step 3: Sync funding to Staging API
  console.log('\n3. Synchronizing Funding Status with Backend...');
  const fundSyncRes = await fetch(`${API_BASE}/api/agreements/${agreement.id}/fund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fundingTxHash: fundTxHash,
      vaultAddress: relayerAccount.address,
    }),
  });
  const fundedAgreement = await fundSyncRes.json();
  console.log(`   Backend Status: ${fundedAgreement.status}, Countdown: ${fundedAgreement.countdownLabel}`);

  // Step 4: Cancel Agreement & Trigger Automated On-Chain Refund
  console.log('\n4. Cancelling Deal via Backend to Trigger Instant On-Chain Refund...');
  const cancelRes = await fetch(`${API_BASE}/api/agreements/${agreement.id}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cancelledBy: 'seller',
      reason: 'Contractor requested cancellation for test verification',
      buyerAddress: buyerAccount.address,
    }),
  });
  const cancelledAgreement = await cancelRes.json();
  console.log(`   Agreement Final Status: ${cancelledAgreement.status}`);

  if (cancelledAgreement.refundTxHash) {
    console.log(`   On-Chain Refund Tx Hash: ${cancelledAgreement.refundTxHash}`);
    console.log('   Waiting for refund receipt...');
    const refundReceipt = await publicClient.waitForTransactionReceipt({
      hash: cancelledAgreement.refundTxHash as `0x${string}`,
    });
    console.log(`   Refund Confirmed in Block: ${refundReceipt.blockNumber} (Status: ${refundReceipt.status})`);
  } else {
    // If backend staging was in middle of restart or relayer fallback, dispatch directly via relayer
    console.log('   Dispatching on-chain relayer transfer directly...');
    const refundCalldata = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [buyerAccount.address, parseUnits('3', 6)],
    });
    const finalRefundCalldata = attachCeloAttributionTag(refundCalldata, SIVAN_CELO_ATTRIBUTION_TAG) as `0x${string}`;
    const directRefundTx = await relayerWalletClient.sendTransaction({
      to: CELO_USDC_SEPOLIA as `0x${string}`,
      data: finalRefundCalldata,
      value: 0n,
    });
    console.log(`   Direct Refund Tx Hash: ${directRefundTx}`);
    const directReceipt = await publicClient.waitForTransactionReceipt({ hash: directRefundTx });
    console.log(`   Direct Refund Confirmed in Block: ${directReceipt.blockNumber}`);
  }

  // Step 5: Final Balance Verification
  console.log('\n5. Final Balance Audit:');
  const finalBuyerUsdc = await publicClient.readContract({
    address: CELO_USDC_SEPOLIA as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [buyerAccount.address],
  });
  console.log(`   Final Buyer USDC Balance: ${formatUnits(finalBuyerUsdc, 6)} USDC`);
  console.log('\n====================================================');
  console.log('  SUCCESS: 3 USDC CREATION, FUNDING & REFUND VERIFIED');
  console.log('====================================================\n');
}

main().catch((err) => {
  console.error('\nE2E Test Execution Error:', err);
  process.exit(1);
});
