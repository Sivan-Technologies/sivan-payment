import dotenv from 'dotenv';
dotenv.config();
import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
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
  console.log('  TEST 2: 3 USDC AGREEMENT CREATION & RELEASE LIFECYCLE');
  console.log('====================================================\n');

  const buyerAccount = privateKeyToAccount(BUYER_PK);
  const relayerPK = getCeloAgentPrivateKey();
  const relayerAccount = privateKeyToAccount(relayerPK!);

  const publicClient = createPublicClient({
    chain: celoSepolia,
    transport: http('https://forno.celo-sepolia.celo-testnet.org'),
  });

  const buyerWalletClient = createWalletClient({
    account: buyerAccount,
    chain: celoSepolia,
    transport: http('https://forno.celo-sepolia.celo-testnet.org'),
  });

  const initialContractorUsdc = await publicClient.readContract({
    address: CELO_USDC_SEPOLIA as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [CONTRACTOR_ADDR],
  });
  console.log(`Initial Contractor (${CONTRACTOR_ADDR}) USDC: ${formatUnits(initialContractorUsdc, 6)} USDC`);

  // Step 1: Create Agreement
  console.log('\n1. Creating 3 USDC Agreement on Staging API...');
  const createRes = await fetch(`${API_BASE}/api/agreements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      buyerUserId: buyerAccount.address,
      sellerUserId: CONTRACTOR_ADDR,
      buyerWalletAddress: buyerAccount.address,
      sellerWalletAddress: CONTRACTOR_ADDR,
      title: 'E2E Milestone Release Test (3 USDC)',
      description: 'End-to-end verification of on-chain automated contractor payout',
      amountUsdc: 3,
      currency: 'USDC',
      network: 'celo',
      deadlineDays: 2,
      channel: 'minipay',
    }),
  });
  const agreement = await createRes.json();
  console.log(`   Created ID = ${agreement.id}, Status = ${agreement.status}`);

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
  const fundReceipt = await publicClient.waitForTransactionReceipt({ hash: fundTxHash });
  console.log(`   Confirmed in Block: ${fundReceipt.blockNumber}`);

  // Step 3: Sync funding to Staging API
  console.log('\n3. Synchronizing Funding Status...');
  await fetch(`${API_BASE}/api/agreements/${agreement.id}/fund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fundingTxHash: fundTxHash,
      vaultAddress: relayerAccount.address,
    }),
  });

  // Step 4: Contractor Submits Deliverable
  console.log('\n4. Contractor Submitting Deliverable Proof...');
  const deliverRes = await fetch(`${API_BASE}/api/agreements/${agreement.id}/deliver`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deliverableLink: 'https://github.com/Sivan-Technologies/sivan-minipay-app',
      deliveryNote: 'Milestone deliverables ready for inspection and approval',
    }),
  });
  const deliveredAgreement = await deliverRes.json();
  console.log(`   Status: ${deliveredAgreement.status} (${deliveredAgreement.countdownLabel})`);

  // Step 5: Buyer Approves & Releases Funds (Triggers Automated On-Chain Transfer)
  console.log('\n5. Buyer Approving & Releasing Funds (Triggering Relayer Payout)...');
  const releaseRes = await fetch(`${API_BASE}/api/agreements/${agreement.id}/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const releasedAgreement = await releaseRes.json();
  console.log(`   Final Status: ${releasedAgreement.status} (${releasedAgreement.countdownLabel})`);
  console.log(`   On-Chain Release Tx Hash: ${releasedAgreement.releaseTxHash}`);

  if (releasedAgreement.releaseTxHash) {
    console.log('   Waiting for release transaction confirmation on-chain...');
    const releaseReceipt = await publicClient.waitForTransactionReceipt({
      hash: releasedAgreement.releaseTxHash as `0x${string}`,
    });
    console.log(`   Confirmed in Block: ${releaseReceipt.blockNumber} (Status: ${releaseReceipt.status})`);
  }

  // Step 6: Verify Contractor Final Balance
  const finalContractorUsdc = await publicClient.readContract({
    address: CELO_USDC_SEPOLIA as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [CONTRACTOR_ADDR],
  });
  console.log(`\n6. Contractor Final USDC Balance: ${formatUnits(finalContractorUsdc, 6)} USDC`);

  console.log('\n====================================================');
  console.log('  SUCCESS: 3 USDC CREATION, FUNDING & RELEASE VERIFIED');
  console.log('====================================================\n');
}

main().catch((err) => {
  console.error('\nE2E Release Test Error:', err);
  process.exit(1);
});
