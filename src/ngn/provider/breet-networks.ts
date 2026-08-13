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

  // LIVE VALUE FIRST. This function used to return `entry.minUsd` (hardcoded
  // 15 everywhere) in production and a flat 1 in development. Both were wrong:
  // The static table happens to match Breet's DOCUMENTED mainnet figures ($15
  // for USDC/USDT on these chains, $20 for Tron USDT), but it is still a
  // snapshot: Breet say plainly that assets and their minimums change, and
  // their own docs disagree with their own API in the sandbox - documented as
  // $1 for every test asset, actually 50 for most, 10 for USDC_BSC_TEST and
  // 5000 for BCH/DOGE. Reading the live value is the only way to be right in
  // both environments.
  const identifier = environment === 'production' ? entry.mainnet : entry.testnet;
  if (environment === 'development') return 1;
  const live = assetEconomics(identifier);
  if (live) return live.minimumUsd;

  // Not loaded yet. The static number is a last resort and is known to be
  // unreliable, so callers that can refuse should refuse instead.
  return environment === 'production' ? entry.minUsd : undefined;
}

/**
 * The smallest off-ramp that will actually clear, all-in.
 *
 * Three numbers, none of them optional:
 *
 *   Breet's minimum  - below it the deposit is flagged, held and NOT credited
 *   gas              - user-pays deducts it from the USDC being sent, so the
 *                      amount that ARRIVES is less than the amount signed
 *   buffer           - Privy's paymaster collects the EXACT fee after
 *                      execution, so the pre-flight figure is an estimate; if
 *                      actual lands above it, the arriving amount dips under
 *                      the minimum and the user pays the flag fee
 *
 * The failure this prevents is the expensive one: money leaves the user's
 * wallet, does not arrive as naira, and costs a fee to retrieve.
 */
export function minimumOfframpUsd(input: {
  breetMinimumUsd: number;
  estimatedGasUsd: number;
  /** Fraction of gas held back. 0.2 = 20%. */
  bufferPercent?: number;
  /** Floor for the buffer, so near-zero gas still leaves headroom. */
  minimumBufferUsd?: number;
}): {
  minimumUsd: number;
  breakdown: { breetMinimumUsd: number; estimatedGasUsd: number; bufferUsd: number };
} {
  const bufferPercent = input.bufferPercent ?? 1.0;
  const minimumBufferUsd = input.minimumBufferUsd ?? 0.5;

  const rawBufferUsd = (input.breetMinimumUsd * bufferPercent) / 100;
  const bufferUsd = Math.max(rawBufferUsd, minimumBufferUsd);
  const total = input.breetMinimumUsd + input.estimatedGasUsd + bufferUsd;

  return {
    // Rounded UP, to the cent. Rounding down would reintroduce the exact
    // sub-minimum case this exists to prevent.
    minimumUsd: Math.ceil(total * 100) / 100,
    breakdown: {
      breetMinimumUsd: input.breetMinimumUsd,
      estimatedGasUsd: input.estimatedGasUsd,
      bufferUsd: Math.round(bufferUsd * 100) / 100,
    },
  };
}

/**
 * Will this withdrawal clear, and if not, why?
 *
 * Returns the shortfall so the UI can say "add $2.40" rather than "too small".
 */
export function offrampClears(input: {
  amountUsd: number;
  breetMinimumUsd: number;
  estimatedGasUsd: number;
  bufferPercent?: number;
  minimumBufferUsd?: number;
}): {
  clears: boolean;
  minimumUsd: number;
  arrivesUsd: number;
  shortfallUsd: number;
  reason?: string;
} {
  const { minimumUsd } = minimumOfframpUsd(input);

  // What the payout rail actually receives, which is the number that matters - not the
  // number the user typed.
  const arrivesUsd = Math.round((input.amountUsd - input.estimatedGasUsd) * 100) / 100;
  const clears = input.amountUsd >= minimumUsd;

  return {
    clears,
    minimumUsd,
    arrivesUsd,
    shortfallUsd: clears ? 0 : Math.round((minimumUsd - input.amountUsd) * 100) / 100,
    reason: clears
      ? undefined
      : `After ${input.estimatedGasUsd.toFixed(2)} USD of network fees only ` +
        `${arrivesUsd.toFixed(2)} USD would reach the payout rail, below its ` +
        `${input.breetMinimumUsd.toFixed(2)} USD minimum. Send at least ` +
        `${minimumUsd.toFixed(2)} USD.`,
  };
}

