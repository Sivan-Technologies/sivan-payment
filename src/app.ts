import Fastify from 'fastify';
import cors from '@fastify/cors';
import rawBody from 'fastify-raw-body';
import crypto from 'node:crypto';
import { env } from './config/env.js';
import { registerRoutes } from './api/routes.js';
import { AppError } from './shared/errors.js';
import { safeUserMessage } from './shared/user-message.js';
import { captureError } from './monitoring/sentry.js';
import { verifyUserJwt } from './auth/jwt.js';
import { checkRateLimit } from './shared/rate-limit.js';
import { getSystemStatus, isUserMutationBlocked, systemStatusMessage } from './system/system-status.service.js';
import { getAdminPlatformSettings, isPlatformMutationBlocked } from './admin/admin-settings.service.js';
import { getActiveRestrictionForUser } from './admin/admin-hardening.service.js';

/** Constant-time admin key comparison, length-guarded so it cannot throw. */
function safeKeyEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function buildApp() {
  const app = Fastify({ logger: { level: env.LOG_LEVEL }, trustProxy: true });

  // Refuse to start a production deployment with admin auth disabled, so a
  // missing env var surfaces as a failed deploy rather than an open admin API.
  if ((env.APP_ENV === 'production' || env.APP_ENV === 'staging') && !env.ADMIN_API_KEY) {
    throw new Error(
      'ADMIN_API_KEY is required in production. Refusing to start with unauthenticated /api/admin routes.'
    );
  }

  /**
   * A TEST-ONLY TRUST OVERRIDE MUST NOT BE ABLE TO REACH ANYWHERE REAL.
   *
   * NGN_TRUST_SANDBOX_BANK_RESOLUTION makes an unverifiable sandbox name match
   * grant Level 1. Fine on a test rig; catastrophic anywhere real naira moves,
   * because it would let anyone type any ten digits and inherit a verified
   * account. Refused at BOOT rather than trusted to a comment: nothing about a
   * wrongly-verified user looks wrong until the money is gone.
   *
   * KEYED ON THE PROVIDER BEING LIVE, NOT ONLY ON A LABEL.
   *
   * Two versions of this guard were written independently and both were
   * incomplete, in opposite directions:
   *
   *   APP_ENV only     - api-test runs APP_ENV=staging, verified by curling
   *                      /health/operational and reading `environment: staging`
   *                      back. A production-or-staging check would have
   *                      crash-looped the exact rig the override exists for.
   *                      An APP_ENV=production-only check misses a live BREET
   *                      key deployed under any other label.
   *   provider only    - misses a production deployment whose provider is
   *                      momentarily pointed at a sandbox, which is precisely
   *                      when a stray override would go unnoticed.
   *
   * The hazard is EITHER a live bank resolver OR a production deployment, so
   * both are refused. Neither condition is true on api-test, which is what
   * keeps the override usable where it is meant to be used.
   */
  const ngnRailIsLive = env.BREET_ENV === 'production' || env.PAJ_RAMP_ENV === 'production';
  if ((ngnRailIsLive || env.APP_ENV === 'production') && env.NGN_TRUST_SANDBOX_BANK_RESOLUTION) {
    throw new Error(
      'NGN_TRUST_SANDBOX_BANK_RESOLUTION must not be enabled against a live NGN provider or in production. ' +
        'It makes an unverifiable sandbox bank resolution grant Level 1 verification.'
    );
  }

  await app.register(cors, {
    origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map((item) => item.trim())
  });

  await app.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: false,
    runFirst: true,
    routes: ['/api/webhooks/bridge']
  });

  /**
   * PROVIDER WEBHOOK VERIFICATION PROBES MUST NOT DIE IN THE PARSER.
   *
   * Breet's dashboard POSTs to a webhook URL when you save it and requires a
   * 200. Fastify was rejecting that probe before any route handler ran:
   *
   *   Content-Type: application/json + zero-length body -> 400 "Body cannot be empty"
   *   no Content-Type header                            -> 415 Unsupported Media Type
   *   Content-Type: application/x-www-form-urlencoded   -> 415 Unsupported Media Type
   *
   * Each is a 4xx, so the dashboard reported "Webhook URL must acknowledge the
   * verification request with a 200 response" and refused to save the URL. No
   * handler logic could fix it, because the handler was never reached.
   *
   * These two parsers make an empty or unusual body survive as far as the
   * route, which then decides what it is. A real webhook still arrives as a
   * parsed object and every secret check is untouched - this changes what can
   * be RECEIVED, never what is TRUSTED.
   */
  // removeContentTypeParser first: Fastify ships a JSON parser and refuses a
  // duplicate with FST_ERR_CTP_ALREADY_PRESENT, which fails the boot rather
  // than silently doing the wrong thing. Good behaviour on its part.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body: string, done) => {
    if (!body || !body.trim()) return done(null, {});
    try { done(null, JSON.parse(body)); } catch (error) { done(error as Error, undefined); }
  });

  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body: string, done) => {
    if (!body || !body.trim()) return done(null, {});
    try { done(null, JSON.parse(body)); } catch { done(null, {}); }
  });

  app.addHook('preHandler', async (request, reply) => {
    if (isFastHealthRequest(request.method, request.url)) return;
    const body = request.body as Record<string, unknown> | undefined;
    const decision = checkRateLimit({
      ip: request.ip,
      method: request.method,
      url: request.url,
      email: typeof body?.email === 'string' ? body.email : undefined
    });

    if (!decision) return;

    reply.header('X-RateLimit-Limit', String(decision.limit));
    reply.header('X-RateLimit-Remaining', String(decision.remaining));
    reply.header('X-RateLimit-Reset', String(Math.ceil(decision.resetAt / 1000)));

    if (!decision.allowed) {
      const requestOrigin = request.headers.origin;
      const allowedOrigins = env.CORS_ORIGIN === '*' ? ['*'] : env.CORS_ORIGIN.split(',').map((item) => item.trim()).filter(Boolean);
      if (typeof requestOrigin === 'string' && (allowedOrigins.includes('*') || allowedOrigins.includes(requestOrigin))) {
        reply.header('Access-Control-Allow-Origin', allowedOrigins.includes('*') ? requestOrigin : requestOrigin);
        reply.header('Vary', 'Origin');
      }
      reply.header('Retry-After', String(decision.retryAfterSeconds));
      return reply.code(429).send({
        error: {
          code: 'rate_limited',
          message: 'Too many requests. Please try again later.',
          retryAfterSeconds: decision.retryAfterSeconds
        }
      });
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    if (isFastHealthRequest(request.method, request.url)) return;
    // Provider webhooks bypass the platform-status reads. See isProviderWebhook.
    if (isProviderWebhook(request.method, request.url)) return;
    const status = await getSystemStatus();
    if (isUserMutationBlocked(status.mode, request.method, request.url)) {
      return reply.code(503).send({
        error: {
          code: 'system_unavailable',
          mode: status.mode,
          message: systemStatusMessage(status),
          estimatedResumeAt: status.estimatedResumeAt
        }
      });
    }

    const platformSettings = await getAdminPlatformSettings();
    const platformBlockedMessage = isPlatformMutationBlocked(platformSettings, request.method, request.url);
    if (platformBlockedMessage) {
      return reply.code(503).send({
        error: {
          code: 'platform_action_disabled',
          message: platformBlockedMessage
        }
      });
    }

    const targetUserId = getTargetUserId(request);
    const restrictionAction = restrictedActionForRequest(request.method, request.url);
    if (targetUserId && restrictionAction) {
      const restriction = await getActiveRestrictionForUser(targetUserId, restrictionAction);
      if (restriction) {
        return reply.code(403).send({
          error: {
            code: 'account_restricted',
            message: 'This account is restricted for the requested action. Contact Sivan Support.',
            restriction: { type: (restriction.metadata as any)?.restrictionType, reason: (restriction.metadata as any)?.reason }
          }
        });
      }
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    if (!env.AUTH_REQUIRE_USER || !requiresUserAuth(request.method, request.url)) return;
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token) {
      return reply.code(401).send({ error: { code: 'auth_required', message: 'Authentication required' } });
    }
    try {
      const payload = verifyUserJwt(token);
      const targetUserId = getTargetUserId(request);
      if (targetUserId && targetUserId !== payload.sub) {
        return reply.code(403).send({ error: { code: 'forbidden', message: 'You cannot access another user account' } });
      }
      (request as any).authUser = payload;
    } catch {
      return reply.code(401).send({ error: { code: 'invalid_token', message: 'Invalid or expired token' } });
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/admin')) return;

    // FAIL CLOSED. Previously this returned early when ADMIN_API_KEY was unset,
    // which silently exposed every /api/admin/* route - reads AND writes - to
    // anonymous callers on any deployment where the variable was missing.
    // An unconfigured admin key is a misconfiguration, never a reason to skip auth.
    if (!env.ADMIN_API_KEY) {
      request.log.error('ADMIN_API_KEY is not configured; refusing all admin requests');
      return reply.code(503).send({
        error: {
          code: 'admin_auth_not_configured',
          message: 'Admin authentication is not configured on this server. Set ADMIN_API_KEY.',
        },
      });
    }

    const providedKey = request.headers['x-admin-api-key'] || request.headers['x-admin-key'];
    const adminKey = Array.isArray(providedKey) ? providedKey[0] : providedKey;
    if (!adminKey || !safeKeyEquals(adminKey, env.ADMIN_API_KEY)) {
      return reply.code(401).send({ error: { code: 'admin_auth_required', message: 'Admin API key is required' } });
    }

    const roleHeader = request.headers['x-sivan-admin-role'];
    const emailHeader = request.headers['x-sivan-admin-email'];
    const role = (Array.isArray(roleHeader) ? roleHeader[0] : roleHeader)?.toLowerCase();
    const email = Array.isArray(emailHeader) ? emailHeader[0] : emailHeader;
    if (role && !isAdminRouteAllowed(request.method, request.url, role)) {
      return reply.code(403).send({ error: { code: 'admin_forbidden', message: `Admin role ${role} cannot perform this action` } });
    }
    (request as any).adminActor = { role: role || 'admin_api_key', email: email || undefined };
  });

  /**
   * THE LAST PLACE A LEAK CAN BE STOPPED.
   *
   * A user on production was shown "Bank verification is unavailable right now
   * (provider: breet). Breet: failed to validate bank account." - our supply
   * chain, an outage claim that was false, and nothing they could act on.
   *
   * That specific message is fixed at its source. This is the net underneath:
   * every error leaving the API is swept for provider names and internals
   * before it is serialised, so the NEXT one nobody thought about is caught
   * too. The raw message still reaches the log and Sentry, which is where an
   * engineer needs it.
   *
   * Deliberately applied to the message only, never to `code` - clients switch
   * on the code, and rewriting it would break the frontend's own handling.
   */
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        captureError(error, { requestId: request.id, url: request.url, method: request.method, code: error.code, details: error.details });
      }
      request.log.warn({ error: error.message, code: error.code, details: error.details });
      const safe = safeUserMessage(error.message, error.statusCode);
      if (safe !== error.message) {
        request.log.error({ raw: error.message, url: request.url }, 'error message leaked internals and was rewritten');
      }
      return reply.code(error.statusCode).send({ error: { code: error.code, message: safe, details: error.details } });
    }

    const err = error as Error & { statusCode?: number };
    const statusCode = err.statusCode ?? 500;
    captureError(err, { requestId: request.id, url: request.url, method: request.method });
    request.log.error(err);
    return reply.code(statusCode).send({
      error: {
        code: statusCode === 500 ? 'internal_server_error' : 'request_error',
        message: statusCode === 500 ? 'Internal server error' : safeUserMessage(err.message, statusCode)
      }
    });
  });

  await registerRoutes(app);
  return app;
}


