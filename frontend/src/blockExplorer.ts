/**
 * WHERE A USER GOES TO SEE THEIR OWN TRANSACTION.
 *
 * Requested after a support round where two Solana sends both showed
 * "Processing" and the user concluded the money had not arrived. It had - both
 * were finalised on chain - but the product gave them no way to check. The
 * only reference on screen was the recipient address, unlabelled, identical
 * across both sends.
 *
 * A block explorer link is the shortest path from "did it work?" to a verified
 * yes, and it is the one answer that does not depend on trusting us.
 *
 * TWO THINGS THIS MUST GET RIGHT, BOTH OF WHICH LOSE THE USER IF WRONG:
 *
 * 1. NETWORK. A Base Sepolia hash on basescan.org mainnet returns "not found",
 *    which reads as "your transaction does not exist" - strictly worse than no
 *    link at all. The network mode comes from the SERVER (preferences.
 *    networkMode, set from NETWORK_MODE) and is never guessed here.
 *
 * 2. IDENTIFIER TYPE. A sponsored EVM transfer is an ERC-4337 user operation.
 *    Its userOperationHash is NOT a transaction hash and will not resolve on a
 *    normal explorer transaction page until a bundler includes it. Linking one
 *    to /tx/ produces a dead page, so user operations get jiffyscan, which
 *    indexes them specifically.
 */

export type ExplorerNetwork = 'base' | 'ethereum' | 'solana' | 'polygon' | 'arbitrum' | string;

export interface ExplorerLink {
  /** Absolute URL, safe to put in href. */
  url: string;
  /** Shown to the user, e.g. "Basescan". Never a bare domain. */
  label: string;
  /** True when this points at a test network, so the UI can say so. */
  testnet: boolean;
}

/**
 * Explorer hosts per network and mode.
 *
 * Solana uses one host with a ?cluster= parameter rather than a separate
 * domain, which is why it is modelled as a builder rather than a base string.
 */
const EVM_EXPLORERS: Record<string, { mainnet: string; testnet: string; label: string }> = {
  base: { mainnet: 'https://basescan.org', testnet: 'https://sepolia.basescan.org', label: 'Basescan' },
  bsc: { mainnet: 'https://bscscan.com', testnet: 'https://testnet.bscscan.com', label: 'BscScan' },
  bnb: { mainnet: 'https://bscscan.com', testnet: 'https://testnet.bscscan.com', label: 'BscScan' },
  celo: { mainnet: 'https://celoscan.io', testnet: 'https://celo-alfajores.blockscout.com', label: 'Celoscan' },
  ethereum: { mainnet: 'https://etherscan.io', testnet: 'https://sepolia.etherscan.io', label: 'Etherscan' },
  polygon: { mainnet: 'https://polygonscan.com', testnet: 'https://amoy.polygonscan.com', label: 'Polygonscan' },
  arbitrum: { mainnet: 'https://arbiscan.io', testnet: 'https://sepolia.arbiscan.io', label: 'Arbiscan' },
  arc: { mainnet: 'https://explorer.arc.network', testnet: 'https://testnet.arcscan.io', label: 'Arc Explorer' },
  avalanche: { mainnet: 'https://snowtrace.io', testnet: 'https://subnets-test.avax.network/c-chain', label: 'Snowtrace' },
  avalanche_c_chain: { mainnet: 'https://snowtrace.io', testnet: 'https://subnets-test.avax.network/c-chain', label: 'Snowtrace' },
};

/** CAIP-ish chain ids jiffyscan uses for user operations. */
const USEROP_CHAIN: Record<string, { mainnet: string; testnet: string }> = {
  base: { mainnet: 'base', testnet: 'base-sepolia' },
  bsc: { mainnet: 'bsc', testnet: 'bsc-testnet' },
  celo: { mainnet: 'celo', testnet: 'celo-alfajores' },
  ethereum: { mainnet: 'mainnet', testnet: 'sepolia' },
  polygon: { mainnet: 'matic', testnet: 'amoy' },
  arbitrum: { mainnet: 'arbitrum-one', testnet: 'arbitrum-sepolia' },
  arc: { mainnet: 'arc', testnet: 'arc-testnet' },
};

export interface ExplorerInput {
  network?: string;
  /** The real transaction hash or Solana signature, when one exists. */
  txHash?: string;
  /**
   * Present INSTEAD of txHash while an EVM transfer is sponsored and not yet
   * included by a bundler. Deliberately a separate field: treating it as a
   * transaction hash is what produces a dead explorer page.
   */
  userOperationHash?: string;
  networkMode?: 'mainnet' | 'testnet';
}