/**
 * Resolve a doc identifier to Breet's real asset id, from the live list.
 *
 * Cached per process: the list is stable within a run, and re-fetching it on
 * every quote would add a network round trip to a latency-sensitive path.
 */
const assetIdCache = new Map<string, string>();

/**
 * Live economics per asset, read from the same GET /trades/assets response.
 *
 * These are NOT static facts. Breet's docs state that assets can be added,
 * removed or disabled at any time, and their sandbox proves the point: the
 * docs claim $1 for every test asset while the API returns 50 for most, 10 for
 * USDC_BSC_TEST and 5000 for BCH_TEST/DOGE_TEST. Mainnet is documented at $15
 * for USDC/USDT and $20 for Tron USDT, which the static table matches - but a
 * snapshot that is currently correct is still a snapshot.
 */
export interface BreetAssetEconomics {
  /** Breet's `minimum`, in USD. Below this a deposit is FLAGGED, not credited. */
  minimumUsd: number;
  /** Breet's `flagFeeUSD`. What recovering a flagged deposit costs the user. */
  flagFeeUsd: number;
  /** Confirmations before Breet credits. Drives the "how long" the UI promises. */
  confirmations?: number;
  /**
   * Breet's `isActive`. An asset can be disabled at any time - their docs say
   * so explicitly - and a disabled asset still appears in the list.
   *
   * `undefined` means Breet did not send the field. That is NOT the same as
   * false: the sandbox omits it on all 23 assets, so treating absent as
   * disabled would turn off the entire rail. Absent is treated as active, and
   * only an explicit `false` disables.
   */
  isActive?: boolean;
}

const assetEconomicsCache = new Map<string, BreetAssetEconomics>();

export function cacheAssetIds(
  assets: Array<{
    id?: string;
    identifier?: string;
    minimum?: number;
    flagFeeUSD?: number;
    confirmations?: number;
    isActive?: boolean;
  }>
): void {
  for (const asset of assets) {
    if (asset?.id && asset?.identifier) assetIdCache.set(asset.identifier, asset.id);

    // Cached separately from the id: an asset can be resolvable while Breet
    // omits its economics, and a missing minimum must read as "unknown" rather
    // than silently becoming 0 - which would let every amount through.
    if (asset?.identifier && typeof asset.minimum === 'number') {
      assetEconomicsCache.set(asset.identifier, {
        minimumUsd: asset.minimum,
        flagFeeUsd: typeof asset.flagFeeUSD === 'number' ? asset.flagFeeUSD : 0,
        confirmations: asset.confirmations,
        isActive: typeof asset.isActive === 'boolean' ? asset.isActive : undefined,
      });
    }
  }
}

/**
 * Has Breet explicitly disabled this asset?
 *
 * Only an explicit `false` counts. Absent means Breet did not tell us, and the
 * safe reading of silence is "still available" - the sandbox omits the field
 * entirely, so failing closed on absence would disable every network.
 */
export function assetIsDisabled(identifier: string): boolean {
  return assetEconomics(identifier)?.isActive === false;
}

export function resolveAssetId(identifier: string): string | undefined {
  return assetIdCache.get(identifier);
}

/**
 * Live minimum and flag fee for an asset, or undefined if not yet loaded.
 *
 * Undefined is meaningful: the caller must refuse to quote rather than assume
 * a floor. Guessing low flags the user's deposit and costs them the flag fee.
 */
export function assetEconomics(identifier: string): BreetAssetEconomics | undefined {
  return assetEconomicsCache.get(identifier);
}

/** Test seam. */
export function clearAssetIdCache(): void {
  assetIdCache.clear();
  assetEconomicsCache.clear();
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