function isFastHealthRequest(method: string, url: string): boolean {
  const path = url.split('?')[0];
  return ['GET', 'HEAD'].includes(method) && ['/', '/ping', '/health', '/health/db', '/health/operational'].includes(path);
}

/**
 * Inbound provider webhooks, which skip the platform-status preHandlers.
 *
 * MEASURED, not assumed: a rejected Breet webhook took ~6s while /health took
 * 0.11s. The cost is getSystemStatus() plus getAdminPlatformSettings(), both of
 * which read the database on every non-health request - before the webhook's
 * own secret is even checked.
 *
 * Wrong on three counts:
 *
 *   1. A FORGED request must cost nothing. Two database reads before rejecting
 *      an unauthenticated caller is a free denial-of-service.
 *
 *   2. Breet retries any non-2xx with backoff for 24 hours, then marks the
 *      event permanently failed. The Cloudflare worker times out at 12s, so a
 *      6s handler plus one retry exceeds it, and a webhook the API handled
 *      correctly gets recorded as a failure.
 *
 *   3. Those checks do not apply here anyway. They gate USER mutations behind
 *      maintenance mode and platform switches. A provider reporting that a
 *      transaction settled is not a user action, and dropping it during
 *      maintenance loses money rather than protecting it.
 *
 * Authentication is NOT skipped. Each provider's verifyWebhook still compares
 * its secret in constant time, and Breet's re-fetches the transaction from
 * Breet before anything is credited.
 */