/**
 * Build the explorer link for a transfer, or undefined when there is nothing
 * honest to link to.
 *
 * Returns undefined rather than a best-guess URL. A link that 404s costs more
 * trust than an absent one, because the user reads the empty page as evidence
 * about their money rather than about our URL.
 */
export function explorerLink(input: ExplorerInput): ExplorerLink | undefined {
  const network = String(input.network ?? '').toLowerCase();
  // Absent means mainnet, matching the server default and the same reasoning
  // as types.ts: never claim a real transfer is on a test chain.
  const testnet = input.networkMode === 'testnet';
  const hash = (input.txHash ?? '').trim();
  const userOp = (input.userOperationHash ?? '').trim();

  if (network === 'solana') {
    // Solana has no user-operation concept; the signature is available
    // immediately, so a missing one means we genuinely have nothing.
    if (!hash) return undefined;
    const cluster = testnet ? '?cluster=devnet' : '';
    return {
      url: `https://solscan.io/tx/${encodeURIComponent(hash)}${cluster}`,
      label: 'Solscan',
      testnet,
    };
  }

  if (network === 'stellar') {
    if (!hash) return undefined;
    const host = testnet ? 'https://stellar.expert/explorer/testnet' : 'https://stellar.expert/explorer/public';
    return {
      url: `${host}/tx/${encodeURIComponent(hash)}`,
      label: 'StellarExpert',
      testnet,
    };
  }

  const evm = EVM_EXPLORERS[network];
  if (!evm) return undefined;

  if (hash) {
    return {
      url: `${testnet ? evm.testnet : evm.mainnet}/tx/${encodeURIComponent(hash)}`,
      label: evm.label,
      testnet,
    };
  }

  /**
   * Sponsored and not yet included. jiffyscan resolves a user-operation hash;
   * the standard explorers do not, and would show "not found".
   */
  if (userOp) {
    const chain = USEROP_CHAIN[network];
    if (!chain) return undefined;
    return {
      url: `https://jiffyscan.xyz/userOpHash/${encodeURIComponent(userOp)}?network=${testnet ? chain.testnet : chain.mainnet}`,
      label: 'Jiffyscan',
      testnet,
    };
  }

  return undefined;
}

/**
 * The identifier to SHOW, distinct from the one to link.
 *
 * A user comparing what is on screen against what their wallet or counterparty
 * shows needs the string itself, not just a link.
 */
export function explorerReference(input: ExplorerInput): string | undefined {
  const hash = (input.txHash ?? '').trim();
  if (hash) return hash;
  const userOp = (input.userOperationHash ?? '').trim();
  return userOp || undefined;
}

/** Middle-truncated for display; the full value stays in the title attribute. */
export function shortHash(value?: string): string {
  if (!value) return '—';
  if (value.length <= 20) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

/**
 * A chain id rendered for a human.
 *
 * Chain ids are internal strings. Shown raw they read as a typo - a rendered
 * screenshot of the transaction panel caught "Sent on solana" and a Network
 * field reading "base", on the screen where a user is checking where their
 * money went. Capitalisation is not decoration there; it is the difference
 * between a product that looks maintained and one that does not.
 *
 * Lives here rather than in a component so the panel, the row and anything
 * added later agree. The backend has its own copy in
 * deposit-notification.service.ts, deliberately duplicated rather than shared:
 * a backend import of frontend source is what broke the production build once
 * already (see tsconfig.json).
 */
export function networkLabel(chain?: string): string {
  const key = String(chain ?? '').trim().toLowerCase();
  const map: Record<string, string> = {
    solana: 'Solana',
    base: 'Base',
    bsc: 'BNB Chain',
    bnb: 'BNB Chain',
    stellar: 'Stellar',
    celo: 'Celo',
    ethereum: 'Ethereum',
    polygon: 'Polygon',
    arbitrum: 'Arbitrum',
    arc: 'Arc',
    avalanche_c_chain: 'Avalanche',
    tron: 'Tron',
    sivan_p2p: 'Sivan Instant P2P',
    p2p: 'Sivan Instant P2P',
  };
  // Unknown chains still get their underscores removed and a capital, so a new
  // network reads as a name rather than as a database column.
  return map[key] ?? key.replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase());
}

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

  const isMainnet = modeInput ? (modeInput.toLowerCase() === 'mainnet' || modeInput.toLowerCase() === 'live') : false;

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
