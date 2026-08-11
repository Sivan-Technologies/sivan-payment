import type { DisplayFx } from './types';

/**
 * ONE MONEY FORMATTER, AND IT READS THE USER'S PREFERENCE.
 *
 * THE BUG THIS FIXES. Settings > Preferences has had a "Default fiat currency"
 * select for months. Switching it to USD wrote `defaultFiatCurrency: 'usd'` to
 * the database and changed NOTHING on screen, because no code anywhere read
 * the field back - grep for it across src/ and frontend/src/ and you find the
 * save path, the type, and nothing else. The dashboard kept printing naira.
 *
 * It printed naira because the decision was made by COUNTRY, not preference:
 *
 *   dashboardKpis.showsNairaLimit()   summary.path === 'ngn_bank'
 *   AppSections.tsx:862               allowance.rail === 'foreign' ? bare : '₦'
 *   AppSections.tsx:755               hardcoded '₦' in the headroom sentence
 *   NgnPayoutForm.tsx:414             its own private `naira()`
 *
 * Four copies of the rule, none of which knew the preference existed. The
 * `isForeign` branch is the tell: it does not print a currency for a foreign
 * user, it prints a BARE NUMBER - `12,500 left` - because the figure is
 * naira-denominated and the author correctly refused to mislabel it. That is
 * the honest thing to do with no FX rate available. Now there is one.
 *
 * WHAT THIS IS NOT. `convert()` is display arithmetic. It must not be used to
 * price a withdrawal, size a quote, or decide whether an amount is within a
 * limit - those are enforced server-side in naira against the provider's own
 * rate. Anything converted here renders with a `≈` and the caller does not get
 * to opt out: formatApprox() puts it there.
 */

export type DisplayCurrency = 'usd' | 'gbp' | 'eur' | 'ngn';

export const DISPLAY_CURRENCY_SYMBOLS: Record<DisplayCurrency, string> = {
  usd: '$',
  gbp: '£',
  eur: '€',
  ngn: '₦',
};

/**
 * The locale each currency should be grouped and spaced in.
 *
 * Not cosmetic. `en-NG` and `en-US` both group in threes, but `de-DE` (used
 * for EUR) groups with dots and would render 1.234,56 - a figure that reads as
 * "1.23" to someone expecting the Anglo format. Naming the locale per currency
 * keeps that decision in one table instead of at each call site.
 */
const LOCALES: Record<DisplayCurrency, string> = {
  usd: 'en-US',
  gbp: 'en-GB',
  eur: 'de-DE',
  ngn: 'en-NG',
};

/**
 * How many decimals to show.
 *
 * Naira is shown whole. A kobo is 1/100 of a naira and is not something a bank
 * transfer settles, so "₦75,352.50" implies a precision the rail does not
 * have - and the NgnPayoutForm comment records exactly this: a payout that
 * "came out as ₦382.5" was a bug. Dollar-family currencies keep 2 where the
 * amount is small enough for cents to matter, and drop to 0 once the figure is
 * large enough that cents are noise on a LIMIT (which is what these are).
 */
function fractionDigits(currency: DisplayCurrency, value: number): number {
  if (currency === 'ngn') return 0;
  return Math.abs(value) >= 1000 ? 0 : 2;
}

export function isDisplayCurrency(value: unknown): value is DisplayCurrency {
  return value === 'usd' || value === 'gbp' || value === 'eur' || value === 'ngn';
}

/**
 * Resolve which currency to render in.
 *
 * PREFERENCE FIRST, THEN THE RAIL. A user who has explicitly chosen USD has
 * answered this question and the answer does not depend on which rail an
 * allowance happens to be measured on. Absent a preference we fall back to the
 * old country-derived behaviour, so a user who has never opened Settings sees
 * exactly what they see today - this change cannot alter the screen for
 * someone who never asked it to.
 */
export function resolveDisplayCurrency(
  preference: string | null | undefined,
  fallbackPath?: 'ngn_bank' | 'bridge_kyc' | null,
): DisplayCurrency {
  if (isDisplayCurrency(preference)) return preference;
  return fallbackPath === 'ngn_bank' ? 'ngn' : 'usd';
}

/**
 * Whether a figure will actually be converted, or is already in this currency.
 *
 * Callers need this to decide whether the `≈` and the "approximate" footnote
 * are warranted: a naira user reading a naira limit is seeing the exact
 * enforced number and telling them it is approximate would be a lie in the
 * other direction.
 */
export function isConverted(currency: DisplayCurrency): boolean {
  return currency !== 'ngn';
}

/** A naira figure in `currency`. Returns the input unchanged when no rate is available. */
export function convertFromNgn(amountNgn: number, currency: DisplayCurrency, fx?: DisplayFx | null): number {
  const amount = Number(amountNgn);
  if (!Number.isFinite(amount)) return 0;
  if (currency === 'ngn') return amount;
  const perUnit = fx?.ngnPerUnit?.[currency];
  // NO RATE MEANS NO CONVERSION, NOT A GUESS. An older backend sends no
  // displayFx at all; inventing a rate here would put a wrong number on a
  // limit card with no way for anyone to tell.
  if (!Number.isFinite(perUnit as number) || (perUnit as number) <= 0) return amount;
  return amount / (perUnit as number);
}

/** Symbol + grouped digits, no conversion. The value must already be in `currency`. */
export function formatMoney(value: number, currency: DisplayCurrency): string {
  const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
  const digits = fractionDigits(currency, amount);
  return `${DISPLAY_CURRENCY_SYMBOLS[currency]}${amount.toLocaleString(LOCALES[currency], {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

/**
 * THE ONE CALLERS SHOULD USE for a naira-denominated figure.
 *
 * Converts, formats, and prefixes `≈` when - and only when - the number went
 * through a rate. The prefix is not optional and not a caller's choice: a
 * converted limit that renders as a flat "$120" is a promise the system cannot
 * keep, because the money is enforced in naira at a rate that is not this one.
 *
 * When `fx` is missing the figure is still naira, so it is exact, so it gets
 * no `≈` - handled by falling back to 'ngn' rather than by a special case.
 */
export function formatFromNgn(amountNgn: number, currency: DisplayCurrency, fx?: DisplayFx | null): string {
  const hasRate = currency === 'ngn' || Number(fx?.ngnPerUnit?.[currency]) > 0;
  const effective: DisplayCurrency = hasRate ? currency : 'ngn';
  const value = convertFromNgn(amountNgn, effective, fx);
  const formatted = formatMoney(value, effective);
  return isConverted(effective) ? `≈${formatted}` : formatted;
}

/**
 * The sentence that has to appear anywhere a converted figure is shown.
 *
 * Returns null for naira, so a Nigerian is not told their exact naira limit is
 * an estimate. Centralised so the disclosure cannot drift out of sync with the
 * `≈` that formatFromNgn adds - they are two halves of the same statement.
 */
export function approximateNote(currency: DisplayCurrency, fx?: DisplayFx | null): string | null {
  if (!isConverted(currency)) return null;
  if (!(Number(fx?.ngnPerUnit?.[currency]) > 0)) return null;
  return `Limits are set and enforced in naira. ${DISPLAY_CURRENCY_SYMBOLS[currency]} amounts are approximate.`;
}