function isProviderWebhook(_method: string, url: string): boolean {
  const path = url.split('?')[0];

  // The method is deliberately NOT checked.
  //
  // This guard first read `method === 'POST'`, which left the hole it was
  // written to close. A GET on a webhook path matches no route, but it still
  // ran getSystemStatus() and getAdminPlatformSettings() before Fastify could
  // 404 it: measured at ~5.8s against the deployed test service, versus 4ms
  // for the POST fast path. Past the worker's 12s ceiling that surfaced as a
  // 503.
  //
  // Anything aimed at a webhook path is provider traffic or noise. Neither
  // deserves two database reads, and the 404 is the same either way.
  return path.startsWith('/api/webhooks/') || path.startsWith('/webhooks/');
}

function restrictedActionForRequest(method: string, url: string): 'onramp' | 'offramp' | 'kyc' | undefined {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return undefined;
  if (url === '/api/customers' || url === '/api/customers/kyc-link') return 'kyc';
  if (url.startsWith('/api/external-accounts') || url === '/api/withdrawals') return 'offramp';
  if (url === '/api/onramp/orders') return 'onramp';
  if (url.startsWith('/api/ngn/onramp')) return 'onramp';
  if (url.startsWith('/api/ngn/offramp')) return 'offramp';
  if (url.includes('/balance/transfers')) return 'onramp';
  if (url.includes('/suppliers') || url.includes('/supplier-payments')) return 'offramp';
  return undefined;
}

