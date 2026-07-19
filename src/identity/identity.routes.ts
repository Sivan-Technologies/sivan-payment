import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { parseBody } from '../shared/validation.js';
import { forbidden } from '../shared/errors.js';
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

export async function identityRoutes(app: FastifyInstance) {
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
