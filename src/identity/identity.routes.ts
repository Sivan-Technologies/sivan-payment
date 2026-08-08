import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { parseBody } from '../shared/validation.js';
import { forbidden, notFound } from '../shared/errors.js';
import { db } from '../database/json-database.js';
import { requireIdentityServiceSecret } from '../shared/service-auth.js';
import { verificationPlanFor } from '../kyc/service/verification-path.js';
import { getVerificationSummary } from '../kyc/service/verification-summary.service.js';
import { detectCountryFromHeaders } from '../kyc/service/geo-country.js';
import {
  cancelTelegramLink,
  cancelWhatsappLink,
  getIdentityStatus,
  redeemIdentityLinkSchema,
  lookupTelegramIdentity,
  redeemTelegramLink,
  redeemTelegramLinkSchema,
  redeemWhatsappLink,
  startTelegramLink,
  startWhatsappLink,
  unlinkTelegramIdentity,
  unlinkWhatsappIdentity,
} from './identity.service.js';

function getAuthUserId(request: any) {
  return request.authUser?.sub as string | undefined;
}

/**
 * A user may only read their own plan.
 *
 * app.ts already rejects a token whose subject differs from a :userId in the
 * path, but that guard keys on specific route shapes - so this is asserted
 * here rather than assumed, since the cost of being wrong is one user seeing
 * another's verification state.
 */
function ensureOwnUser(request: any, userId: string) {
  const authUserId = request.authUser?.sub;
  if (authUserId && authUserId !== userId) {
    throw forbidden('You cannot access another user account');
  }
}

export async function identityRoutes(app: FastifyInstance) {
  /**
   * Which verification flow should this user be shown?
   *
   * Served from the backend rather than branched in the UI, so the two cannot
   * disagree. A frontend that decides independently will eventually show a
   * Nigerian form to a US user - a check that cannot possibly succeed for
   * them, with no way to act on the failure.
   */
  app.get('/api/users/:userId/verification-plan', async (request) => {
    const { userId } = request.params as { userId: string };
    ensureOwnUser(request, userId);
    const user = await db.findUserById(userId);
    if (!user) throw notFound('User');
    return { data: verificationPlanFor(user.country) };
  });

  /**
   * The user's verification, as the UI needs to render it.
   *
   * Level, per-check status, and the CURRENT ceilings with headroom - every
   * number resolved through the admin-overridable limit table, never
   * hardcoded. An admin moving a ceiling changes this response immediately.
   */
  app.get('/api/users/:userId/verification-summary', async (request) => {
    const { userId } = request.params as { userId: string };
    ensureOwnUser(request, userId);
    return { data: await getVerificationSummary(userId) };
  });

  /**
   * Which country does this request appear to come from?
   *
   * Used ONLY to pre-select the picker in the verification modal. Public,
   * because it reveals nothing the caller does not already know - it is
   * derived from their own IP and tells them where they are.
   *
   * Deliberately does NOT write anything. A geo guess must not become a stored
   * country without the user confirming it, and on a VPN the guess is the exit
   * node rather than the person.
   */
  app.get('/api/geo/country', async (request) => {
    const country = detectCountryFromHeaders(request.headers as Record<string, unknown>);
    return { data: { country: country ?? null, detected: Boolean(country) } };
  });

  app.get('/api/users/me/identity', async (request) => {
    const userId = getAuthUserId(request);
    if (!userId) throw forbidden('Authentication required.');
    return { data: await getIdentityStatus(userId) };
  });

  app.post('/api/users/me/identity/link-whatsapp/start', async (request) => {
    const userId = getAuthUserId(request);
    if (!userId) throw forbidden('Authentication required.');
    return { data: await startWhatsappLink(userId, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/users/me/identity/link-whatsapp/cancel', async (request) => {
    const userId = getAuthUserId(request);
    if (!userId) throw forbidden('Authentication required.');
    return { data: await cancelWhatsappLink(userId, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/users/me/identity/unlink-whatsapp', async (request) => {
    const userId = getAuthUserId(request);
    if (!userId) throw forbidden('Authentication required.');
    return { data: await unlinkWhatsappIdentity(userId, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/identity/link-whatsapp/redeem', async (request) => {
    requireIdentityServiceSecret(request);
    const body = parseBody(redeemIdentityLinkSchema, request.body);
    return { data: await redeemWhatsappLink(body, { source: 'whatsapp', ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  /**
   * Telegram pairing, mirroring the WhatsApp trio above.
   *
   * Separate routes rather than a `channel` parameter on the existing ones: a
   * caller who could pass the channel could also pass the wrong one, and the
   * service deliberately keeps the two redemption paths apart so a WhatsApp
   * code can never be spent on Telegram. Route shape carries the channel, so
   * the two cannot be confused by a typo in a request body.
   */
  app.post('/api/users/me/identity/link-telegram/start', async (request) => {
    const userId = getAuthUserId(request);
    if (!userId) throw forbidden('Authentication required.');
    return { data: await startTelegramLink(userId, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/users/me/identity/link-telegram/cancel', async (request) => {
    const userId = getAuthUserId(request);
    if (!userId) throw forbidden('Authentication required.');
    return { data: await cancelTelegramLink(userId, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/users/me/identity/unlink-telegram', async (request) => {
    const userId = getAuthUserId(request);
    if (!userId) throw forbidden('Authentication required.');
    return { data: await unlinkTelegramIdentity(userId, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  /**
   * Redeemed by the Telegram bot, never by a browser.
   *
   * `telegramUserId` comes from `message.from.id` on a signed Telegram webhook,
   * which the bot can trust but this endpoint cannot - anyone who reaches it
   * could claim any id. The service secret is therefore what makes the claim
   * credible: it proves the caller IS the bot. Without it a stranger holding a
   * leaked pairing code could bind it to their own Telegram account.
   *
   * app.ts exempts this path from user JWT auth (the bot has no user session)
   * and rate-limits it, because a 6-character code over an endpoint with no
   * attempt limit is brute-forceable.
   */
  app.post('/api/identity/link-telegram/redeem', async (request) => {
    requireIdentityServiceSecret(request);
    const body = parseBody(redeemTelegramLinkSchema, request.body);
    return { data: await redeemTelegramLink(body, { source: 'telegram', ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  /**
   * Resolve a Telegram account to its current Sivan identity.
   *
   * lookupTelegramIdentity has existed since Telegram linking was built, and
   * its own docstring says the Telegram layer "calls this on every action
   * rather than caching" - but no route ever exposed it, so the bot could not.
   * It cached whatever the redeem response happened to contain and never looked
   * again.
   *
   * That cache goes stale in a way users hit constantly: link Telegram first,
   * add WhatsApp second, and the bot holds `phone: null` forever. The account
   * HAS a phone; the bot just never asked again. It then refuses to create
   * agreements with "this account has no phone number on file", which is
   * false, and the web page it sends them to shows the number already there.
   *
   * Returning `linked: false` for an unknown Telegram id is deliberate - not a
   * 404. An unlinked account is a normal state the bot renders as "link your
   * account", not an error, and the two must not be conflated.
   */
  app.get('/api/identity/telegram/:telegramUserId', async (request) => {
    requireIdentityServiceSecret(request);
    const { telegramUserId } = request.params as { telegramUserId: string };
    return { data: await lookupTelegramIdentity(telegramUserId) };
  });
}
