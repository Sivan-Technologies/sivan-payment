import Fastify from 'fastify';
import cors from '@fastify/cors';
import rawBody from 'fastify-raw-body';
import { env } from './config/env.js';
import { registerRoutes } from './api/routes.js';
import { AppError } from './shared/errors.js';

export async function buildApp() {
  const app = Fastify({ logger: { level: env.LOG_LEVEL } });

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
    if (!request.url.startsWith('/api/admin')) return;
    if (!env.ADMIN_API_KEY) return;
    const providedKey = request.headers['x-admin-api-key'];
    const adminKey = Array.isArray(providedKey) ? providedKey[0] : providedKey;
    if (adminKey !== env.ADMIN_API_KEY) {
      return reply.code(401).send({ error: { code: 'admin_auth_required', message: 'Admin API key is required' } });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      request.log.warn({ error: error.message, code: error.code, details: error.details });
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
    }

    const err = error as Error & { statusCode?: number };
    const statusCode = err.statusCode ?? 500;
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
