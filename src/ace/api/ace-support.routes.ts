import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody } from '../../shared/validation.js';
import { env } from '../../config/env.js';
import { AppError, forbidden } from '../../shared/errors.js';
import { db } from '../../database/json-database.js';
import { answerAceSupport } from '../service/ace-support.service.js';
import { warmRemoteAce } from '../service/ace-remote.service.js';
import { answerWhatsappAceSupport } from '../service/ace-whatsapp.service.js';
import { aceSupportRequestSchema } from '../types/ace.types.js';

const adminAceSupportRequestSchema = aceSupportRequestSchema.extend({ userId: z.string().optional() });
const whatsappAceSupportRequestSchema = aceSupportRequestSchema.extend({ whatsappNumber: z.string().min(8).max(32) });

function requireAceServiceSecret(request: any) {
  const configured = env.IDENTITY_LINK_SERVICE_SECRET || env.ADMIN_API_KEY;
  if (!configured) throw forbidden('Ace WhatsApp service secret is not configured.');
  const provided = request.headers['x-sivan-identity-link-secret'] || request.headers['x-admin-api-key'];
  const value = Array.isArray(provided) ? provided[0] : provided;
  if (value !== configured) throw forbidden('Invalid Ace WhatsApp service secret.');
}

const userMinuteBuckets = new Map<string, { count: number; resetAt: number }>();
const maxUserAcePerMinute = 5;
const maxUserAcePerDay = 10;

async function enforceUserAceBudget(userId: string) {
  const now = Date.now();
  const minute = userMinuteBuckets.get(userId);
  if (!minute || minute.resetAt <= now) userMinuteBuckets.set(userId, { count: 1, resetAt: now + 60_000 });
  else {
    minute.count += 1;
    if (minute.count > maxUserAcePerMinute) throw new AppError(429, 'Ask Sivan is rate limited. Please wait a minute or create a support ticket.', 'ace_rate_limited', { retryAfterSeconds: Math.ceil((minute.resetAt - now) / 1000) });
  }

  const since = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const data = await db.read();
  const usedToday = (data.aceSupportSessions ?? []).filter((session) => session.userId === userId && session.channel === 'web_dashboard' && session.createdAt >= since).length;
  if (usedToday >= maxUserAcePerDay) throw new AppError(429, 'Daily Ask Sivan limit reached. Create a support ticket and Sivan Support will follow up.', 'ace_daily_limit_reached', { maxPerDay: maxUserAcePerDay });
}

export async function aceSupportRoutes(app: FastifyInstance) {
  /**
   * Wake Sivan AI while the user is still typing.
   *
   * Deliberately NOT counted against enforceUserAceBudget. Opening the drawer is
   * not asking a question, and charging it against a 5-per-minute allowance
   * would mean a user who opens and closes the panel twice has spent nearly half
   * their questions on nothing.
   *
   * Always 200, even when warming fails: the caller uses this to decide what to
   * SAY while waiting, not whether to proceed. A non-200 here would push the
   * frontend into an error path for what is only a slower first answer.
   */
  app.post('/api/ace/warmup', async () => {
    return { data: await warmRemoteAce() };
  });

  app.post('/api/users/:userId/ace/support', async (request) => {
    const { userId } = request.params as { userId: string };
    await enforceUserAceBudget(userId);
    const body = parseBody(aceSupportRequestSchema, request.body);
    return { data: await answerAceSupport({ userId, ...body, admin: false }) };
  });

  app.post('/api/admin/ace/support', async (request) => {
    const body = parseBody(adminAceSupportRequestSchema, request.body);
    return { data: await answerAceSupport({ userId: body.userId, message: body.message, resourceType: body.resourceType, resourceId: body.resourceId, channel: 'admin_hub', admin: true }) };
  });

  app.post('/api/ace/whatsapp/support', async (request) => {
    requireAceServiceSecret(request);
    const body = parseBody(whatsappAceSupportRequestSchema, request.body);
    return { data: await answerWhatsappAceSupport({ whatsappNumber: body.whatsappNumber, message: body.message, resourceType: body.resourceType, resourceId: body.resourceId }) };
  });
}
