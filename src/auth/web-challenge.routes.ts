import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody } from '../shared/validation.js';
import { webChallengeService } from './web-challenge.service.js';
import { isIdentityServiceAuthorized } from '../shared/service-auth.js';
import { forbidden, badRequest } from '../shared/errors.js';

const createChallengeSchema = z.object({
  deviceInfo: z.string().min(1).max(255).optional(),
  location: z.string().max(128).optional(),
});

const authorizeChallengeSchema = z.object({
  challengeId: z.string().min(1).max(64),
  telegramUserId: z.union([z.string(), z.number()]).optional().transform((v) => (v !== undefined ? String(v) : undefined)),
  whatsappNumber: z.string().optional(),
  action: z.enum(['APPROVE', 'DECLINE']),
});

export async function webChallengeRoutes(app: FastifyInstance) {
  /**
   * Browser requests a new QR code challenge to display on /signin.
   */
  app.post('/api/auth/web-challenge/create', async (request) => {
    const body = parseBody(createChallengeSchema, request.body || {});
    const userAgent = request.headers['user-agent'] || 'Unknown Browser';
    const ipAddress = request.ip || '127.0.0.1';

    let deviceInfo = body.deviceInfo;
    if (!deviceInfo) {
      if (userAgent.includes('Macintosh') || userAgent.includes('Mac OS')) {
        deviceInfo = 'macOS Browser';
      } else if (userAgent.includes('Windows')) {
        deviceInfo = 'Windows Browser';
      } else if (userAgent.includes('Android')) {
        deviceInfo = 'Android Device';
      } else if (userAgent.includes('iPhone') || userAgent.includes('iPad')) {
        deviceInfo = 'iOS Device';
      } else {
        deviceInfo = 'Web Browser';
      }
    }

    const data = await webChallengeService.createChallenge({
      deviceInfo,
      ipAddress,
      location: body.location,
    });

    return { success: true, data };
  });

  /**
   * Browser polls every 2-3 seconds while QR code is visible.
   */
  app.get('/api/auth/web-challenge/poll/:id', async (request) => {
    const { id } = request.params as { id: string };
    if (!id || !id.startsWith('wch_')) {
      throw badRequest('Invalid challenge ID.');
    }

    const data = await webChallengeService.pollChallenge(id);
    return { success: true, data };
  });

  /**
   * Bot or universal link fetches challenge details to present to the user.
   */
  app.get('/api/auth/web-challenge/details/:id', async (request) => {
    const { id } = request.params as { id: string };
    if (!id || !id.startsWith('wch_')) {
      throw badRequest('Invalid challenge ID.');
    }

    const data = await webChallengeService.getChallengeDetails(id);
    if (!data) {
      throw badRequest('Challenge not found or expired.');
    }

    return { success: true, data };
  });

  /**
   * Bot (Telegram or WhatsApp) authorizes or declines the challenge.
   * Requires bot service authorization (identity service secret or admin key).
   */
  app.post('/api/auth/web-challenge/authorize', async (request) => {
    if (!isIdentityServiceAuthorized(request)) {
      throw forbidden('Unauthorized bot call.');
    }

    const body = parseBody(authorizeChallengeSchema, request.body);
    const data = await webChallengeService.authorizeChallenge({
      challengeId: body.challengeId,
      telegramUserId: body.telegramUserId,
      whatsappNumber: body.whatsappNumber,
      action: body.action,
    });

    return { success: true, data };
  });
}

