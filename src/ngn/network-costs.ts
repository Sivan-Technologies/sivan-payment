/**
 * What it costs to move a stablecoin off each chain, in USD.
 *
 * WHY THIS FILE EXISTS
 *
 * This number was previously hardcoded in two places - ngn-quotes.service.ts
 * and frontend/src/ngnMinimum.ts - and BOTH ended in the same silent guess:
 *
 *   return TYPICAL_GAS_USD[network] ?? 0.5;
 *
 * The networks a user can sell on are configured by an admin at runtime
 * (payment controls, intersected with Breet's capability map). The tables were
 * edited by hand at deploy time. So the moment an admin enabled a chain that no
 * table had caught up with, every user was quoted against a guessed $0.50 fee,
 * with nothing marking it as a guess.
 *
 * That guess is not cosmetic. It feeds minimumOfframpUsd(), which decides
 * whether a withdrawal is allowed to proceed. Guess LOW on an expensive chain
 * and the product tells the user "$15.50 will clear", takes the money, gas eats
 * more than estimated, and less than Breet's minimum arrives - which per
 * breet-networks.ts is the worst outcome in the product: confirmed on-chain,
 * funds held, NOT credited, and a flag fee charged to recover.
 *
 * So an unknown chain now yields `undefined`, and every caller must decide what
 * to do about that explicitly. A missing network is an inconvenience; a wrong
 * floor costs someone their money.
 *
 * THESE ARE ESTIMATES FOR QUOTING ONLY. The real fee is settled by the wallet
 * provider at signing time. They exist so the floor accounts for gas rather
 * than assuming zero, and so a user can see why Base costs less than Ethereum
 * before choosing.
 *
 * Adding a network: add it here, and it appears in GET /api/ngn/networks with
 * its fee and label automatically. Deliberately NOT given a default - if we do
 * not know the fee for a chain, the product must not pretend it does.
 */

/**
 * Ethereum is deliberately included despite being poor value: $2-10 of gas
 * against a $15 minimum is 13-66% of a small withdrawal. Showing the number is
 * how a user understands why Base is cheaper.
 */
export const NETWORK_GAS_USD: Readonly<Record<string, number>> = {
  solana: 0.001,
  base: 0.02,
  ethereum: 5,
  arbitrum: 0.05,
  polygon: 0.01,
};

/**
 * A chain's name as its own users write it.
 *
 * The API's identifiers are lowercase slugs - 'bsc', 'avalanche_c_chain'.
 * Printed raw next to a deposit address they read as debug output, and 'bsc' in
 * particular is not what the network calls itself anywhere a user will have
 * seen it.
 *
 * Unknown slugs are humanised rather than dropped: a chain this map has not
 * caught up with must still be NAMED, because the name is what stops someone
 * sending on the wrong one.
 */
const NETWORK_LABELS: Readonly<Record<string, string>> = {
  solana: 'Solana',
  base: 'Base',
  ethereum: 'Ethereum',
  polygon: 'Polygon',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
  avalanche_c_chain: 'Avalanche',
  avalanche: 'Avalanche',
  bsc: 'BNB Smart Chain',
  tron: 'Tron',
  ton: 'TON',
};

/**
 * The fee estimate for a chain, or undefined if we do not have one.
 *
 * `undefined` is the entire point of this function - see the file header. Do
 * not add a `?? someNumber` at a call site; refuse the operation instead.
 */
export function gasEstimateUsd(network: string): number | undefined {
  return NETWORK_GAS_USD[String(network ?? '').toLowerCase()];
}

export function networkDisplayLabel(network: string): string {
  const slug = String(network ?? '').toLowerCase();
  if (!slug) return '';
  if (NETWORK_LABELS[slug]) return NETWORK_LABELS[slug];
  // avalanche_c_chain -> Avalanche C Chain, rather than a raw slug.
  return slug
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
