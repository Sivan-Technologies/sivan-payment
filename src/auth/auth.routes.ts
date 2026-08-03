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
   * EXTEND A LIVE SESSION INSTEAD OF DROPPING IT.
   *
   * A user reported being signed out "every few minutes". The token is 60
   * minutes, so that reads like an exaggeration - until you look at what
   * happens at minute 60: the JWT is a hard expiry with NO way to renew it.
   * There was no refresh endpoint anywhere in the service. Every session ended
   * by dying mid-use, on whatever screen the user happened to be on, and an
   * active user got exactly the same treatment as an idle one.
   *
   * Worse, the drop was silent until the next request, so the moment it
   * surfaced was usually a click that mattered - and losing a half-filled
   * withdrawal form to "Session expired" feels like being logged out
   * constantly even when the arithmetic says once an hour.
   *
   * This makes the session SLIDING: while you are using Sivan, it keeps
   * renewing. Deliberately NOT a longer fixed token - a 12-hour JWT is worse
   * security for the same complaint, because a stolen token stays valid for 12
   * hours. A sliding 60-minute window means an abandoned session still dies on
   * schedule while an active one never interrupts you.
   *
   * Requires a currently VALID token. An expired one cannot be renewed here -
   * that would make expiry meaningless - so the client must refresh before it
   * lapses, which is what the frontend timer does.
   */
  const refreshSession = async (request: any, reply: any) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token) {
      return reply.code(401).send({ error: { code: 'auth_required', message: 'Authentication required' } });
    }
    try {
      const payload = verifyUserJwt(token);
      // Re-read the user so a deleted or disabled account cannot keep renewing
      // a session forever. A token is a claim about who you were an hour ago.
      const user = await getUser(payload.sub);
      if (!user) {
        return reply.code(401).send({ error: { code: 'invalid_token', message: 'Invalid or expired token' } });
      }
      const refreshed = signUserJwt({ userId: payload.sub, email: payload.email, roles: payload.roles });
      return {
        data: {
          token: refreshed,
          expiresInMinutes: env.USER_JWT_EXPIRES_MINUTES,
          user,
        },
      };
    } catch {
      return reply.code(401).send({ error: { code: 'invalid_token', message: 'Invalid or expired token' } });
    }
  };

  app.post('/api/auth/session/refresh', refreshSession);

  /**
   * Alias for the route above.
   *
   * Two implementations of this endpoint were written concurrently and shipped
   * under different paths - /api/auth/session/refresh and /api/auth/refresh.
   * The logic is identical. Registering both means neither a deployed frontend
   * nor a cached bundle can end up calling a 404 and silently losing its
   * session, which is the exact failure this endpoint exists to prevent.
   */
  app.post('/api/auth/refresh', refreshSession);

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
