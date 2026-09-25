import Fastify from 'fastify';
import cors from '@fastify/cors';
import rawBody from 'fastify-raw-body';
import crypto from 'node:crypto';
import { env } from './config/env.js';
import { registerRoutes } from './api/routes.js';
import { AppError } from './shared/errors.js';
import { safeUserMessage } from './shared/user-message.js';
import { captureError } from './monitoring/sentry.js';
import { notifyOpsTelegram } from './monitoring/telegram-ops-alert.js';
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

function normalizeAdminAliasUrl(rawUrl = '') {
  if (rawUrl.startsWith('/api/admin/payment/')) {
    return rawUrl.replace(/^\/api\/admin\/payment/, '/api/admin');
  }
  if (rawUrl.startsWith('/api/payment/admin/') || rawUrl === '/api/payment/admin') {
    return rawUrl.replace(/^\/api\/payment\/admin/, '/api/admin');
  }
  if (rawUrl.startsWith('/api/payment/')) {
    return rawUrl.replace(/^\/api\/payment/, '');
  }
  if (!rawUrl.startsWith('/api/admin')) {
    const path = rawUrl.split('?')[0];
    const strippedAdminPrefixes = [
      '/overview', '/users', '/limits', '/withdrawals', '/on-ramp',
      '/finance', '/approvals', '/reconciliation', '/webhooks',
      '/compliance', '/search', '/risk', '/suppliers', '/fees',
      '/virtual-account', '/support', '/audit', '/settings', '/system', '/customers'
    ];
    if (strippedAdminPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      return `/api/admin${rawUrl}`;
    }
  }
  return rawUrl;
}

