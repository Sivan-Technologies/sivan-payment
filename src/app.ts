import Fastify from 'fastify';
import cors from '@fastify/cors';
import rawBody from 'fastify-raw-body';
import { env } from './config/env.js';
import { registerRoutes } from './api/routes.js';
import { AppError } from './shared/errors.js';
import { captureError } from './monitoring/sentry.js';
import { verifyUserJwt } from './auth/jwt.js';
import { checkRateLimit } from './shared/rate-limit.js';
import { getSystemStatus, isUserMutationBlocked, systemStatusMessage } from './system/system-status.service.js';
import { getAdminPlatformSettings, isPlatformMutationBlocked } from './admin/admin-settings.service.js';
import { getActiveRestrictionForUser } from './admin/admin-hardening.service.js';

export async function buildApp() {
  const app = Fastify({ logger: { level: env.LOG_LEVEL }, trustProxy: true });

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
    if (!env.ADMIN_API_KEY) return;
    const providedKey = request.headers['x-admin-api-key'] || request.headers['x-admin-key'];
    const adminKey = Array.isArray(providedKey) ? providedKey[0] : providedKey;
    if (adminKey !== env.ADMIN_API_KEY) {
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

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        captureError(error, { requestId: request.id, url: request.url, method: request.method, code: error.code, details: error.details });
      }
      request.log.warn({ error: error.message, code: error.code, details: error.details });
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
    }

    const err = error as Error & { statusCode?: number };
    const statusCode = err.statusCode ?? 500;
    captureError(err, { requestId: request.id, url: request.url, method: request.method });
    request.log.error(err);
    return reply.code(statusCode).send({
      error: {
        code: statusCode === 500 ? 'internal_server_error' : 'request_error',
        message: statusCode === 500 ? 'Internal server error' : err.message
      }
    });
  });

  await registerRoutes(app);
  return app;
}


function isFastHealthRequest(method: string, url: string): boolean {
  const path = url.split('?')[0];
  return ['GET', 'HEAD'].includes(method) && ['/', '/ping', '/health', '/health/db'].includes(path);
}

function restrictedActionForRequest(method: string, url: string): 'onramp' | 'offramp' | 'kyc' | undefined {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return undefined;
  if (url === '/api/customers' || url === '/api/customers/kyc-link') return 'kyc';
  if (url.startsWith('/api/external-accounts') || url === '/api/withdrawals') return 'offramp';
  if (url === '/api/onramp/orders') return 'onramp';
  if (url.startsWith('/api/ngn/onramp')) return 'onramp';
  if (url.startsWith('/api/ngn/offramp')) return 'offramp';
  if (url.includes('/balance/transfers')) return 'onramp';
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
    /^\/api\/users\/[^/]+\/balance/,
    /^\/api\/users\/[^/]+\/virtual-accounts/,
    /^\/api\/users\/[^/]+\/legal-acceptances/,
    /^\/api\/users\/[^/]+\/external-accounts/,
    /^\/api\/users\/[^/]+\/withdrawals/,
    /^\/api\/users\/[^/]+\/deposit-addresses/,
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
  if (url.startsWith('/api/admin/support')) return ['support', 'ops', 'operator', 'compliance'].includes(role);
  if (url.startsWith('/api/admin/risk')) return ['compliance'].includes(role);
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
