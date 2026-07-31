/**
 * What Breet can actually do, per network, mapped onto Sivan's own network
 * vocabulary.
 *
 * WHY THIS FILE EXISTS
 *
 * Sivan's balance controls and Breet's capabilities do not agree, and the
 * disagreement is dangerous rather than cosmetic. Sivan's DEFAULT enabled
 * networks are base, solana and avalanche_c_chain. Breet can only WITHDRAW
 * stablecoins to Ethereum, Tron, BSC, Solana and TON.
 *
 * So of Sivan's three defaults, only Solana can receive a Breet on-ramp. Base
 * and Avalanche cannot. Without this map, an on-ramp to a Base address would be
 * accepted, Breet would be asked to send on a network it does not support, and
 * the failure would surface after Sivan's float had already been committed.
 *
 * Deposit and withdrawal capabilities also differ from each other, so they are
 * tracked separately:
 *
 *   Base     - USDC deposit only. No withdrawal at all. Off-ramp yes, on-ramp no.
 *   Arbitrum - USDC deposit only. No withdrawal.
 *   Polygon  - USDC and USDT deposit. No withdrawal.
 *   Tron/TON/BSC - withdrawal yes, but not in Sivan's network enum today.
 *   Avalanche - Breet takes AVAX the coin, but NO stablecoin on that chain,
 *               in either direction.
 *
 * Asset ids are Breet's, and differ between mainnet and testnet, so both are
 * recorded. Their docs warn the list is a snapshot and to call GET
 * /trades/assets for live state - so these are used to REFUSE early, never as
 * the final word on availability.
 */

import type { BalanceNetwork } from '../../balances/balance.service.js';

export type StableAsset = 'usdc' | 'usdt';

/**
 * Breet's asset ID is a Mongo ObjectId, NOT the identifier in their docs.
 *
 * Verified against the live sandbox: the supported-assets page lists
 * `SOL_USDC_JKVK`, but the API returns that string as `identifier` and a
 * separate `id` of `69b3e33d5aef202395e800e8`. Endpoints keyed by asset take
 * the ObjectId - passing the identifier returns "id is not a valid id".
 *
 * ObjectIds are per-integration and can change, so they are NOT hardcoded.
 * The identifier is stable and human-readable, so it is stored here and
 * resolved to an id at runtime via GET /trades/assets. resolveAssetId() below.
 */
export interface BreetNetworkCapability {
  /** Sivan's name for the network. */
  network: BalanceNetwork;
  /** Breet's `network` value on the withdrawal endpoint, when withdrawals work. */
  breetWithdrawalNetwork?: 'ERC20' | 'TRC20' | 'BSC' | 'SOL' | 'TON';
  /** Can Sivan receive a user's stablecoin here? Drives OFF-RAMP. */
  deposit: Partial<Record<StableAsset, { mainnet: string; testnet: string; minUsd: number }>>;
  /** Can Breet send stablecoin here? Drives ON-RAMP. */
  withdrawal: Partial<Record<StableAsset, boolean>>;
}

export const BREET_NETWORKS: readonly BreetNetworkCapability[] = [
  {
    network: 'solana',
    breetWithdrawalNetwork: 'SOL',
    deposit: {
      usdc: { mainnet: 'SOL_USDC_PTHX', testnet: 'SOL_USDC_JKVK', minUsd: 15 },
      usdt: { mainnet: 'SOL_USDT_EWAY', testnet: 'USDT_B7ZDHS8D_TOR7', minUsd: 15 },
    },
    withdrawal: { usdc: true, usdt: true },
  },
  {
    network: 'ethereum',
    breetWithdrawalNetwork: 'ERC20',
    deposit: {
      usdc: { mainnet: 'USDC', testnet: 'USDC_ETH_TEST5_0GER', minUsd: 15 },
      usdt: { mainnet: 'USDT_ERC20', testnet: 'USDT_ETH_TEST5_WFZR', minUsd: 15 },
    },
    withdrawal: { usdc: true, usdt: true },
  },
  {
    network: 'tron',
    breetWithdrawalNetwork: 'TRC20',
    deposit: {
      usdt: { mainnet: 'TRX_USDT_S2UZ', testnet: 'USDT_TRX_TEST2', minUsd: 20 },
      // Breet withdraws USDC over TRC20 but publishes no USDC-on-Tron DEPOSIT
      // asset, so this is deliberately asymmetric rather than an oversight.
    },
    withdrawal: { usdc: true, usdt: true },
  },
  {
    // Deposit only. Breet lists no Base withdrawal, so an on-ramp to a Base
    // address is impossible - and Base is one of Sivan's DEFAULT networks.
    network: 'base',
    deposit: {
      usdc: {
        mainnet: 'USDC_BASECHAIN_ETH_5I5C',
        testnet: 'USDC_BASECHAIN_ETH_TEST5_8SH8',
        minUsd: 15,
      },
    },
    withdrawal: {},
  },
  {
    network: 'arbitrum',
    deposit: {
      usdc: { mainnet: 'USDC_ARB_3SBJ', testnet: 'USDC_ARB_SEPOLIA_V84S', minUsd: 15 },
    },
    withdrawal: {},
  },
  {
    network: 'polygon',
    deposit: {
      usdc: { mainnet: 'USDC_POLYGON_NXTB', testnet: 'USDC_AMOY_POLYGON_TEST_7WWV', minUsd: 15 },
      usdt: { mainnet: 'USDT_POLYGON', testnet: 'USD_POLYGON_TEST_MUMBAI_QFXA', minUsd: 15 },
    },
    withdrawal: {},
  },
  {
    // Breet supports AVAX the native coin, but no USDC or USDT on Avalanche.
    // Another of Sivan's defaults that cannot carry a stablecoin through Breet.
    network: 'avalanche_c_chain',
    deposit: {},
    withdrawal: {},
  },
] as const;