export async function buildApp() {
  const app = Fastify({
    rewriteUrl: (request) => normalizeAdminAliasUrl(request.url),
    logger: {
      level: env.LOG_LEVEL,
      /**
       * Fastify's default serializers do not log request bodies, so a
       * withdrawal PIN is not written to the log as things stand. This exists
       * so that it stays true.
       *
       * The moment anyone adds `log.info({ body })` while debugging a payout -
       * which is exactly the code path someone debugs - the PIN and the
       * step-up token would land in plain text in the log aggregator, where
       * they are readable by anyone with log access and retained for as long
       * as logs are kept. A second factor that is written down beside the
       * request it authorises is not a second factor.
       */
      redact: {
        paths: [
          'pin',
          'currentPin',
          'stepUpToken',
          'req.body.pin',
          'req.body.currentPin',
          'req.body.stepUpToken',
        ],
        censor: '[redacted]',
      },
    },
    trustProxy: true,
  });


  // Refuse to start a production deployment with admin auth disabled, so a
  // missing env var surfaces as a failed deploy rather than an open admin API.
  if ((env.APP_ENV === 'production' || env.APP_ENV === 'staging') && !env.ADMIN_API_KEY) {
    throw new Error(
      'ADMIN_API_KEY is required in production. Refusing to start with unauthenticated /api/admin routes.'
    );
  }

  /**
   * USER_JWT_SECRET is the master encryption key for every signed user token,
   * two-factor session, recovery code, and identity-linking token across the
   * entire payment service. A production deployment with the default throws at
   * boot rather than signing production tokens with a published constant.
   *
   * The Zod schema already rejects an empty string (z.string().min(1)), but
   * that does not prevent the schema from ACCEPTING the default when
   * USER_JWT_SECRET is literally not set in the environment. This guard blocks
   * the repo-committed fallback explicitly, even when Zod would parse it.
   *
   * The "dev-user-jwt-secret-change-me" literal appears in three places:
   *   1. This check, which refuses it in production/staging.
   *   2. env.ts, where it WAS the schema default until this commit removed it.
   *   3. .env.example, where it documents what the variable looks like.
   *
   * Why the schema default was removed: an UNSET variable now fails the build
   * with "Expected string, received undefined" — loud and early, no process
   * boots. That is strictly safer than a default that appears to work but
   * signs with a known constant. This assertion remains as defense-in-depth:
   * even if an operator manually restores the default or copy-pastes it from
   * the example into production, the service refuses to start.
   */
  if (
    (env.APP_ENV === 'production' || env.APP_ENV === 'staging') &&
    env.USER_JWT_SECRET === 'dev-user-jwt-secret-change-me'
  ) {
    throw new Error(
      'USER_JWT_SECRET must be a strong random value in production, not the example default. ' +
        'This key signs every user session, two-factor recovery code, and identity link.'
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
  /**
   * The custody configuration, refused at BOOT rather than at first use.
   *
   * VIRTUAL_ACCOUNT_PROVIDER and BRIDGE_WALLETS_APPROVED are both enforced
   * lazily by their registries - only when a provider is asked for - so a
   * production deploy with either wrong boots green and fails hours later on
   * one user's request. See production-guards.ts for why each matters.
   *
   * Reads the ACTIVE wallet provider from the database control, not just the
   * env fallback, because that is what actually decides who issues wallets.
   */
  const { assertProductionWalletConfig } = await import('./config/production-guards.js');
  const { resolveActiveWalletProvider } = await import('./wallets/wallet-controls.service.js');
  assertProductionWalletConfig({
    appEnv: env.APP_ENV,
    virtualAccountsEnabled: env.VIRTUAL_ACCOUNTS_ENABLED,
    virtualAccountProvider: process.env.VIRTUAL_ACCOUNT_PROVIDER,
    bridgeWalletsApproved: process.env.BRIDGE_WALLETS_APPROVED,
    activeWalletProvider: await resolveActiveWalletProvider().catch(() => undefined),
  });

  const ngnRailIsLive = env.BREET_ENV === 'production' || env.PAJ_RAMP_ENV === 'production';
  if ((ngnRailIsLive || env.APP_ENV === 'production') && env.NGN_TRUST_SANDBOX_BANK_RESOLUTION) {
    throw new Error(
      'NGN_TRUST_SANDBOX_BANK_RESOLUTION must not be enabled against a live NGN provider or in production. ' +
        'It makes an unverifiable sandbox bank resolution grant Level 1 verification.'
    );
  }

  /**
   * METHODS MUST BE DECLARED, NOT LEFT TO THE DEFAULT.
   *
   * Found by driving the built frontend in a browser against this API:
   *
   *   Access to fetch at '.../api/users/{id}/country' has been blocked by CORS
   *   policy: Method PUT is not allowed by Access-Control-Allow-Methods in
   *   preflight response.
   *
   * @fastify/cors defaults to `GET,HEAD,POST` when `methods` is not given, and
   * nothing here gave it. Every non-simple verb was therefore refused at the
   * preflight - 23 routes, among them PUT /api/users/:userId/country,
   * /username, /name, /preferences, /2fa/recovery-questions and
   * DELETE /api/users/:userId/avatar, plus every admin PUT.
   *
   * WHY NOBODY HIT IT IN PRODUCTION, and why it still had to be fixed: the
   * deployed frontends do not talk to this service directly. Both
   * app.sivantech.online and the test frontend are built against
   * `https://api.sivantech.online/api/payment`, the Cloudflare worker, which
   * answers preflights itself with
   * `GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD` and so masks this entirely.
   * Verified against the live gateway: a real cross-origin PUT returns 401
   * (auth), not a CORS refusal.
   *
   * So this is a latent fault, not a live outage - and exactly the kind that
   * surfaces at the worst moment. Anything that reaches the API without the
   * worker in front of it - a direct VITE_API_BASE_URL, a preview deploy, a
   * partner, the AWS migration that is meant to replace Render, or the worker
   * being bypassed during an incident - loses every settings write with an
   * error the user cannot act on.
   *
   * OPTIONS is included because the preflight itself is an OPTIONS request.
   */
  await app.register(cors, {
    origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map((item) => item.trim()),
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
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
  /**
   * PARSED AS A BUFFER, NOT A STRING. THIS ONE CRASHED PRODUCTION.
   *
   * Sentry, on the live API:
   *
   *   TypeError: The "list[0]" argument must be an instance of Buffer or
   *   Uint8Array. Received type string ('{"api_version":"v0","even...')
   *     at Buffer.concat (node:buffer:626)
   *     at IncomingMessage.onEnd (raw-body/index.js:286)
   *
   * The payload it choked on begins `{"api_version":"v0"` - a BRIDGE WEBHOOK.
   * Reproduced locally: one POST to /api/webhooks/bridge and the whole process
   * exits 1. Not a 500 - the server dies, taking every in-flight request with
   * it, and Render restarts it cold. Bridge sees a dropped connection and
   * retries, so a burst of webhooks is a restart loop.
   *
   * The mechanism, and it is a genuinely subtle interaction:
   *
   *   1. fastify-raw-body is registered with `encoding: false, runFirst: true`
   *      so the webhook route can verify a signature over the EXACT bytes.
   *      runFirst means it reads `request.raw` in preParsing.
   *   2. `encoding: false` makes the plugin register its own
   *      application/json parser with `parseAs: 'buffer'` - deliberately, so
   *      the stream keeps yielding Buffers.
   *   3. These lines then REMOVED that parser and replaced it with
   *      `parseAs: 'string'`.
   *   4. Fastify's string path calls `payload.setEncoding('utf8')`
   *      (content-type-parser.js:250) on the same underlying stream.
   *   5. raw-body, already listening on that stream with no decoder of its
   *      own, now receives STRINGS, pushes them into its array, and calls
   *      Buffer.concat on an array of strings. Throw, inside a stream
   *      callback, unhandled.
   *
   * So the empty-body accommodation below silently broke webhook parsing for
   * every provider. Both requirements are real, so both are kept:
   *
   *   parseAs: 'buffer'  keeps the raw stream in Buffers, so raw-body works
   *                      and signature verification sees the true bytes
   *   the empty check    still answers 200 to a dashboard verification probe
   *
   * Buffer.byteLength(body) rather than body.length is the same distinction
   * one level up: a JSON body with any non-ASCII character has more bytes than
   * characters, and the check must be about presence, not size.
   */
  // removeContentTypeParser first: Fastify ships a JSON parser and refuses a
  // duplicate with FST_ERR_CTP_ALREADY_PRESENT, which fails the boot rather
  // than silently doing the wrong thing. Good behaviour on its part.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body: Buffer, done) => {
    const text = body?.toString('utf8') ?? '';
    if (!text.trim()) return done(null, {});
    try { done(null, JSON.parse(text)); } catch (error) { done(error as Error, undefined); }
  });

  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body: Buffer, done) => {
    const text = body?.toString('utf8') ?? '';
    if (!text.trim()) return done(null, {});
    try { done(null, JSON.parse(text)); } catch { done(null, {}); }
  });

  app.addHook('preHandler', async (request, reply) => {
    if (isFastHealthRequest(request.method, request.url)) return;
    const body = request.body as Record<string, unknown> | undefined;
    const authHeader = request.headers.authorization;
    let tokenUser: string | undefined;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      try {
        const payload = verifyUserJwt(authHeader.slice(7));
        tokenUser = payload?.sub;
      } catch {
        // Ignore decode error for rate limit lookup
      }
    }
    const reqUser = (request as any).user?.id || (request as any).user?.userId || tokenUser || (typeof body?.userId === 'string' ? body.userId : undefined) || (typeof body?.buyerUserId === 'string' ? body.buyerUserId : undefined);

    const decision = checkRateLimit({
      ip: request.ip,
      method: request.method,
      url: request.url,
      email: typeof body?.email === 'string' ? body.email : undefined,
      userId: typeof reqUser === 'string' ? reqUser : undefined
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

    // Service-to-service authentication (Telegram bot, WhatsApp bot, Escrow agent)
    const identitySecret = (request.headers['x-sivan-identity-link-secret'] || request.headers['x-admin-api-key']) as string | undefined;
    const configuredSecret = env.IDENTITY_LINK_SERVICE_SECRET || env.ADMIN_API_KEY;
    if (identitySecret && configuredSecret && identitySecret === configuredSecret) {
      return;
    }

    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token) {
      return reply.code(401).send({ error: { code: 'auth_required', message: 'Authentication required' } });
    }
    try {
      const payload = verifyUserJwt(token);
      const targetUserId = getTargetUserId(request);
      if (targetUserId && targetUserId !== payload.sub) {
        /**
         * 'user_mismatch', NOT the generic 'forbidden'.
         *
         * The client logs a user out when it sees code 'forbidden' on a 403,
         * which is correct for THIS case - the token genuinely does not own
         * the account being addressed. But `forbidden()` in shared/errors.ts
         * hardcodes that same code for every business refusal in the app:
         * "Transfers are currently disabled", "Too many incorrect PIN
         * attempts", "Verify your email before linking WhatsApp".
         *
         * So a user who pressed Send while balance transfers were switched off
         * was signed out, on a refusal that had nothing to do with their
         * session. Reported exactly that way: a 403 on
         * /balance/transfers followed by an immediate logout.
         *
         * Naming this case distinctly lets the client end the session only
         * when the TOKEN is the problem.
         */
        return reply.code(403).send({ error: { code: 'user_mismatch', message: 'You cannot access another user account' } });
      }
      (request as any).authUser = payload;
    } catch {
      return reply.code(401).send({ error: { code: 'invalid_token', message: 'Invalid or expired token' } });
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    const rawUrl = request.raw.url || request.url || '';
    const reqUrl = request.url || '';
    const path = (rawUrl || reqUrl).split('?')[0];

    /**
     * THE UNAUTHENTICATED HEALTH SHORTCUT, MATCHED EXACTLY.
     *
     * This read `url.includes('health')` - a SUBSTRING test over the whole
     * URL, query string included - and it sits above the admin key check
     * below. Two consequences, both proven against production:
     *
     *   /api/admin/ngn/controls           -> 401  (correct)
     *   /api/admin/ngn/controls?q=health  -> 200  (auth skipped entirely)
     *
     * Appending six characters to ANY admin URL bypassed authentication. The
     * blast radius was limited only because this branch returns its own
     * payload and stops - it never served admin data - but that is a property
     * of what happens to sit below it, not a guarantee.
     *
     * The second consequence was the one costing us daily: a real admin route
     * whose PATH contains "health" could never execute. Both of these are
     * registered and were permanently shadowed by this branch:
     *
     *   /api/admin/kyc/ngn/provider-health   (kyc-level.routes.ts:6)
     *   /api/admin/wallets/health            (ngn.routes.ts:601)
     *
     * The first is the endpoint that reports whether Monnify and Flutterwave
     * can actually answer a BVN check. It returned this hardcoded
     * {"status":"ok"} instead, so a dead KYC provider looked healthy and the
     * one diagnostic that would have shown it was swallowed.
     *
     * HOW IT GOT HERE. It was tightened and re-loosened across five commits
     * (2b3681d, 69f6e2f, 37522ed, 4d623ff, 34217bb) that were debugging
     * against a Render deployment serving a stale build. Each attempt looked
     * like it failed, so each widened the match:
     *
     *   path.endsWith('/health') -> url.includes('/health') -> includes('health')
     *
     * The code was never the problem; the deployment was.
     *
     * Now: exact path match, GET/HEAD only, query string discarded. The list
     * is the routes that genuinely must answer without credentials - load
     * balancer and uptime probes - and nothing else. An admin route that
     * happens to contain the word reaches its own handler and its own auth.
     */
    const PUBLIC_HEALTH_PATHS = new Set([
      '/health',
      '/api/admin/health',
      '/api/admin/payment/health',
    ]);
    if (['GET', 'HEAD'].includes(request.method) && PUBLIC_HEALTH_PATHS.has(path)) {
      return reply.code(200).send({ status: 'ok', service: 'sivan-payments-admin', timestamp: new Date().toISOString() });
    }

    const adminPrefixes = [
      '/overview', '/users', '/limits', '/withdrawals', '/on-ramp',
      '/finance', '/approvals', '/reconciliation', '/webhooks',
      '/compliance', '/search', '/risk', '/suppliers', '/fees',
      '/virtual-account', '/support', '/audit', '/settings', '/system', '/customers'
    ];
    const isAdminPath = rawUrl.startsWith('/api/admin') || adminPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
    if (!isAdminPath) return;

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
        notifyOpsTelegram(error, { requestId: request.id, url: request.url, method: request.method });
      }
      request.log.warn({ error: error.message, code: error.code, details: error.details });
      const safe = safeUserMessage(error.message, error.statusCode);
      if (safe !== error.message) {
        request.log.error({ raw: error.message, url: request.url }, 'error message leaked internals and was rewritten');
      }
      return reply.code(error.statusCode).send({ error: { code: error.code, message: safe, details: error.details } });
    }

    const err = error as Error & { statusCode?: number; code?: string; detail?: string; constraint?: string; table?: string; column?: string };
    const statusCode = err.statusCode ?? 500;
    captureError(err, { requestId: request.id, url: request.url, method: request.method });
    if (statusCode >= 500) {
      notifyOpsTelegram(err, { requestId: request.id, url: request.url, method: request.method });
    }

    /**
     * LOG THE 500 EXPLICITLY, WITH THE FIELDS THAT NAME THE CAUSE.
     *
     * `request.log.error(err)` alone was not enough to diagnose the production
     * signup 500, which survived three deploys and several wrong hypotheses -
     * including two of mine. Two reasons it stayed invisible:
     *
     *   1. captureError() returns early when Sentry is not initialised, so on
     *      a deployment without SENTRY_DSN the stack went nowhere at all.
     *   2. Postgres errors carry their meaning in NON-ENUMERABLE fields -
     *      `code`, `detail`, `constraint`, `table`, `column`. A bare
     *      log.error(err) prints the message ("null value in column x") and
     *      drops exactly the fields that say WHICH column and WHICH
     *      constraint.
     *
     * Pulled out by name so the answer is in the Render log even with no
     * error-tracking configured. This is diagnostics, not a behaviour change:
     * the response the caller receives is unchanged.
     */
    request.log.error({
      err,
      url: request.url,
      method: request.method,
      requestId: request.id,
      // Postgres puts the actionable part here, and only here.
      pgCode: err.code,
      pgDetail: err.detail,
      pgConstraint: err.constraint,
      pgTable: err.table,
      pgColumn: err.column,
      stack: err.stack,
    }, 'unhandled error');

    /**
     * A CORRELATION ID THE USER CAN QUOTE.
     *
     * "Internal server error" gives support nothing to search for. The request
     * id is already in every log line for this request, so returning it turns
     * an unreproducible report into a log lookup. It is an opaque id and
     * leaks nothing about the failure.
     */
    return reply.code(statusCode).send({
      error: {
        code: statusCode === 500 ? 'internal_server_error' : 'request_error',
        message: statusCode === 500 ? 'Internal server error' : safeUserMessage(err.message, statusCode),
        requestId: String(request.id)
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
  const path = url.split('?')[0];
  const adminPrefixes = [
    '/overview', '/users', '/limits', '/withdrawals', '/on-ramp',
    '/finance', '/approvals', '/reconciliation', '/webhooks',
    '/compliance', '/search', '/risk', '/suppliers', '/fees',
    '/virtual-account', '/support', '/audit', '/settings', '/system', '/customers'
  ];
  if (adminPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return false;
  if (url.startsWith('/api/auth')) return false;
  if (url.startsWith('/api/identity/link-whatsapp/redeem')) return false;
  if (url.startsWith('/api/identity/link-telegram/redeem')) return false;
  if (url.startsWith('/api/ace/whatsapp/support')) return false;

  /**
   * PIN verification for chat withdrawals. The bot holds a service secret and
   * never a user JWT, so requiring user auth here would reject every call.
   *
   * Exempt from USER auth, NOT unauthenticated: the handler's first statement
   * is requireIdentityServiceSecret, and the PIN itself is what proves the
   * account owner agreed. Scoped to POST on the exact path - a startsWith over
   * all methods would exempt anything later added beneath this prefix.
   */
  if (method === 'POST' && url === '/api/identity/verify-pin') return false;

  /**
   * "Does this chat identity have a PIN?" - read-only, and the bot's way of
   * deciding whether to prompt or to send the user to the web app to create
   * one.
   *
   * POST rather than GET because the identity is a phone number, and phone
   * numbers do not belong in URLs: they land in access logs, proxy logs and
   * error trackers. The body keeps them out of all three.
   *
   * Same exemption reasoning as verify-pin, and the same limit: it reads, it
   * cannot move money, and the handler still demands the service secret.
   */
  if (method === 'POST' && url === '/api/identity/withdrawal-pin-status') return false;
  if (method === 'POST' && url === '/api/identity/balance-status') return false;


  if (method === 'GET' && url.startsWith('/api/identity/telegram/')) return false;

  /**
   * Disconnecting a Telegram account from chat.
   *
   * A WRITE, so it does not belong with the read-only exemptions below and is
   * matched narrowly - the path must both start with the Telegram namespace AND
   * end in /unlink, so this can never widen to cover a future POST under the
   * same prefix.
   *
   * Exempt for the same reason as the lookup: there is no user session in a
   * Telegram thread. The handler demands the service secret, and the Telegram
   * id in the path is the id the webhook signed, so the bot can only unlink the
   * account that asked.
   *
   * Permitted despite the "reads only" rule below because it moves NO money and
   * grants NO access: it REVOKES the chat channel's own reach into an account.
   * The failure mode of getting it wrong is a user who must re-link, not a user
   * whose funds moved.
   */
  if (method === 'POST' && url.startsWith('/api/identity/telegram/') && (url.endsWith('/unlink') || url.endsWith('/phone'))) return false;


  /**
   * Read-only lookups for the chat bots, which hold a service secret and never
   * a user JWT.
   *
   * Exempt from USER auth, NOT unauthenticated: both handlers call
   * requireIdentityServiceSecret as their first statement, so an anonymous
   * caller still gets 403. The exemption only says "do not demand a user token
   * here", because there is no user session in a WhatsApp or Telegram thread to
   * produce one.
   *
   * Kept to reads. Nothing that MOVES money may be exempted this way - the bots'
   * secret authenticates the bot, not the person, and cannot stand in for a
   * user's intent to withdraw. See docs/withdrawal-pin.md.
   */
  if (method === 'GET' && url.startsWith('/api/users/whatsapp-balance')) return false;
  if (url.startsWith('/api/users/whatsapp-payout-account')) return false;
  if (method === 'GET' && url.includes('/verification-summary')) return false;
  if (method === 'GET' && url.startsWith('/api/ngn/quote')) return false;
  if (url.startsWith('/api/ngn/offramp/orders')) return false;
  if (method === 'POST' && (url === '/api/users' || url === '/api/users/profile' || url === '/api/identity/reset-test-user')) return false;

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
    /^\/api\/users\/me\/service-agreements/,
    /**
     * Setting or changing the withdrawal PIN. This is the route that
     * establishes the secret every chat withdrawal is later checked against,
     * so it demands a real user session and must never appear in the
     * exemption list above - a service secret is the bot's identity, not the
     * account owner's, and must not be able to define the owner's PIN.
     *
     * Omitting this pattern does not open the route (the handler reads
     * request.authUser and refuses without it) but it does break it: the
     * hook never populates authUser, so every set-PIN attempt 403s.
     */
    /^\/api\/users\/me\/withdrawal-pin/,
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
    /^\/api\/users\/[^/]+\/kyc\/ngn/,
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
  /**
   * PER-USER LIMITS: deliberately a NARROWER list than account-controls.
   *
   * Without an explicit rule this URL falls through to `return false`, so
   * every non-superadmin would get a 403 and the feature would look broken for
   * exactly the people meant to use it.
   *
   * `support` is excluded on purpose, and that is the whole judgement here.
   * Raising a customer's ceiling - or forgiving volume already moved - is an
   * AML decision, not a customer-service one, and support is the role most
   * exposed to a persuasive caller. They can still SEE the limits, because
   * read-only requests are allowed above and answering "why am I capped"
   * is their job; changing the answer is not.
   *
   * `finance` is included: an off-ramp ceiling that blocks a settlement is
   * routinely theirs to unblock.
   */
  if (url.startsWith('/api/admin/users') && url.includes('/limits')) return ['ops', 'operator', 'compliance', 'finance'].includes(role);
  if (url.startsWith('/api/admin/support')) return ['support', 'ops', 'operator', 'compliance'].includes(role);
  if (url.startsWith('/api/admin/risk')) return ['compliance', 'ops', 'operator'].includes(role);
  if (url.startsWith('/api/admin/supplier')) return ['ops', 'operator', 'compliance', 'finance'].includes(role);
  if (url.startsWith('/api/admin/fees')) return ['finance'].includes(role);
  /**
   * BULK reset is narrower than every other limits control.
   *
   * Forgiving one user's window is routine operations work. Forgiving EVERY
   * user's window at once is a policy act with a compliance consequence, so
   * `finance` - who may legitimately unblock a single stuck settlement - and
   * `operator` are not given the power to clear the entire base in one call.
   * Ordered ABOVE the general /api/admin/limits rule because first match wins.
   */
  if (url.startsWith('/api/admin/limits/reset-all')) return ['ops', 'compliance'].includes(role);
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
