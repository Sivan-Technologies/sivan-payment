/**
 * Which provider settles which currency, decided by the type system.
 *
 * The rule, stated once:
 *
 *   Bridge does USD, GBP and EUR. It has no naira rail at all.
 *   Breet does NGN. It settles nothing else.
 *
 * These are different companies, different endpoints, different licences. The
 * backend already enforces the split - POST /api/withdrawals rejects 'ngn',
 * POST /api/ngn/offramp/orders rejects usd/gbp/eur - but the frontend had no
 * concept of it. `'usd' | 'gbp' | 'eur'` was written out by hand in twenty
 * places, and four other declarations had `| 'ngn'` bolted on with no rule
 * about which got it. The codebase could not answer "is NGN supported?".
 *
 * That inconsistency was already a live bug: VirtualAccountRequestRecord
 * accepted 'ngn' while the component rendering it looked up
 * vaCurrencyMeta['ngn'], got undefined, and read .title off it. A naira
 * virtual account would have produced a white screen.
 *
 * So the split is expressed as types, and the routing is derived from them.
 * Passing a naira currency to the Bridge path is now a compile error rather
 * than a 400 discovered after the user clicks.
 */

/** Currencies Bridge is licensed to pay out. */
export type BridgeCurrency = 'usd' | 'gbp' | 'eur';

/** Currencies Breet settles. Ghana is available to Breet but not enabled here. */
export type NgnCurrency = 'ngn';

/** Every fiat currency Sivan can pay out, across both providers. */
export type PayoutCurrency = BridgeCurrency | NgnCurrency;

export const BRIDGE_CURRENCIES: readonly BridgeCurrency[] = ['usd', 'gbp', 'eur'];
export const NGN_CURRENCIES: readonly NgnCurrency[] = ['ngn'];

export type PayoutRail = 'bridge' | 'breet';

/**
 * Narrowing predicates.
 *
 * Written as type guards rather than plain booleans so a call site that checks
 * `isNgnCurrency(c)` gets `c: 'ngn'` inside the branch, and the compiler
 * refuses to hand it to a Bridge-typed function afterwards.
 */
export function isBridgeCurrency(currency: string): currency is BridgeCurrency {
  return (BRIDGE_CURRENCIES as readonly string[]).includes(currency);
}

export function isNgnCurrency(currency: string): currency is NgnCurrency {
  return (NGN_CURRENCIES as readonly string[]).includes(currency);
}

/**
 * Which provider settles this currency.
 *
 * Exhaustive by construction: adding a currency to PayoutCurrency without
 * routing it here fails to compile at the `never` assignment below. That is
 * the point - a new payout currency cannot be added and silently sent nowhere.
 */
export function payoutRailFor(currency: PayoutCurrency): PayoutRail {
  if (isNgnCurrency(currency)) return 'breet';
  if (isBridgeCurrency(currency)) return 'bridge';

  const unreachable: never = currency;
  throw new Error(`No payout rail for currency ${String(unreachable)}`);
}

/**
 * The endpoint that actually creates the withdrawal.
 *
 * Two different request shapes behind these, which is why the caller must
 * branch rather than templating a URL: the Bridge path takes an
 * externalAccountId and returns a deposit address, the NGN path takes a quote
 * and returns a Breet deposit address.
 */
export function withdrawalEndpointFor(currency: PayoutCurrency): string {
  return payoutRailFor(currency) === 'breet' ? '/api/ngn/offramp/orders' : '/api/withdrawals';
}

/** Human label, for a UI that should name the rail rather than hide it. */
export const RAIL_LABELS: Record<PayoutRail, string> = {
  bridge: 'Bank transfer',
  breet: 'Nigerian bank transfer',
};

export const CURRENCY_LABELS: Record<PayoutCurrency, string> = {
  usd: 'USD',
  gbp: 'GBP',
  eur: 'EUR',
  ngn: 'NGN',
};

export const CURRENCY_SYMBOLS: Record<PayoutCurrency, string> = {
  usd: '$',
  gbp: '£',
  eur: '€',
  ngn: '₦',
};

/**
 * Networks, per direction, for the NGN rail.
 *
 * NOT one list. Breet's capabilities are asymmetric and the asymmetry is not
 * guessable from the network name:
 *
 *   solana    usdc/usdt   both directions
 *   base      usdc        OFF-RAMP ONLY - Breet publishes no Base withdrawal
 *   base      usdt        neither - Breet has no Base USDT asset at all
 *   ethereum  usdc/usdt   both directions
 *
 * Serving one shared list lets a user pick Base for an on-ramp and only
 * discover after committing that naira cannot settle there. The authoritative
 * answer comes from GET /api/ngn/networks; this mirrors it so the UI can
 * render sensibly before that call resolves, and so a mismatch is visible.
 */
export interface NgnNetworkOption {
  network: string;
  asset: 'usdc' | 'usdt';
  minimumDepositUsd?: number;
}

export interface NgnNetworkLists {
  asset: 'usdc' | 'usdt';
  offramp: NgnNetworkOption[];
  onramp: NgnNetworkOption[];
}

/**
 * Format a fiat amount for display.
 *
 * Naira is shown without decimals: at ~1605 to the dollar, kobo is noise, and
 * every Nigerian banking app the user has seen omits it.
 */
export function formatPayoutAmount(
  amount: number | string,
  currency: PayoutCurrency,
  fractionDigitsOverride?: number,
): string {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(value)) return `${CURRENCY_SYMBOLS[currency]}0`;

  // Payout amounts round to whole naira, but a rate needs more precision than
  // the amount it produces: at 0 decimals a true rate of 1,885.52 displays as
  // 1,886, and amount / rate no longer reconciles for a user checking the
  // arithmetic. Callers showing a rate pass an override.
  const fractionDigits = fractionDigitsOverride ?? (currency === 'ngn' ? 0 : 2);

  return `${CURRENCY_SYMBOLS[currency]}${value.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}
