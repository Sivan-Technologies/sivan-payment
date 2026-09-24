import { createWalletClient, http, parseUnits, encodeFunctionData, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo, celoSepolia } from 'viem/chains';
import { CELO_USDC_MAINNET, CELO_USDC_SEPOLIA, CELO_CNGN_MAINNET, CELO_CUSD_MAINNET, celoRpcEndpoints, celoRpc } from './celo-rpc.js';
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
  /**
   * true ONLY when the on-chain receipt has been obtained and status === '0x1'.
   * A broadcast that was accepted by the RPC node but whose receipt has not
   * yet been confirmed, or whose receipt shows status 0x0 (reverted), will
   * always produce success:false. Never trust this field without confirmed:true.
   */
  success: boolean;
  /**
   * true when a receipt with status 0x1 was obtained. false on revert, timeout,
   * or any other non-confirmation outcome. This field disambiguates
   * "broadcast sent" from "value actually moved on-chain".
   */
  confirmed?: boolean;
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

    const amountRaw = parseUnits(String(params.amount), decimals);

    // Build standard ERC-20 transfer calldata with Sivan attribution suffix
    const baseCalldata = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [cleanTo as `0x${string}`, amountRaw],
    });
    const finalData = attachCeloAttributionTag(baseCalldata, SIVAN_CELO_ATTRIBUTION_TAG) as `0x${string}`;

    // Broadcast the transaction and capture the hash.
    const txHash = await client.sendTransaction({
      to: tokenAddress,
      data: finalData,
      value: 0n,
    });

    /**
     * RECEIPT VERIFICATION — guard against false success receipts.
     *
     * sendTransaction() resolves as soon as the RPC accepts the broadcast.
     * It does NOT mean the transaction was included on-chain, and it
     * certainly does not mean it succeeded. A transaction can be included
     * and REVERT (status 0x0), in which case no value moved. Returning
     * success:true at this point would emit a false receipt that could be
     * used fraudulently.
     *
     * We poll eth_getTransactionReceipt until the receipt arrives (the node
     * has included the tx in a block) and then check its status field:
     *   0x1 = success  → return success:true
     *   0x0 = reverted → return success:false, money did NOT move
     *   null = not yet included → keep polling
     *
     * Max wait: 30 attempts × 2 000 ms = ~60 seconds.
     * Celo blocks land every ~5 seconds so the receipt normally arrives in
     * the first 1–3 attempts.
     */
    const POLL_ATTEMPTS = 30;
    const POLL_INTERVAL_MS = 2_000;
    const production = isMainnet;

    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      // Brief pause before polling (skip on attempt 0 to avoid unnecessary delay
      // when the tx is already included, but still wait at least once after the
      // first miss to give the node time to index it).
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      let receipt: any = null;
      try {
        receipt = await celoRpc<any>('eth_getTransactionReceipt', [txHash], { production });
      } catch {
        // RPC hiccup — not evidence the tx failed; keep polling.
        continue;
      }

      if (!receipt) {
        // Not yet included in a block.
        continue;
      }

      // Receipt obtained — inspect the EVM status code.
      if (receipt.status === '0x1') {
        // Transaction included AND succeeded.
        return {
          success: true,
          confirmed: true,
          txHash,
          senderAddress: account.address,
        };
      }

      if (receipt.status === '0x0') {
        // Transaction was included but REVERTED. Value did not move.
        console.error(
          `[CeloSettlementRelayer] Transaction ${txHash} was included but REVERTED (status 0x0). No funds were transferred.`
        );
        return {
          success: false,
          confirmed: false,
          txHash,
          error: `On-chain transaction reverted (status 0x0). No funds were transferred. txHash: ${txHash}`,
        };
      }

      // Unexpected status value — log and keep polling rather than assuming success.
      console.warn(
        `[CeloSettlementRelayer] Unexpected receipt status "${receipt.status}" for ${txHash}; continuing to poll.`
      );
    }

    // Receipt never arrived within the polling window.
    // The broadcast is in flight but confirmation is unknown — do NOT claim success.
    console.error(
      `[CeloSettlementRelayer] Receipt for ${txHash} did not arrive within ${POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000}s. Status unknown.`
    );
    return {
      success: false,
      confirmed: false,
      txHash,
      error: `Transaction broadcast succeeded but on-chain confirmation timed out after ${POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000}s. txHash: ${txHash} — verify manually on-chain before considering complete.`,
    };
  } catch (err: any) {
    console.error('[CeloSettlementRelayer] On-chain transfer error:', err);
    return {
      success: false,
      error: err.message || 'On-chain transfer failed',
    };
  }
}
