import type { FastifyInstance } from 'fastify';
import { parseBody } from '../shared/validation.js';
import { createUser, createUserSchema, getUser } from './users.service.js';
import { getUserPreferences, updateUserPreferences, updateUserPreferencesSchema } from './user-preferences.service.js';

export async function usersRoutes(app: FastifyInstance) {
  app.post('/api/users', async (request, reply) => {
    const body = parseBody(createUserSchema, request.body);
    const user = await createUser(body);
    return reply.code(201).send({ data: user });
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

  app.get('/api/users/:userId', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await getUser(userId) };
  });
}
