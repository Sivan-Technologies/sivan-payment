import dotenv from 'dotenv';
import { createPublicClient, http, formatEther, formatUnits, parseAbi } from 'viem';
import { celo } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { getCeloAgentPrivateKey } from '../src/wallets/celo/celo-settlement-relayer.js';
import { CELO_USDC_MAINNET, CELO_CUSD_MAINNET } from '../src/wallets/celo/celo-rpc.js';

dotenv.config();

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

async function main() {
  console.log('=== SIVAN CELO RELAY AGENT VERIFICATION ===\n');

  const privateKey = getCeloAgentPrivateKey();
  if (!privateKey) {
    console.error('FAIL: No private key resolved from environment.');
    process.exit(1);
  }

  const account = privateKeyToAccount(privateKey);
  console.log('Resolved Key Derivation:');
  console.log('  Derived Wallet Address:', account.address);
  console.log('  Expected Wallet Address:', process.env.SIVAN_CELO_RELAY_AGENT_ADDRESS || process.env.SIVAN_CELO_AGENT_ADDRESS);

  const isMatch = account.address.toLowerCase() === (process.env.SIVAN_CELO_RELAY_AGENT_ADDRESS || '').toLowerCase();
  console.log('  Address Match Status:', isMatch ? 'VERIFIED MATCH' : 'MISMATCH WARNING');

  const publicClient = createPublicClient({
    chain: celo,
    transport: http(process.env.CELO_RPC_URL || 'https://forno.celo.org'),
  });

  console.log('\nQuerying Celo Mainnet On-Chain Balances...');
  try {
    const celoGasBalance = await publicClient.getBalance({ address: account.address });
    console.log(`  Native CELO (Gas): ${formatEther(celoGasBalance)} CELO`);

    const usdcBalance = await publicClient.readContract({
      address: CELO_USDC_MAINNET as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account.address],
    });
    console.log(`  USDC Balance (Celo Mainnet): ${formatUnits(usdcBalance, 6)} USDC`);

    const cusdBalance = await publicClient.readContract({
      address: CELO_CUSD_MAINNET as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account.address],
    });
    console.log(`  cUSD Balance (Celo Mainnet): ${formatUnits(cusdBalance, 18)} cUSD`);

    console.log('\n=== STATUS SUMMARY ===');
    if (isMatch) {
      console.log('SUCCESS: Celo Relay Agent key is valid and matches the on-chain address perfectly.');
    } else {
      console.log('WARNING: The derived address does not match SIVAN_CELO_RELAY_AGENT_ADDRESS.');
    }
  } catch (err: any) {
    console.error('Error reading Celo Mainnet state:', err.message);
  }
}

main();