function capability(network: BalanceNetwork) {
  return BREET_NETWORKS.find((entry) => entry.network === network);
}

/** Off-ramp: can a user send us this asset on this network via Breet? */
export function canDeposit(network: BalanceNetwork, asset: StableAsset): boolean {
  return Boolean(capability(network)?.deposit?.[asset]);
}

/** On-ramp: can Breet send this asset to this network? */
export function canWithdraw(network: BalanceNetwork, asset: StableAsset): boolean {
  return Boolean(capability(network)?.withdrawal?.[asset]);
}

/** Breet's `network` value for the withdrawal endpoint. */
export function breetWithdrawalNetwork(network: BalanceNetwork): string | undefined {
  return capability(network)?.breetWithdrawalNetwork;
}

/**
 * Breet's asset id for a deposit, for the current environment.
 *
 * Testnet and mainnet ids are entirely different strings, so using a mainnet id
 * in development silently addresses the wrong asset.
 */
export function breetDepositAssetId(
  network: BalanceNetwork,
  asset: StableAsset,
  environment: 'development' | 'production'
): string | undefined {
  const entry = capability(network)?.deposit?.[asset];
  if (!entry) return undefined;
  return environment === 'production' ? entry.mainnet : entry.testnet;
}

/**
 * Minimum deposit in USD.
 *
 * Below this Breet FLAGS the deposit: confirmed on-chain, funds held, not
 * credited. Showing a user a deposit address without telling them the minimum
 * is how their money ends up stuck.
 */
export function breetMinimumDepositUsd(
  network: BalanceNetwork,
  asset: StableAsset,
  environment: 'development' | 'production'
): number | undefined {
  const entry = capability(network)?.deposit?.[asset];
  if (!entry) return undefined;
  // Every test asset has a $1 minimum, per Breet's docs.
  return environment === 'production' ? entry.minUsd : 1;
}

/**
 * Resolve a doc identifier to Breet's real asset id, from the live list.
 *
 * Cached per process: the list is stable within a run, and re-fetching it on
 * every quote would add a network round trip to a latency-sensitive path.
 */
const assetIdCache = new Map<string, string>();

export function cacheAssetIds(assets: Array<{ id?: string; identifier?: string }>): void {
  for (const asset of assets) {
    if (asset?.id && asset?.identifier) assetIdCache.set(asset.identifier, asset.id);
  }
}

export function resolveAssetId(identifier: string): string | undefined {
  return assetIdCache.get(identifier);
}

/** Test seam. */
export function clearAssetIdCache(): void {
  assetIdCache.clear();
}

/** Networks from a controls list that Breet can actually on-ramp to. */
export function usableForOnramp(
  enabled: readonly BalanceNetwork[],
  asset: StableAsset
): BalanceNetwork[] {
  return enabled.filter((network) => canWithdraw(network, asset));
}

/** Networks from a controls list that Breet can actually off-ramp from. */
export function usableForOfframp(
  enabled: readonly BalanceNetwork[],
  asset: StableAsset
): BalanceNetwork[] {
  return enabled.filter((network) => canDeposit(network, asset));
}

/**
 * Reconcile Sivan's enabled networks against Breet, for admin display.
 *
 * Surfacing the gap is the point. An operator enabling Base on the assumption
 * that Breet will honour it should be told at configuration time, not by a
 * user whose on-ramp failed after the float moved.
 */
export function reconcileWithControls(enabled: readonly BalanceNetwork[]) {
  const report = enabled.map((network) => ({
    network,
    offrampUsdc: canDeposit(network, 'usdc'),
    offrampUsdt: canDeposit(network, 'usdt'),
    onrampUsdc: canWithdraw(network, 'usdc'),
    onrampUsdt: canWithdraw(network, 'usdt'),
  }));

  return {
    networks: report,
    onrampCapable: report.filter((r) => r.onrampUsdc || r.onrampUsdt).map((r) => r.network),
    offrampCapable: report.filter((r) => r.offrampUsdc || r.offrampUsdt).map((r) => r.network),
    /** Enabled in Sivan, unusable with Breet in either direction. */
    unsupported: report
      .filter((r) => !r.offrampUsdc && !r.offrampUsdt && !r.onrampUsdc && !r.onrampUsdt)
      .map((r) => r.network),
  };
}