function requiresUserAuth(method: string, url: string): boolean {
  if (url.startsWith('/api/admin')) return false;
  if (url.startsWith('/api/auth')) return false;
  if (url.startsWith('/api/identity/link-whatsapp/redeem')) return false;
  if (url.startsWith('/api/ace/whatsapp/support')) return false;
  if (method === 'POST' && url === '/api/users') return false;

  if (url === '/api/customers') return true;

  const protectedPatterns = [
    /^\/api\/customers\//,
    /^\/api\/customers\/kyc-link/,
    /^\/api\/external-accounts/,
    /^\/api\/withdrawals/,
    /^\/api\/onramp\/orders/,
    /^\/api\/ngn/,
    /^\/api\/support\/tickets/,
    /^\/api\/users\/me\/identity/,
    /^\/api\/support\/attachments/,
    /^\/api\/users\/[^/]+\/onramp-orders/,
    /^\/api\/users\/[^/]+\/ngn-transfers/,
    /^\/api\/users\/[^/]+\/support\/tickets/,
    /^\/api\/users\/[^/]+\/preferences/,
    /^\/api\/users\/[^/]+\/username/,
    // Without this, PUT /api/users/:id/country is unauthenticated and anyone
    // can flip any user from the Bridge path to the Nigerian one.
    /^\/api\/users\/[^/]+\/country/,
    /^\/api\/users\/[^/]+\/name/,
    /^\/api\/users\/[^/]+\/verification-plan/,
    /^\/api\/users\/[^/]+\/verification-summary/,
    /^\/api\/users\/[^/]+\/avatar/,
    /^\/api\/users\/[^/]+\/2fa/,
    /^\/api\/users\/[^/]+\/balance/,
    /^\/api\/users\/[^/]+\/suppliers/,
    /^\/api\/users\/[^/]+\/supplier-payments/,
    /^\/api\/users\/[^/]+\/virtual-accounts/,
    /^\/api\/users\/[^/]+\/legal-acceptances/,
    /^\/api\/users\/[^/]+\/external-accounts/,
    /^\/api\/users\/[^/]+\/withdrawals/,
    /^\/api\/users\/[^/]+\/deposit-addresses/,
    /^\/api\/users\/[^/]+\/wallets/,
    /^\/api\/deposit-addresses\//
  ];
  return protectedPatterns.some((pattern) => pattern.test(url));
}


