import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { parseBody } from '../shared/validation.js';
import { forbidden, notFound } from '../shared/errors.js';
import { db } from '../database/json-database.js';
import { verificationPlanFor } from '../kyc/service/verification-path.js';
import { cancelWhatsappLink, getIdentityStatus, redeemIdentityLinkSchema, redeemWhatsappLink, startWhatsappLink, unlinkWhatsappIdentity } from './identity.service.js';

function getAuthUserId(request: any) {
  return request.authUser?.sub as string | undefined;
}

function requireIdentityServiceSecret(request: any) {
  const configured = env.IDENTITY_LINK_SERVICE_SECRET || env.ADMIN_API_KEY;
  if (!configured) throw forbidden('Identity link service secret is not configured.');
  const provided = request.headers['x-sivan-identity-link-secret'] || request.headers['x-admin-api-key'];
  const value = Array.isArray(provided) ? provided[0] : provided;
  if (value !== configured) throw forbidden('Invalid identity link service secret.');
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
}
