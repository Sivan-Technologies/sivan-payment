import type { FastifyInstance } from 'fastify';
import { parseBody } from '../shared/validation.js';
import { createUser, createUserSchema, getUser } from './users.service.js';
import { getUserPreferences, updateUserPreferences, updateUserPreferencesSchema } from './user-preferences.service.js';
import { confirmAvatarUpload, confirmAvatarUploadSchema, createAvatarUploadUrl, createAvatarUploadUrlSchema, removeAvatar } from './user-avatar.service.js';
import { legalAcceptancePayloadSchema, listUserLegalAcceptances, recordSignupLegalAcceptance } from '../legal/legal-acceptance.service.js';

const createUserWithLegalSchema = createUserSchema.extend({
  legalAcceptance: legalAcceptancePayloadSchema
});

export async function usersRoutes(app: FastifyInstance) {
  app.post('/api/users', async (request, reply) => {
    const body = parseBody(createUserWithLegalSchema, request.body);
    const user = await createUser(body);
    if (user.email) {
      await recordSignupLegalAcceptance({
        userId: user.id,
        email: user.email,
        termsVersion: body.legalAcceptance.termsVersion,
        privacyVersion: body.legalAcceptance.privacyVersion,
        riskDisclosureVersion: body.legalAcceptance.riskDisclosureVersion,
        acceptedAt: new Date().toISOString(),
        ipAddress: request.ip,
        userAgent: request.headers['user-agent']
      });
    }
    return reply.code(201).send({ data: user });
  });


  app.get('/api/users/:userId/legal-acceptances', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await listUserLegalAcceptances(userId) };
  });

  app.get('/api/users/:userId/preferences', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await getUserPreferences(userId) };
  });

  app.put('/api/users/:userId/preferences', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(updateUserPreferencesSchema, request.body);
    return { data: await updateUserPreferences(userId, body) };
  });


  app.post('/api/users/:userId/avatar/upload-url', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(createAvatarUploadUrlSchema, request.body);
    return { data: await createAvatarUploadUrl(userId, body) };
  });

  app.post('/api/users/:userId/avatar/confirm', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(confirmAvatarUploadSchema, request.body);
    return { data: await confirmAvatarUpload(userId, body) };
  });

  app.delete('/api/users/:userId/avatar', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await removeAvatar(userId) };
  });

  app.get('/api/users/:userId', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await getUser(userId) };
  });
}
