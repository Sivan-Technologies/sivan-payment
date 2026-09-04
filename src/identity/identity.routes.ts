import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { parseBody } from '../shared/validation.js';
import { forbidden, notFound } from '../shared/errors.js';
import { db } from '../database/json-database.js';
import { requireIdentityServiceSecret, isIdentityServiceAuthorized } from '../shared/service-auth.js';
import { verificationPlanFor } from '../kyc/service/verification-path.js';
import { getVerificationSummary } from '../kyc/service/verification-summary.service.js';
import { detectCountryFromHeaders } from '../kyc/service/geo-country.js';
import { getUnifiedBalance } from '../balances/unified-balance.service.js';
import { id, nowIso } from '../shared/id.js';
import {
  activeLinkForTelegram,
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
import { verifyUserJwt } from '../auth/jwt.js';
import {
  hasWithdrawalPin,
  setWithdrawalPin,
  setWithdrawalPinSchema,
  verifyWithdrawalPin,
  verifyWithdrawalPinSchema,
  verifyTmaPinStepUp,
  evaluatePinRequirement,
} from './withdrawal-pin.service.js';

function getAuthUserId(request: any): string | undefined {
  if (request.authUser?.sub) return request.authUser.sub;
  const header = request.headers?.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (token) {
    try {
      const payload = verifyUserJwt(token);
      return payload.sub;
    } catch {}
  }
  return undefined;
}

/**
 * Resolves a chat identity to the account whose PIN governs it.
 *
 * Shared deliberately by verify-pin and the status check below. If each route
 * resolved identities its own way, the two could disagree about which account
 * a number maps to - and the bot would prompt for one account's PIN while the
 * server checked another's. Every such prompt would fail, and the failure would
 * look like the user mistyping.
 *
 * Returns undefined rather than throwing for an unknown identity, so callers
 * can answer "unknown" and "known but wrong" identically. See the note on
 * account-existence oracles at each call site.
 */
async function resolveChatIdentity(channel: string, identity: string): Promise<string | undefined> {
  if (channel === 'telegram') {
    const result = await lookupTelegramIdentity(identity);
    return result.linked ? result.paymentUserId : undefined;
  }
  if (channel === 'whatsapp') {
    const user = await db.findUserByWhatsappNumber(identity.trim());
    return user?.id;
  }
  // An unrecognised channel resolves to nobody. Falling through to a default
  // lookup here would let a new channel authorise payouts before anyone had
  // decided it should.
  return undefined;
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
  app.get('/api/users/:userId/verification-summary', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const isService = isIdentityServiceAuthorized(request);
    let resolvedUserId = userId;
    if (isService) {
      if (userId.startsWith('+') || /^\d{10,14}$/.test(userId) || userId.startsWith('whatsapp:')) {
        const rawClean = userId.replace(/^whatsapp:\+?/, '').replace(/^\+/, '');
        const user = (await db.findUserByWhatsappNumber(`+${rawClean}`)) || (await db.findUserByWhatsappNumber(`whatsapp:+${rawClean}`)) || (await db.findUserByWhatsappNumber(rawClean));
        if (user) resolvedUserId = user.id;
      }
    } else {
      ensureOwnUser(request, userId);
    }
    const summary = await getVerificationSummary(resolvedUserId);
    if (!summary) return reply.code(404).send({ error: { message: 'User not found' } });
    return { data: summary };
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
    if (!userId) return { data: null };
    return { data: await getIdentityStatus(userId) };
  });

  app.get('/api/users/me/service-agreements', async (request) => {
    const userId = getAuthUserId(request);
    if (!userId) return { data: { linked: false, deals: [] } };

    const user = await db.findUserById(userId);
    const userEmail = (user?.email || '').toLowerCase();
    const handle = userEmail ? userEmail.split('@')[0] : '';
    const aliases = [
      userId,
      user?.email,
      userEmail,
      user?.fullName,
      handle ? `@${handle}` : '',
      handle
    ].filter(Boolean) as string[];

    // 1. Fetch native Service Agreements from database for this user (dual-lookup by ID, email, handle)
    let nativeDeals: any[] = [];
    try {
      const agreements = await (db as any).listServiceAgreementsByUserId(aliases);
      const aliasSet = new Set(aliases.map((a) => a.toLowerCase()));
      nativeDeals = (agreements || []).map((a: any) => {
        const isBuyer = aliasSet.has(String(a.buyerUserId || '').toLowerCase());
        return {
          escrowId: a.id,
          title: a.title,
          role: isBuyer ? 'buyer' : 'seller',
          amount: String(a.amountUsdc),
          currency: a.currency || 'USDC',
          status: (a.status || 'PENDING').toUpperCase(),
          createdAt: a.createdAt,
          network: a.network,
          buyerUserId: a.buyerUserId,
          sellerUserId: a.sellerUserId,
          deadlineDays: a.deadlineDays,
          deliveryDueAt: a.deliveryDueAt,
          fundingTxHash: a.fundingTxHash,
          releaseTxHash: a.releaseTxHash,
          vaultAddress: a.vaultAddress,
        };
      });
    } catch (e) {
      console.warn('[Service Agreements] Native lookup note:', e);
    }

    // 2. Fetch external Telegram / WhatsApp linked deals if linked
    const status = await getIdentityStatus(userId);
    const whatsappNumber = status?.link?.whatsappNumber;
    const isLinked = Boolean(whatsappNumber || status?.channels?.telegram?.linked);

    let externalDeals: any[] = [];
    if (isLinked) {
      const escrowAgentUrl = env.ESCROW_AGENT_URL || 'http://127.0.0.1:4000';
      const coreSecret = process.env.CORE_API_SECRET || 'Yu3w1j5s-I7SgaxBNOAVcaUrW0SpkrlKoo7zppgnMrI';

      let url = `${escrowAgentUrl}/api/users/escrows?limit=50`;
      if (whatsappNumber) {
        url += `&actorWhatsapp=${encodeURIComponent(whatsappNumber)}`;
      }

      try {
        const res = await fetch(url, {
          headers: {
            'x-core-api-key': coreSecret,
          },
        });
        if (res.ok) {
          const json: any = await res.json();
          externalDeals = json.deals || [];
        }
      } catch (err: any) {
        // quiet fallback
      }
    }

    const allDeals = [...nativeDeals, ...externalDeals];
    return {
      data: {
        linked: isLinked || nativeDeals.length > 0,
        deals: allDeals
      }
    };
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

  /**
   * Disconnect this Telegram account from its Sivan identity, from chat.
   *
   * Unlinking already existed for the WEB session (unlink-telegram above, which
   * reads the signed-in user). Chat had no equivalent, so the only way to undo
   * a link made in Telegram was to open the dashboard and sign in - which a
   * user who linked the WRONG account cannot necessarily do, because the point
   * is they are holding the wrong credentials.
   *
   * The Telegram id comes from `message.from.id` on a signed webhook, so the
   * bot knows WHICH account is asking; the service secret proves the caller is
   * the bot. Together those are the same two facts the lookup route above
   * already relies on. It resolves the id to its own user and unlinks only
   * that - an id cannot name another account, so this cannot be turned into a
   * way to unlink someone else.
   *
   * Idempotent by design: unlinking something already unlinked answers
   * `{ linked: false }` rather than failing. A double tap on a Telegram button
   * is normal and must not produce an error.
   *
   * Money is deliberately NOT touched. Unlinking ends the chat channel's access
   * to the account; the funds, the wallets and the web login are untouched and
   * the copy in the bot says so.
   */
  app.post('/api/identity/telegram/:telegramUserId/unlink', async (request) => {
    requireIdentityServiceSecret(request);
    const { telegramUserId } = request.params as { telegramUserId: string };

    const identity = await lookupTelegramIdentity(telegramUserId);
    if (!identity.linked) return { data: { linked: false as const } };

    await unlinkTelegramIdentity(identity.paymentUserId, {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });
    return { data: { linked: false as const, unlinked: true as const } };
  });

  /**
   * Directly link or update the phone number for a Telegram user from chat.
   */
  app.post('/api/identity/telegram/:telegramUserId/phone', async (request, reply) => {
    requireIdentityServiceSecret(request);
    const { telegramUserId } = request.params as { telegramUserId: string };
    const body = (request.body || {}) as any;
    const rawPhone = String(body.phone || body.whatsappNumber || '').trim();
    if (!rawPhone) {
      return reply.code(400).send({ error: 'phone is required' });
    }
    const cleanPhone = rawPhone.replace(/^whatsapp:\+?/, '').replace(/^\+/, '');
    const normalized = `+${cleanPhone}`;
    const cleanId = telegramUserId.trim();

    const link = await activeLinkForTelegram(cleanId);
    let user: any = null;

    if (link) {
      user = await db.findUserById(link.paymentUserId);
    }
    if (!user) {
      user = await db.findUserByTelegramUserId(cleanId);
    }
    if (!user) {
      user = await db.findUserByWhatsappNumber(normalized);
    }

    const fullName = body.fullName || (body.firstName ? `${body.firstName} ${body.lastName || ''}`.trim() : user?.fullName) || 'Sivan User';
    const email = body.email ? String(body.email).trim().toLowerCase() : (user?.email || `${cleanPhone}@sivantech.online`);
    const now = nowIso();

    if (!user) {
      user = await db.findUserByEmail(email);
    }

    if (!user) {
      user = await db.insertUserRecord({
        id: id('usr'),
        email,
        fullName,
        whatsappNumber: normalized,
        telegramUserId: cleanId,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      user = await db.updateUserRecord({
        ...user,
        email,
        fullName: user.fullName || fullName,
        whatsappNumber: normalized,
        telegramUserId: cleanId,
        updatedAt: now,
      });
    }

    const links = await db.listCustomerIdentityLinks();
    const existingLink = links.find((item) => item.paymentUserId === user.id && item.channel === 'telegram')
      || links.find((item) => item.telegramUserId === cleanId);

    await db.upsertCustomerIdentityLinkRecord({
      id: existingLink?.id || id('identity'),
      paymentUserId: user.id,
      email: user.email,
      channel: 'telegram',
      telegramUserId: cleanId,
      whatsappNumber: normalized,
      status: 'linked',
      linkedAt: now,
      createdAt: existingLink?.createdAt || now,
      updatedAt: now,
    }).catch((err) => console.warn('[identity] upsert link warning:', err));

    return {
      data: {
        linked: true as const,
        paymentUserId: user.id,
        whatsappNumber: normalized,
        fullName: user.fullName,
        email: user.email,
        canTransact: true,
      },
    };
  });

  /**
   * Compatibility endpoint for user profile registration.
   */
  app.post('/api/users/profile', async (request, reply) => {
    const body = (request.body || {}) as any;
    const rawPhone = String(body.whatsappNumber || body.phone || '').trim();
    if (!rawPhone) {
      return reply.code(400).send({ error: 'whatsappNumber is required' });
    }
    const cleanPhone = rawPhone.replace(/^whatsapp:\+?/, '').replace(/^\+/, '');
    const normalized = `+${cleanPhone}`;
    const cleanTelegramId = body.telegramId ? String(body.telegramId).trim() : undefined;

    let user = await db.findUserByWhatsappNumber(normalized);
    if (!user) {
      user = await db.findUserByWhatsappNumber(`whatsapp:${normalized}`);
    }
    if (!user && cleanTelegramId) {
      user = await db.findUserByTelegramUserId(cleanTelegramId);
    }

    const email = body.email ? String(body.email).trim().toLowerCase() : (user?.email || `${cleanPhone}@sivantech.online`);
    if (!user) {
      user = await db.findUserByEmail(email);
    }

    const firstName = body.firstName || 'Sivan User';
    const lastName = body.lastName || '';
    const fullName = `${firstName} ${lastName}`.trim();
    const now = nowIso();

    if (!user) {
      user = await db.insertUserRecord({
        id: id('usr'),
        email,
        fullName,
        whatsappNumber: normalized,
        telegramUserId: cleanTelegramId,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      user = await db.updateUserRecord({
        ...user,
        email,
        fullName: user.fullName || fullName,
        whatsappNumber: normalized,
        telegramUserId: cleanTelegramId || user.telegramUserId,
        updatedAt: now,
      });
    }

    if (cleanTelegramId) {
      const links = await db.listCustomerIdentityLinks();
      const existingLink = links.find((item) => item.paymentUserId === user.id && item.channel === 'telegram')
        || links.find((item) => item.telegramUserId === cleanTelegramId);

      await db.upsertCustomerIdentityLinkRecord({
        id: existingLink?.id || id('identity'),
        paymentUserId: user.id,
        email: user.email,
        channel: 'telegram',
        telegramUserId: cleanTelegramId,
        whatsappNumber: normalized,
        status: 'linked',
        linkedAt: now,
        createdAt: existingLink?.createdAt || now,
        updatedAt: now,
      }).catch((err) => console.warn('[identity] upsert link warning:', err));
    }

    return { success: true, user, data: user };
  });

  /**
   * Reset / wipe a test user completely for end-to-end testing.
   */
  app.post('/api/identity/reset-test-user', async (request, reply) => {
    requireIdentityServiceSecret(request);
    const body = (request.body || {}) as any;
    const rawPhone = String(body.phone || body.whatsappNumber || '').trim();
    const cleanPhone = rawPhone.replace(/^whatsapp:\+?/, '').replace(/^\+/, '');
    const cleanTelegramId = String(body.telegramUserId || body.telegramId || '').trim();

    let unlinkedTelegram = false;
    let unlinkedPhone = false;
    let wipedUserId: string | null = null;

    if (cleanTelegramId) {
      const link = await activeLinkForTelegram(cleanTelegramId);
      if (link) {
        await unlinkTelegramIdentity(link.paymentUserId, {
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        });
        unlinkedTelegram = true;
      }
    }

    if (cleanPhone) {
      const withPlus = `+${cleanPhone}`;
      const user = (await db.findUserByWhatsappNumber(withPlus))
        || (await db.findUserByWhatsappNumber(`whatsapp:${withPlus}`))
        || (await db.findUserByWhatsappNumber(cleanPhone))
        || (await db.findUserByEmail(`${cleanPhone}@sivantech.online`));
      if (user) {
        wipedUserId = user.id;
        const links = await db.listCustomerIdentityLinks();
        for (const l of links) {
          if (l.paymentUserId === user.id || l.whatsappNumber === withPlus || l.telegramUserId === cleanTelegramId) {
            await db.upsertCustomerIdentityLinkRecord({ ...l, status: 'unlinked', updatedAt: nowIso() });
          }
        }
        await db.updateUserRecord({
          ...user,
          email: `reset_${user.id}_${Date.now()}@sivantech.online`,
          whatsappNumber: undefined,
          telegramUserId: undefined,
          updatedAt: nowIso(),
        });
        unlinkedPhone = true;
      }
    }

    return {
      data: {
        success: true,
        reset: true,
        unlinkedTelegram,
        unlinkedPhone,
        wipedUserId,
      },
    };
  });


  /**
   * Set or change the withdrawal PIN. WEB ONLY - note there is no service
   * secret here, only a user session.
   *
   * Deliberately unreachable by the bots. If a chat channel could set the PIN,
   * an attacker holding that channel would simply set their own, and the PIN
   * would protect nothing: a second factor that the first factor can mint is
   * not a second factor.
   */
  app.post('/api/users/me/withdrawal-pin', async (request) => {
    const userId = getAuthUserId(request);
    if (!userId) throw forbidden('Sign in to set your withdrawal PIN.');
    const body = parseBody(setWithdrawalPinSchema, request.body);
    return {
      data: await setWithdrawalPin(userId, body, {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      }),
    };
  });

  /**
   * Whether a PIN exists, so the UI can offer "set" rather than "change".
   *
   * Returns only the boolean - never the hash, salt, or attempt counters.
   */
  app.get('/api/users/me/withdrawal-pin', async (request) => {
    const userId = getAuthUserId(request);
    if (!userId) throw forbidden('Sign in to view your withdrawal PIN status.');
    return { data: { hasPin: await hasWithdrawalPin(userId) } };
  });

  /**
   * Exchange a PIN for a step-up token bound to one specific payout.
   *
   * The bot sends the PIN together with the amount, currency and destination
   * it is about to execute, and receives a single-use token tied to exactly
   * those details. The withdrawal endpoint then recomputes the binding from
   * the request that actually arrives, so a token minted for a small transfer
   * to a known account cannot be replayed against a larger one elsewhere.
   *
   * The service secret proves WHICH SERVICE is calling. It must never prove
   * that the account owner agreed - that is what the PIN adds, and why a
   * leaked bot secret alone cannot move money.
   */
  app.post('/api/identity/verify-pin', async (request) => {
    requireIdentityServiceSecret(request);
    const body = parseBody(verifyWithdrawalPinSchema, request.body);
    return {
      data: await verifyWithdrawalPin(
        body,
        // Resolving to undefined rather than throwing lets the service answer
        // an unknown identity and a wrong PIN identically, so this endpoint
        // cannot be used to discover which numbers hold Sivan accounts.
        resolveChatIdentity,
        { ipAddress: request.ip }
      ),
    };
  });

  /**
   * Does the account behind this chat identity have a PIN?
   *
   * The bots need this to choose between prompting for a PIN and sending the
   * user to the web app to create one. They cannot use GET
   * /api/users/me/withdrawal-pin: that route reads a user session, and there is
   * no session in a WhatsApp or Telegram thread.
   *
   * An unknown identity returns `hasPin: false` - the SAME answer as a real
   * account that has not set one. Distinguishing them would turn this into an
   * account-existence oracle: anyone holding the bot secret could ask "is this
   * phone number a Sivan user?" for every number they have. The cost of the
   * merge is small and lands on a path users rarely hit - someone messaging
   * from an unlinked account is told to set up a PIN, follows the link, and
   * discovers there is no account to set one on.
   *
   * Deliberately returns only the boolean. Never the userId: that would leak
   * the mapping this endpoint exists to avoid exposing.
   */
  app.post('/api/identity/withdrawal-pin-status', async (request) => {
    requireIdentityServiceSecret(request);
    const body = parseBody(verifyWithdrawalPinSchema.pick({ channel: true, identity: true }), request.body);
    const userId = await resolveChatIdentity(body.channel, body.identity);
    return { data: { hasPin: userId ? await hasWithdrawalPin(userId) : false } };
  });

  /**
   * Telegram Mini-App (TMA) & Web Keypad Step-Up PIN Verification.
   * Authenticates PIN for high-value transactions ($50+) and returns a single-use step-up token.
   */
  app.post('/api/identity/pin/verify-step-up', async (request, reply) => {
    const { userId, pin, amount, currency, destinationRef, channel } = (request.body || {}) as any;
    if (!userId || !pin || !amount || !currency || !destinationRef) {
      return reply.code(400).send({
        error: { message: 'Missing required parameters (userId, pin, amount, currency, destinationRef)' },
      });
    }

    try {
      const result = await verifyTmaPinStepUp(
        {
          userId: String(userId),
          pin: String(pin),
          amount: String(amount),
          currency: String(currency),
          destinationRef: String(destinationRef),
          channel: channel || 'telegram',
        },
        { ipAddress: request.ip }
      );
      return { data: result };
    } catch (err: any) {
      return reply.code(err.statusCode || 400).send({
        error: {
          message: err.message || 'PIN verification failed',
          code: err.details?.code || 'PIN_VERIFICATION_FAILED',
          details: err.details,
        },
      });
    }
  });

  /**
   * Evaluates the $50 Tiered Risk Threshold for transfers and milestone releases.
   */
  app.post('/api/identity/pin/evaluate-threshold', async (request) => {
    const { amount, currency } = (request.body || {}) as { amount?: number; currency?: string };
    const result = evaluatePinRequirement(Number(amount || 0), currency || 'USDC');
    return { data: result };
  });

  /**
   * Returns system-wide PIN and threshold policies.
   */
  app.get('/api/identity/pin/policy', async () => {
    return {
      data: {
        thresholdUsd: 50.0,
        thresholdNgn: 50000,
        maxFailedAttempts: 5,
        lockoutMinutes: 30,
        stepUpTokenTtlSeconds: 120,
      },
    };
  });

  /**
   * Balance for a chat identity.
   *
   * Telegram should not have to go through a WhatsApp number to read the
   * payment balance. A Telegram-only identity link is already authenticated by
   * Telegram's signed webhook and our service secret; using a phone as the
   * lookup key makes a real linked user look missing whenever the phone field
   * is absent, stale, or from another environment.
   */
  app.post('/api/identity/balance-status', async (request, reply) => {
    requireIdentityServiceSecret(request);
    const rawBody = (request.body || {}) as any;
    const channel = rawBody.channel || (rawBody.telegramUserId ? 'telegram' : 'whatsapp');
    const identity = rawBody.identity || rawBody.telegramUserId || rawBody.whatsappNumber || '';
    if (!identity) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'identity or telegramUserId required' } });
    }
    const userId = await resolveChatIdentity(channel, String(identity));
    if (!userId) return reply.code(404).send({ error: { message: 'Chat identity is not linked to a Sivan Payment account.' } });

    let unified = await getUnifiedBalance(userId);
    const existingChains = (unified.wallets || []).map((w) => w.chain);
    const requiredChains = ['solana', 'base', 'celo', 'stellar', 'bsc'];
    const missingChains = requiredChains.filter((c) => !existingChains.includes(c));

    if (missingChains.length > 0) {
      const { ensureUserWallet } = await import('../wallets/user-wallet.service.js');
      await Promise.all(
        missingChains.map((chain) => ensureUserWallet(userId, chain as any).catch(() => null))
      );
      unified = await getUnifiedBalance(userId);
    }

    const unreadable = unified.balances.length
      ? unified.balances.every((b) => b.chainUnavailable && Number(b.credited) === 0)
      : unified.wallets.length > 0 && unified.wallets.every((w) => w.balancesUnavailable);
    if (unreadable) {
      return reply.code(503).send({
        error: { message: 'Could not reach the network to read this balance. Nothing has changed.' },
      });
    }

    const usdcEntry = unified.balances.find((b) => b.asset === 'usdc') ?? unified.balances[0];
    return {
      data: {
        userId,
        asset: usdcEntry?.asset ?? 'usdc',
        available: Number(usdcEntry?.spendable ?? 0),
        pending: Number(usdcEntry?.pending ?? 0),
        balances: unified.balances.map((b) => ({
          asset: b.asset,
          amount: Number(b.spendable),
          available: Number(b.spendable),
          pending: Number(b.pending),
        })),
        wallets: unified.wallets.map((w) => ({
          chain: w.chain,
          address: w.address,
        })),
      },
    };
  });

  /**
   * Universal recipient target resolver (@username, +phone, or userId) for instant P2P transfers.
   */
  app.get('/api/identity/resolve-target', async (request, reply) => {
    const { target } = request.query as { target?: string };
    if (!target || typeof target !== 'string') {
      return reply.code(400).send({ error: { message: 'Missing target query parameter' } });
    }

    const user = await db.findUserByTarget(target);
    if (!user) {
      return { data: { found: false, target } };
    }

    return {
      data: {
        found: true,
        user: {
          userId: user.id,
          username: user.username,
          displayName: (user as any).name || (user as any).fullName || user.username || (user as any).telegramUsername || user.whatsappNumber || 'Sivan User',
          phone: user.whatsappNumber,
        },
      },
    };
  });

  /**
   * Direct proxy fallback for /api/users/escrows
   */
  app.get('/api/users/escrows', async (request, reply) => {
    const configuredUrl = process.env.ESCROW_AGENT_URL || env.ESCROW_AGENT_URL;
    const isLocalhost = !configuredUrl || configuredUrl.includes('127.0.0.1') || configuredUrl.includes('localhost');
    const primaryUrl = isLocalhost ? 'https://sivan-escrow-agent-test.onrender.com' : configuredUrl;
    const fallbackUrl = 'https://test-sivan.sivantech.online';
    const coreSecret = process.env.CORE_API_SECRET || 'Yu3w1j5s-I7SgaxBNOAVcaUrW0SpkrlKoo7zppgnMrI';
    const query = new URLSearchParams(request.query as Record<string, string>).toString();

    const tryFetch = async (targetBase: string) => {
      const url = `${targetBase.replace(/\/$/, '')}/api/users/escrows${query ? `?${query}` : ''}`;
      const res = await fetch(url, {
        headers: {
          'x-core-api-key': coreSecret,
        },
      });
      if (!res.ok && res.status >= 500) {
        throw new Error(`Upstream returned ${res.status}`);
      }
      return res;
    };

    try {
      const res = await tryFetch(primaryUrl);
      const data = await res.json();
      return reply.code(res.status).send(data);
    } catch (primaryErr: any) {
      try {
        const res = await tryFetch(fallbackUrl);
        const data = await res.json();
        return reply.code(res.status).send(data);
      } catch (fallbackErr: any) {
        return reply.code(502).send({ error: { message: fallbackErr?.message || primaryErr?.message || 'Escrow API unavailable' } });
      }
    }
  });

  /**
   * Direct proxy fallback for /api/users/profile
   */
  app.get('/api/users/profile', async (request, reply) => {
    const configuredUrl = process.env.ESCROW_AGENT_URL || env.ESCROW_AGENT_URL;
    const isLocalhost = !configuredUrl || configuredUrl.includes('127.0.0.1') || configuredUrl.includes('localhost');
    const primaryUrl = isLocalhost ? 'https://sivan-escrow-agent-test.onrender.com' : configuredUrl;
    const fallbackUrl = 'https://test-sivan.sivantech.online';
    const coreSecret = process.env.CORE_API_SECRET || 'Yu3w1j5s-I7SgaxBNOAVcaUrW0SpkrlKoo7zppgnMrI';
    const query = new URLSearchParams(request.query as Record<string, string>).toString();

    const tryFetch = async (targetBase: string) => {
      const url = `${targetBase.replace(/\/$/, '')}/api/users/profile${query ? `?${query}` : ''}`;
      const res = await fetch(url, {
        headers: {
          'x-core-api-key': coreSecret,
        },
      });
      if (!res.ok && res.status >= 500) {
        throw new Error(`Upstream returned ${res.status}`);
      }
      return res;
    };

    try {
      const res = await tryFetch(primaryUrl);
      const data = await res.json();
      return reply.code(res.status).send(data);
    } catch (primaryErr: any) {
      try {
        const res = await tryFetch(fallbackUrl);
        const data = await res.json();
        return reply.code(res.status).send(data);
      } catch (fallbackErr: any) {
        return reply.code(502).send({ error: { message: fallbackErr?.message || primaryErr?.message || 'Escrow API unavailable' } });
      }
    }
  });
}
