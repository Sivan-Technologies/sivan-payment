/**
 * The smallest NGN off-ramp that will actually clear.
 *
 * Mirrors src/ngn/provider/breet-networks.ts on the server. Duplicated
 * deliberately rather than fetched: the user is typing an amount, and a
 * round trip per keystroke to tell them "too small" is the wrong shape. The
 * server still enforces it - this exists so the refusal happens before they
 * commit, not after.
 *
 * What makes this non-obvious is that the amount which must clear Breet's
 * minimum is the amount that ARRIVES, not the amount typed:
 *
 *   withdraw $15.20 -> gas takes $0.40 -> $14.80 arrives -> below the $15
 *   minimum -> Breet FLAGS it: confirmed on-chain, funds held, NOT credited,
 *   and a flag fee charged to recover.
 *
 * That is the worst outcome in the product - money gone from the wallet, no
 * naira delivered - so the floor includes gas and a buffer on top.
 */

export interface OfframpFloorInput {
  /** Breet's minimum for this asset, in USD. From GET /api/ngn/networks. */
  breetMinimumUsd: number;
  /** Estimated network fee, in USD. Deducted from the USDC being sent. */
  estimatedGasUsd: number;
  /** Fraction of gas held back. 0.2 = 20%. */
  bufferPercent?: number;
  /** Floor for the buffer, so near-zero gas still leaves headroom. */
  minimumBufferUsd?: number;
}

export interface OfframpFloor {
  minimumUsd: number;
  breakdown: { breetMinimumUsd: number; estimatedGasUsd: number; bufferUsd: number };
}

export function minimumOfframpUsd(input: OfframpFloorInput): OfframpFloor {
  const bufferPercent = input.bufferPercent ?? 0.2;
  const minimumBufferUsd = input.minimumBufferUsd ?? 0.5;

  // A floor, not a choice between the two: on Solana gas is ~$0.001, so 20% of
  // it is nothing and the flat amount does the work.
  const bufferUsd = Math.max(input.estimatedGasUsd * bufferPercent, minimumBufferUsd);
  const minimumUsd = input.breetMinimumUsd + input.estimatedGasUsd + bufferUsd;

  return {
    // Rounded UP. Rounding down reintroduces the sub-minimum case this exists
    // to prevent.
    minimumUsd: Math.ceil(minimumUsd * 100) / 100,
    breakdown: {
      breetMinimumUsd: input.breetMinimumUsd,
      estimatedGasUsd: input.estimatedGasUsd,
      bufferUsd: Math.round(bufferUsd * 100) / 100,
    },
  };
}

export interface OfframpVerdict {
  clears: boolean;
  minimumUsd: number;
  arrivesUsd: number;
  shortfallUsd: number;
  reason?: string;
}

/** Will this withdrawal clear, and if not, by how much is it short? */
export function offrampClears(input: OfframpFloorInput & { amountUsd: number }): OfframpVerdict {
  const { minimumUsd } = minimumOfframpUsd(input);

  const arrivesUsd = Math.round((input.amountUsd - input.estimatedGasUsd) * 100) / 100;
  const clears = input.amountUsd >= minimumUsd;

  return {
    clears,
    minimumUsd,
    arrivesUsd,
    // Named so the UI can say "add $2.40" rather than "too small".
    shortfallUsd: clears ? 0 : Math.round((minimumUsd - input.amountUsd) * 100) / 100,
    reason: clears
      ? undefined
      : `After $${input.estimatedGasUsd.toFixed(2)} of network fees only ` +
        `$${arrivesUsd.toFixed(2)} would reach our partner, below their ` +
        `$${input.breetMinimumUsd.toFixed(2)} minimum. Send at least $${minimumUsd.toFixed(2)}.`,
  };
}

/**
 * Typical gas, in USD, per network.
 *
 * Estimates for display only - the real figure comes from the wallet provider
 * at signing time. They are here so the UI can show a floor before the user
 * has picked an amount, and so the ordering (Solana cheapest, Ethereum
 * dearest) is visible at the point of choice.
 *
 * Ethereum is deliberately included despite being poor value: $2-10 of gas
 * against a $15 minimum is 13-66% of a small withdrawal. Showing the number is
 * how a user understands why Base is the default.
 */
export const TYPICAL_GAS_USD: Record<string, number> = {
  solana: 0.001,
  base: 0.02,
  ethereum: 5,
  arbitrum: 0.05,
  polygon: 0.01,
};

export function typicalGasUsd(network: string): number {
  return TYPICAL_GAS_USD[network] ?? 0.5;
}