type AdminRole = 'superadmin' | 'owner' | 'ops' | 'operator' | 'compliance' | 'finance' | 'support' | 'engineering' | 'auditor' | 'guest' | 'escrow';

function isAdminRouteAllowed(method: string, rawUrl: string, rawRole: string): boolean {
  const role = rawRole as AdminRole;
  const url = rawUrl.split('?')[0];
  if (['superadmin', 'owner'].includes(role)) return true;
  if (role === 'escrow') return false;

  const readOnly = method === 'GET';
  if (role === 'guest') return readOnly && !url.startsWith('/api/admin/exports');
  if (role === 'auditor') return readOnly && (url.includes('/audit') || url.includes('/legal') || url.includes('/reconciliation') || url.includes('/webhooks') || url.includes('/users') || url.includes('/withdrawals') || url.includes('/onramp'));

  if (readOnly) return true;

  if (url.startsWith('/api/admin/notes')) return ['ops', 'operator', 'compliance', 'finance', 'support', 'engineering'].includes(role);
  if (url.startsWith('/api/admin/users') && url.includes('/account-controls')) return ['support', 'ops', 'operator', 'compliance', 'engineering'].includes(role);
  if (url.startsWith('/api/admin/support')) return ['support', 'ops', 'operator', 'compliance'].includes(role);
  if (url.startsWith('/api/admin/risk')) return ['compliance', 'ops', 'operator'].includes(role);
  if (url.startsWith('/api/admin/supplier')) return ['ops', 'operator', 'compliance', 'finance'].includes(role);
  if (url.startsWith('/api/admin/fees')) return ['finance'].includes(role);
  if (url.startsWith('/api/admin/limits')) return ['ops', 'operator', 'finance'].includes(role);
  if (url.startsWith('/api/admin/settings/platform') || url.startsWith('/api/admin/offramp/controls') || url.startsWith('/api/admin/system/status') || url.startsWith('/api/admin/system/incidents')) return ['ops', 'operator'].includes(role);
  if (url.startsWith('/api/admin/settings/team') || url.startsWith('/api/admin/settings/api-keys')) return ['ops', 'operator'].includes(role);
  if (url.startsWith('/api/admin/virtual-account')) return ['ops', 'operator', 'compliance', 'finance'].includes(role);
  if (url.startsWith('/api/admin/ngn')) return ['ops', 'operator', 'compliance', 'finance', 'engineering'].includes(role);
  if (url.startsWith('/api/admin/approvals')) return ['ops', 'operator', 'compliance', 'finance', 'engineering'].includes(role);
  if (url.includes('/sync') || url.includes('/reconciliation') || url.includes('/webhooks')) return ['ops', 'operator', 'engineering'].includes(role);
  if (url.startsWith('/api/admin/customers') && url.includes('/kyc-status')) return ['ops', 'operator', 'compliance'].includes(role);

  return false;
}

function getTargetUserId(request: any): string | undefined {
  const params = request.params as Record<string, string> | undefined;
  const body = request.body as Record<string, unknown> | undefined;
  return params?.userId || (typeof body?.userId === 'string' ? body.userId : undefined);
}
