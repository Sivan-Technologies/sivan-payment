import type { FastifyInstance } from 'fastify';
import { parseBody } from '../shared/validation.js';
import { startEmailAuth, startEmailAuthSchema, verifyEmailAuth, verifyEmailAuthSchema } from './auth.service.js';
import { disableTwoFactor, enableTwoFactor, getRecoveryQuestionCatalog, getTwoFactorRecoveryChallengeQuestions, getTwoFactorStatus, listUserRecoveryQuestions, setRecoveryQuestionsSchema, setUserRecoveryQuestions, startTwoFactorSetup, twoFactorLoginVerifySchema, twoFactorRecoveryQuestionsChallengeSchema, twoFactorVerifySchema, verifyRecoveryQuestionsSchema, verifyTwoFactorLogin, verifyTwoFactorRecoveryQuestions } from './two-factor.service.js';
import { signUserJwt, verifyUserJwt } from './jwt.js';
import { getUser } from '../users/users.service.js';
import { env } from '../config/env.js';

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

  /**
   * KEEP AN ACTIVE SESSION ALIVE.
   *
   * THE SESSION WAS A HARD 60-MINUTE WALL WITH NOTHING BEHIND IT.
   *
   * signUserJwt stamps exp = iat + 60 minutes and there was no way to renew
   * it, so a user was signed out exactly one hour after logging in no matter
   * what they were doing - mid-withdrawal included. Every request after that
   * 401s, and the frontend force-logs-out on any 401, so the session ends
   * abruptly rather than at a safe moment.
   *
   * This is what makes the window SLIDING: an active user's token is reissued,
   * so the hour is measured from their last activity rather than from login.
   * An idle user's token still expires on schedule, which is the property that
   * matters for a payments product on a shared machine.
   *
   * Deliberately NOT a long-lived refresh token. That is a second credential
   * with different revocation rules and a longer blast radius; renewing a
   * still-valid token needs no new secret and cannot outlive the window on its
   * own, because a token that has already expired cannot renew itself.
   */
  app.post('/api/auth/refresh', async (request, reply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token) {
      return reply.code(401).send({ error: { code: 'auth_required', message: 'Authentication required' } });
    }
    try {
      // An EXPIRED token is refused here, by verifyUserJwt. That is the whole
      // security boundary: renewal extends a live session, it does not
      // resurrect a dead one.
      const payload = verifyUserJwt(token);
      const user = await getUser(payload.sub);
      return {
        data: {
          token: signUserJwt({ userId: payload.sub, email: payload.email, roles: payload.roles }),
          expiresInMinutes: env.USER_JWT_EXPIRES_MINUTES,
          user,
        },
      };
    } catch {
      return reply.code(401).send({ error: { code: 'invalid_token', message: 'Invalid or expired token' } });
    }
  });
}
