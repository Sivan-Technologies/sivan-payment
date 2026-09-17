import { createWalletClient, createPublicClient, http, parseUnits, encodeFunctionData, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo, celoSepolia } from 'viem/chains';
import { CELO_USDC_MAINNET, CELO_USDC_SEPOLIA, CELO_CNGN_MAINNET, CELO_CUSD_MAINNET, celoRpcEndpoints } from './celo-rpc.js';
import { SIVAN_CELO_ATTRIBUTION_TAG, attachCeloAttributionTag } from './celo-tx-builder.js';
import { resolveNetworkMode } from '../network-mode.js';

const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

export interface CeloSettlementParams {
  toAddress: string;
  amount: number | string;
  currency?: string;
  agreementId?: string;
  isRefund?: boolean;
}

export interface CeloSettlementResult {
  success: boolean;
  txHash?: string;
  senderAddress?: string;
  error?: string;
}

/**
 * Returns the configured Celo Agent / Vault private key.
 * Loaded strictly from environment variables without hardcoded fallback keys.
 */
export function getCeloAgentPrivateKey(): `0x${string}` | null {
  const rawKey = (
    process.env.CELO_RELAY_AGENT_PRIVATE_KEY ||
    process.env.CELO_AGENT_PRIVATE_KEY ||
    process.env.SETTLEMENT_PRIVATE_KEY ||
    process.env.OPERATOR_PRIVATE_KEY ||
    ''
  ).trim();

  if (!rawKey) return null;
  const formatted = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;
  if (/^0x[a-fA-F0-9]{64}$/.test(formatted)) {
    return formatted as `0x${string}`;
  }
  return null;
}

/**
 * Automatically dispatches an on-chain ERC-20 transfer (e.g. USDC / cUSD) on Celo
 * from the Sivan Agent / Protocol Vault directly to the recipient's wallet address.
 * Includes official Sivan hackathon attribution tag (celo_bafcc2e56bd7).
 */
export async function dispatchCeloSettlementTransfer(
  params: CeloSettlementParams
): Promise<CeloSettlementResult> {
  const privateKey = getCeloAgentPrivateKey();
  if (!privateKey) {
    return {
      success: false,
      error: 'CELO_AGENT_PRIVATE_KEY is not configured in backend environment.',
    };
  }

  const cleanTo = String(params.toAddress || '').trim();
  if (!cleanTo.startsWith('0x') || cleanTo.length !== 42) {
    return {
      success: false,
      error: `Invalid Celo recipient address: ${cleanTo}`,
    };
  }

  const isMainnet = resolveNetworkMode() === 'mainnet';
  const targetChain = isMainnet ? celo : celoSepolia;
  const endpoints = celoRpcEndpoints({ production: isMainnet });
  const rpcUrl = endpoints[0] || (isMainnet ? 'https://forno.celo.org' : 'https://forno.celo-sepolia.celo-testnet.org');

  const curr = (params.currency || 'usdc').toUpperCase();
  let tokenAddress: `0x${string}`;
  let decimals = 6;

  if (curr === 'CNGN') {
    tokenAddress = CELO_CNGN_MAINNET as `0x${string}`;
    decimals = 6;
  } else if (curr === 'CUSD') {
    tokenAddress = (isMainnet ? CELO_CUSD_MAINNET : '0xEF4d55D6dE8e8d73232827Cd1e9b2F2dBb45bC80') as `0x${string}`;
    decimals = 18;
  } else {
    tokenAddress = (isMainnet ? CELO_USDC_MAINNET : CELO_USDC_SEPOLIA) as `0x${string}`;
    decimals = 6;
  }

  try {
    const account = privateKeyToAccount(privateKey);
    const client = createWalletClient({
      account,
      chain: targetChain,
      transport: http(rpcUrl),
    });

    const publicClient = createPublicClient({
      chain: targetChain,
      transport: http(rpcUrl),
    });

    const amountRaw = parseUnits(String(params.amount), decimals);

    // Build standard ERC-20 transfer calldata with Sivan attribution suffix
    const baseCalldata = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [cleanTo as `0x${string}`, amountRaw],
    });
    const finalData = attachCeloAttributionTag(baseCalldata, SIVAN_CELO_ATTRIBUTION_TAG) as `0x${string}`;

    // Send transaction
    const txHash = await client.sendTransaction({
      to: tokenAddress,
      data: finalData,
      value: 0n,
    });

    return {
      success: true,
      txHash,
      senderAddress: account.address,
    };
  } catch (err: any) {
    console.error('[CeloSettlementRelayer] On-chain transfer error:', err);
    return {
      success: false,
      error: err.message || 'On-chain transfer failed',
    };
  }
}
