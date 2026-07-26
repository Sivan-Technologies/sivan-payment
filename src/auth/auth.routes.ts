import type { FastifyInstance } from 'fastify';
import { parseBody } from '../shared/validation.js';
import { startEmailAuth, startEmailAuthSchema, verifyEmailAuth, verifyEmailAuthSchema } from './auth.service.js';
import { disableTwoFactor, enableTwoFactor, getRecoveryQuestionCatalog, getTwoFactorRecoveryChallengeQuestions, getTwoFactorStatus, listUserRecoveryQuestions, setRecoveryQuestionsSchema, setUserRecoveryQuestions, startTwoFactorSetup, twoFactorLoginVerifySchema, twoFactorRecoveryQuestionsChallengeSchema, twoFactorVerifySchema, verifyRecoveryQuestionsSchema, verifyTwoFactorLogin, verifyTwoFactorRecoveryQuestions } from './two-factor.service.js';
import { verifyUserJwt } from './jwt.js';
import { getUser } from '../users/users.service.js';

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/email/start', async (request) => {
    const body = parseBody(startEmailAuthSchema, request.body);
    return { data: await startEmailAuth(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/auth/email/verify', async (request) => {
    const body = parseBody(verifyEmailAuthSchema, request.body);
    return { data: await verifyEmailAuth(body) };
  });


  app.post('/api/auth/2fa/verify', async (request) => {
    const body = parseBody(twoFactorLoginVerifySchema, request.body);
    return { data: await verifyTwoFactorLogin(body) };
  });

  app.get('/api/auth/2fa/recovery-questions/catalog', async () => {
    return { data: getRecoveryQuestionCatalog() };
  });

  app.post('/api/auth/2fa/recovery-questions/challenge', async (request) => {
    const body = parseBody(twoFactorRecoveryQuestionsChallengeSchema, request.body);
    return { data: await getTwoFactorRecoveryChallengeQuestions(body) };
  });

  app.post('/api/auth/2fa/recovery-questions/verify', async (request) => {
    const body = parseBody(verifyRecoveryQuestionsSchema, request.body);
    return { data: await verifyTwoFactorRecoveryQuestions(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.get('/api/users/:userId/2fa', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await getTwoFactorStatus(userId) };
  });

  app.post('/api/users/:userId/2fa/setup', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await startTwoFactorSetup(userId) };
  });

  app.post('/api/users/:userId/2fa/enable', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(twoFactorVerifySchema, request.body);
    return { data: await enableTwoFactor(userId, body.code) };
  });

  app.post('/api/users/:userId/2fa/disable', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(twoFactorVerifySchema, request.body);
    return { data: await disableTwoFactor(userId, body.code) };
  });

  app.get('/api/users/:userId/2fa/recovery-questions', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await listUserRecoveryQuestions(userId) };
  });

  app.put('/api/users/:userId/2fa/recovery-questions', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(setRecoveryQuestionsSchema, request.body);
    return { data: await setUserRecoveryQuestions(userId, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.get('/api/auth/me', async (request, reply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token) return reply.code(401).send({ error: { code: 'auth_required', message: 'Authentication required' } });
    try {
      const payload = verifyUserJwt(token);
      return { data: { user: await getUser(payload.sub), tokenExpiresAt: new Date(payload.exp * 1000).toISOString() } };
    } catch {
      return reply.code(401).send({ error: { code: 'invalid_token', message: 'Invalid or expired token' } });
    }
  });
}
