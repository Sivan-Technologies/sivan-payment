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

  /**
   * Starknet. Placed first by convention, not by necessity: every
   * net.includes(...) pattern in this resolver was checked against the string
   * 'starknet' and only 'starknet' itself matches. In particular 'starknet'
   * contains 'ark', NOT 'arc', so the arc branch below does not capture it.
   *
   * Explorer is Starkscan. Voyager is the other common choice but returns 403
   * to automated requests, so Starkscan is what we can actually verify.
   */
  if (net.includes('starknet') || net.includes('strk')) {
    const snDomain = isMainnet ? 'https://starkscan.co' : 'https://sepolia.starkscan.co';
    const url = rawTxHash ? `${snDomain}/tx/${rawTxHash}` : rawAddr ? `${snDomain}/contract/${rawAddr}` : snDomain;
    return { name: 'Starkscan', url };
  }

  if (net.includes('arc')) {
    const arcDomain = isMainnet ? 'https://explorer.arc.io' : 'https://testnet.arcscan.app';
    const url = rawTxHash ? `${arcDomain}/tx/${rawTxHash}` : rawAddr ? `${arcDomain}/address/${rawAddr}` : arcDomain;
    return { name: 'Arc Explorer', url };
  }

  if (net.includes('arbitrum') || net.includes('arbi')) {
    const arbiDomain = isMainnet ? 'https://arbiscan.io' : 'https://sepolia.arbiscan.io';
    const url = rawTxHash ? `${arbiDomain}/tx/${rawTxHash}` : rawAddr ? `${arbiDomain}/address/${rawAddr}` : arbiDomain;
    return { name: 'Arbiscan Explorer', url };
  }

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
