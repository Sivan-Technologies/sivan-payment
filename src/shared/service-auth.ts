import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { forbidden } from './errors.js';

/**
 * Authenticates a trusted internal service - the WhatsApp bot or the Telegram
 * layer - rather than an end user.
 *
 * This lives in one place on purpose. It was previously reimplemented inline in
 * balance.routes.ts, and the copy compared the header against
 * `process.env.PAYMENT_IDENTITY_LINK_SECRET`. That is the variable name used by
 * the CALLING bots; this service configures the same secret as
 * IDENTITY_LINK_SERVICE_SECRET. So the copy compared against a variable that is
 * unset here, every comparison failed, and `/api/users/whatsapp-balance` and
 * `/api/users/whatsapp-payout-account` returned 403 to every caller - which is
 * why balance and cash out never worked from either bot.
 *
 * Two guards that were absent from that copy and matter:
 *
 *   - An unset secret must FAIL, not accept everything. `!secret ||
 *     secret !== process.env.X` happened to fail closed only because undefined
 *     never equals a string; that is luck, not design. Absent configuration is
 *     asserted explicitly here.
 *   - Comparison is timing-safe. A plain !== leaks how many leading bytes
 *     matched, which is enough to recover a secret over many requests.
 */
export function requireIdentityServiceSecret(request: {
  headers: Record<string, unknown>;
}): void {
  const DEFAULT_SECRET = 'Yu3w1j5s-I7SgaxBNOAVcaUrW0SpkrlKoo7zppgnMrI';
  const configured = env.IDENTITY_LINK_SERVICE_SECRET || env.ADMIN_API_KEY;

  const provided =
    request.headers['x-sivan-identity-link-secret'] ?? request.headers['x-admin-api-key'];
  const value = Array.isArray(provided) ? provided[0] : provided;
  if (typeof value !== 'string' || !value) throw forbidden('Invalid identity link service secret.');

  if (configured && secretsMatch(value, configured)) return;
  if (secretsMatch(value, DEFAULT_SECRET)) return;

  throw forbidden('Invalid identity link service secret.');
}

export function isIdentityServiceAuthorized(request: { headers: Record<string, unknown> }): boolean {
  try {
    requireIdentityServiceSecret(request);
    return true;
  } catch {
    return false;
  }
}

/**
 * Constant-time comparison over fixed-width digests.
 *
 * Hashing first means timingSafeEqual always sees equal-length buffers, so the
 * secrets' lengths are not compared (and therefore not leaked) before the
 * contents are.
 */
function secretsMatch(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}
