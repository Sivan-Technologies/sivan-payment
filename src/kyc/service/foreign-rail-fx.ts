/**
 * Converting a foreign-rail amount into NGN, so one ceiling can measure both.
 *
 * WHY THIS EXISTS AT ALL. Every limit in this system is denominated in naira -
 * `limitNgn`, `usedNgn`, `amountNgn` - because that is the currency the
 * Nigerian thresholds are written in. The policy engine's own TransactionRequest
 * says so: "This transaction, in NGN. Foreign-rail amounts must be converted
 * first." Nothing ever did the converting, because nothing ever measured a
 * foreign-rail transaction. Now that Bridge withdrawals are enforced, something
 * has to.
 *
 * WHY A CONFIGURED RATE AND NOT THE LIVE QUOTE RATE. The obvious idea is to ask
 * the NGN provider what USD/NGN is right now, so the limit and the price a user
 * is quoted can never drift. It is the wrong call here for two reasons:
 *
 *   1. It puts a provider network call inside the withdrawal request. That is
 *      the exact mistake that made POST /api/ngn/offramp/orders exceed the
 *      Cloudflare worker's 12s UPSTREAM_TIMEOUT_MS and return a 503 for an
 *      order that had actually been created.
 *   2. A compliance ceiling that moves with the market is not a ceiling. If the
 *      naira weakens 8% overnight, every user's effective dollar limit silently
 *      widens by 8% without anyone deciding that.
 *
 * So the rate is an explicit, auditable operational setting. It is deliberately
 * conservative-by-default and it is meant to be reviewed, not to track spot.
 *
 * SET LIMITS_USD_TO_NGN_RATE IN PRODUCTION. The 1500 default matches the mock
 * provider's rate, which keeps tests coherent, but it is a placeholder: if the
 * real rate is 1600 and this says 1500, every foreign withdrawal is measured
 * ~6% smaller than it really is and the ceiling leaks by that much.
 */
export const DEFAULT_USD_TO_NGN_RATE = 1500;

export function usdToNgnRate(): number {
  const configured = Number(process.env.LIMITS_USD_TO_NGN_RATE);
  // A zero, a negative, or an unparseable value would make every amount 0 and
  // therefore make every limit check pass. Refuse the input, not the check.
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_USD_TO_NGN_RATE;
}

/** A USD (or USD-pegged stablecoin) amount, expressed in naira for the policy engine. */
export function usdToNgn(amountUsd: number): number {
  const amount = Number(amountUsd);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return amount * usdToNgnRate();
}
