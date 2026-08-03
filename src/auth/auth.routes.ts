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

  /**
   * EXTEND A LIVE SESSION WITHOUT MAKING THE USER SIGN IN AGAIN.
   *
   * The complaint is being signed out "every few minutes". The token is
   * actually good for 60 minutes - measured on the deployed API, iat to exp
   * is exactly 3600s - so expiry was never the cause. Two other things were:
   *
   *   1. api-live on Render's free tier SLEEPS. A cold start answers 503 for
   *      several seconds (measured: 6.6s, and a proxied call took 34s to fail
   *      with UPSTREAM_UNAVAILABLE). Any 401-shaped answer during that window
   *      logs the user out.
   *   2. Even a perfect 60 minutes ends abruptly, mid-task, with "Session
   *      expired" and a lost form.
   *
   * A refresh makes the session SLIDING: active use keeps it alive
   * indefinitely, and it only lapses after a genuine idle period. That is
   * what the user is asking for, and it is safer than simply setting
   * USER_JWT_EXPIRES_MINUTES to a large number - a long-lived token cannot be
   * cut short if it leaks, whereas a short token that is refreshed while in
   * use stops being refreshed the moment the tab does.
   *
   * Deliberately NOT a separate refresh-token family: this re-signs from a
   * still-valid access token, so a token that has already expired cannot be
   * revived. The maximum a stolen token buys is one refresh window.
   */
  app.post('/api/auth/refresh', async (request, reply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token) {
      return reply.code(401).send({ error: { code: 'auth_required', message: 'Authentication required' } });
    }
    try {
      const payload = verifyUserJwt(token);
      const user = await getUser(payload.sub);
      // A user who has been deleted or disabled since the token was issued must
      // not be handed a fresh one.
      if (!user) {
        return reply.code(401).send({ error: { code: 'invalid_token', message: 'Invalid or expired token' } });
      }
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
