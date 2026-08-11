import { usdToNgnRate } from '../kyc/service/foreign-rail-fx.js';

/**
 * DISPLAY-ONLY FX, SO A LIMIT CAN BE READ IN THE CURRENCY THE USER PICKED.
 *
 * WHY THIS EXISTS. Every limit in this system is denominated in naira -
 * `limitNgn`, `usedNgn`, `remainingNgn` - because the Nigerian thresholds are
 * written in naira. That is the right unit for ENFORCEMENT and it is not
 * changing here. But it leaked straight onto the screen: the dashboard printed
 * `₦100,000 left` to whoever the allowance belonged to, and the only thing
 * that decided whether to print it was `summary.path === 'ngn_bank'` - the
 * user's COUNTRY. A user who set their currency to USD in Settings saw naira
 * anyway, because nothing in the app had ever read that preference.
 *
 * So this converts the naira figure for DISPLAY, and nothing else.
 *
 * THREE THINGS THIS DELIBERATELY IS NOT:
 *
 *   1. NOT AN ENFORCEMENT RATE. Nothing in the withdrawal path, the policy
 *      engine or the allowance ledger may import this. The ceiling is still
 *      compared in naira with usdToNgnRate(), so a display rate that drifts
 *      cannot widen or narrow anybody's actual limit. The worst a wrong rate
 *      here can do is show a number that is off by the drift - the same class
 *      of error as a stale price, not a compliance hole.
 *
 *   2. NOT A LIVE FEED. Putting a provider call behind a dashboard render is
 *      the mistake that made POST /api/ngn/offramp/orders exceed the
 *      Cloudflare worker's 12s UPSTREAM_TIMEOUT_MS. These are operational
 *      settings, reviewed deliberately, and they ride on a payload the client
 *      already fetches on load - no new request, no new failure mode.
 *
 *   3. NOT A QUOTE. A user must never plan a withdrawal against these. The
 *      response carries `approximate: true` and the UI is required to render
 *      converted figures with a `≈`, because the money that actually moves is
 *      priced by the NGN provider's own quote at the moment of the trade.
 *
 * THE NAIRA RATE IS NOT ITS OWN SETTING, ON PURPOSE. It reuses
 * usdToNgnRate() - the exact function the enforcement path uses. Two
 * separately-configured USD/NGN numbers would eventually disagree, and the
 * failure would be a dashboard that says one thing and a refusal that says
 * another. One rate, one source.
 */

/** Currencies a user may choose to read their money in. Mirrors UserPreferencesRecord.defaultFiatCurrency. */
export type DisplayCurrency = 'usd' | 'gbp' | 'eur' | 'ngn';

export const DISPLAY_CURRENCIES: DisplayCurrency[] = ['usd', 'gbp', 'eur', 'ngn'];

/**
 * Fallbacks for the currencies that had NO rate anywhere in this codebase.
 *
 * usdToNgnRate() already existed. GBP and EUR did not - there was no
 * USD/GBP or USD/EUR figure in the repo at all, which is precisely why the
 * limit card fell back to printing an unlabelled bare number for foreign-rail
 * users rather than a currency amount.
 *
 * These are placeholders in the same sense DEFAULT_USD_TO_NGN_RATE is a
 * placeholder: they keep the screen coherent, they are conservative, and they
 * are meant to be set. `rateSource` in the response says which one you got, so
 * "nobody configured this" is visible rather than silent.
 */
export const DEFAULT_USD_TO_GBP_RATE = 0.79;
export const DEFAULT_USD_TO_EUR_RATE = 0.92;

function positiveEnvNumber(name: string, fallback: number): { value: number; configured: boolean } {
  const raw = Number(process.env[name]);
  // A zero, a negative or an unparseable value would make every converted
  // amount 0 or Infinity. Refuse the input, not the conversion.
  if (Number.isFinite(raw) && raw > 0) return { value: raw, configured: true };
  return { value: fallback, configured: false };
}

export interface DisplayFxRates {
  /**
   * How many NAIRA one unit of each currency is worth.
   *
   * Naira-per-unit rather than unit-per-naira because every figure being
   * converted is already in naira, so the client does one division and never
   * has to decide which way round a rate points. `ngn: 1` is not filler - it
   * makes the naira case travel the identical code path as every other
   * currency, so the branch that formats naira cannot rot separately.
   */
  ngnPerUnit: Record<DisplayCurrency, number>;
  /**
   * Which of these came from configuration and which are shipped defaults.
   * Surfaced so an operator can tell "the rate is 1500" from "nobody set the
   * rate and 1500 is what the code guessed".
   */
  configured: Record<DisplayCurrency, boolean>;
  /**
   * Always true. Present so a client cannot render one of these figures
   * without the field that tells it to print a `≈` being right there in the
   * object it destructured.
   */
  approximate: true;
  /** The unit every limit is actually enforced in. Not a display concern - a disclosure. */
  enforcementCurrency: 'ngn';
}

export function displayFxRates(): DisplayFxRates {
  const usdToNgn = usdToNgnRate();
  const gbp = positiveEnvNumber('DISPLAY_FX_USD_TO_GBP', DEFAULT_USD_TO_GBP_RATE);
  const eur = positiveEnvNumber('DISPLAY_FX_USD_TO_EUR', DEFAULT_USD_TO_EUR_RATE);

  return {
    ngnPerUnit: {
      ngn: 1,
      usd: usdToNgn,
      // USD -> NGN is the only leg with a real rate, so GBP and EUR are
      // crossed through it rather than given independent naira rates. One
      // number to review instead of three, and the three can never imply an
      // arbitrage that does not exist.
      gbp: usdToNgn / gbp.value,
      eur: usdToNgn / eur.value,
    },
    configured: {
      ngn: true,
      usd: Number.isFinite(Number(process.env.LIMITS_USD_TO_NGN_RATE)) && Number(process.env.LIMITS_USD_TO_NGN_RATE) > 0,
      gbp: gbp.configured,
      eur: eur.configured,
    },
    approximate: true,
    enforcementCurrency: 'ngn',
  };
}

/**
 * A naira figure, in the currency asked for.
 *
 * Returns a NUMBER, not a string. Formatting is the client's job and depends
 * on its locale; rounding here would bake one presentation into the API.
 */
export function convertFromNgn(amountNgn: number, currency: DisplayCurrency, rates = displayFxRates()): number {
  const perUnit = rates.ngnPerUnit[currency];
  if (!Number.isFinite(perUnit) || perUnit <= 0) return amountNgn;
  const amount = Number(amountNgn);
  if (!Number.isFinite(amount)) return 0;
  return amount / perUnit;
}
