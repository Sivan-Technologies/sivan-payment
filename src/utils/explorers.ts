import { resolveNetworkMode } from '../wallets/network-mode.js';

export interface NetworkExplorerResult {
  name: string;
  url: string;
}

/**
 * Centralized explorer resolver ensuring automatic Devnet/Mainnet cluster switching
 * across Celo (CeloScan), Stellar (Stellar Expert), Solana (Solscan), and Base (Basescan).
 */
export function getNetworkExplorer(
  networkInput?: string,
  txHash?: string,
  destinationAddress?: string,
  modeInput?: string
): NetworkExplorerResult {
  const net = (networkInput || 'solana').toLowerCase().trim();
  const rawTxHash = txHash?.trim();
  const rawAddr = destinationAddress?.trim();

  const mode = (modeInput || resolveNetworkMode() || 'testnet').toLowerCase();
  const isMainnet = mode === 'mainnet' || mode === 'live';

  if (net.includes('base')) {
    const baseDomain = isMainnet ? 'https://basescan.org' : 'https://sepolia.basescan.org';
    const url = rawTxHash ? `${baseDomain}/tx/${rawTxHash}` : rawAddr ? `${baseDomain}/address/${rawAddr}` : baseDomain;
    return { name: 'Basescan Explorer', url };
  }

  if (net.includes('celo')) {
    const celoDomain = isMainnet ? 'https://celoscan.io' : 'https://sepolia.celoscan.io';
    const url = rawTxHash ? `${celoDomain}/tx/${rawTxHash}` : rawAddr ? `${celoDomain}/address/${rawAddr}` : celoDomain;
    return { name: 'Celo Explorer', url };
  }

  if (net.includes('stellar')) {
    const stellarDomain = isMainnet ? 'https://stellar.expert/explorer/public' : 'https://stellar.expert/explorer/testnet';
    const url = rawTxHash ? `${stellarDomain}/tx/${rawTxHash}` : rawAddr ? `${stellarDomain}/account/${rawAddr}` : stellarDomain;
    return { name: 'StellarExpert Explorer', url };
  }

  if (net.includes('bsc') || net.includes('bnb')) {
    const bscDomain = isMainnet ? 'https://bscscan.com' : 'https://testnet.bscscan.com';
    const url = rawTxHash ? `${bscDomain}/tx/${rawTxHash}` : rawAddr ? `${bscDomain}/address/${rawAddr}` : bscDomain;
    return { name: 'BscScan Explorer', url };
  }

  if (net.includes('eth') || net.includes('ethereum')) {
    const ethDomain = isMainnet ? 'https://etherscan.io' : 'https://sepolia.etherscan.io';
    const url = rawTxHash ? `${ethDomain}/tx/${rawTxHash}` : rawAddr ? `${ethDomain}/address/${rawAddr}` : ethDomain;
    return { name: 'Etherscan Explorer', url };
  }

  // Default: Solana
  const clusterQuery = isMainnet ? '' : '?cluster=devnet';
  const url = rawTxHash
    ? `https://solscan.io/tx/${rawTxHash}${clusterQuery}`
    : rawAddr
    ? `https://solscan.io/account/${rawAddr}${clusterQuery}`
    : `https://solscan.io${clusterQuery}`;
  return { name: 'Solscan Explorer', url };
}
