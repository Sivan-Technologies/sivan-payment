/**
 * Guess where a request is coming from, to pre-select a country.
 *
 * WHY THE SERVER AND NOT THE BROWSER
 *
 * The browser cannot see its own egress IP, and navigator.language is a
 * keyboard setting rather than a location - a Nigerian who bought a laptop
 * configured en-US reports the wrong country, every time. The edge already
 * knows: Cloudflare resolves the client IP to a country and forwards it as
 * CF-IPCountry on every request.
 *
 * VPN BEHAVIOUR, WHICH IS THE POINT OF DOING IT THIS WAY
 *
 * Geo-IP resolves the EXIT node. A Nigerian on a US VPN looks American here,
 * and a Briton on a Nigerian VPN looks Nigerian. That cannot be fixed - it is
 * what the network genuinely says - so this is treated as a PRE-SELECTION and
 * never as a fact:
 *
 *   - the value is only ever a default in a picker the user can change
 *   - nothing is written to the user record until they confirm
 *   - the stored country remains DECLARED, and what a user may actually do is
 *     still decided by verified evidence (a resolved NUBAN, a Bridge approval)
 *
 * So a VPN can change which form someone is offered first. It cannot change
 * what they are permitted to do, because the country was never the permission.
 */

/**
 * Headers that carry a country code, in order of trust.
 *
 * CF-IPCountry first: Cloudflare fronts this API, sets it on every request,
 * and - importantly - OVERWRITES any value a client tried to send. The others
 * are fallbacks for other edges and are only read when Cloudflare's is absent.
 */
const COUNTRY_HEADERS = [
  'cf-ipcountry',
  'x-vercel-ip-country',
  'x-appengine-country',
  'fastly-client-country',
  'x-geo-country',
] as const;

/**
 * Values Cloudflare returns that are not countries.
 *
 * 'XX' means unknown, 'T1' means the request came out of the Tor network.
 * Both must resolve to "we do not know" rather than being handed to a picker
 * as though they were places.
 */
const NON_COUNTRIES = new Set(['XX', 'T1', 'A1', 'A2', 'AP', 'EU', 'ZZ']);

export function normalizeCountryHeader(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = String(raw ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(trimmed)) return undefined;
  if (NON_COUNTRIES.has(trimmed)) return undefined;
  return trimmed;
}

/**
 * The country this request appears to come from, or undefined.
 *
 * Undefined is a legitimate and common answer - local development, a stripped
 * proxy, Tor. Callers must render a normal picker in that case rather than
 * guessing, because a wrong default is worse than no default: it is the one a
 * user clicks straight past.
 */
export function detectCountryFromHeaders(
  headers: Record<string, unknown> | undefined
): string | undefined {
  if (!headers) return undefined;
  for (const header of COUNTRY_HEADERS) {
    const detected = normalizeCountryHeader(headers[header]);
    if (detected) return detected;
  }
  return undefined;
}
