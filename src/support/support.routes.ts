import type { FastifyInstance } from 'fastify';
import { parseBody } from '../shared/validation.js';
import { addSupportTicketMessage, createSupportMessageSchema, createSupportTicket, createSupportTicketSchema, getSupportAnalytics, getSupportTicket, listAdminSupportTickets, listUserSupportTickets, updateSupportTicket, updateSupportTicketSchema } from './support.service.js';

function listOptions(request: any) {
  const query = (request.query ?? {}) as Record<string, string>;
  const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 500);
  const offset = Math.max(Number(query.offset ?? 0), 0);
  return { limit, offset, status: query.status || undefined, priority: query.priority || undefined, type: query.type || undefined, assignedTo: query.assignedTo || undefined, search: query.search || undefined, dateFrom: query.dateFrom || undefined, dateTo: query.dateTo || undefined };
}

export async function supportRoutes(app: FastifyInstance) {
  app.post('/api/support/tickets', async (request, reply) => {
    const body = parseBody(createSupportTicketSchema, request.body);
    const ticket = await createSupportTicket(body);
    return reply.code(201).send({ data: ticket });
  });

  app.get('/api/users/:userId/support/tickets', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await listUserSupportTickets(userId, listOptions(request)) };
  });

  app.get('/api/support/tickets/:id', async (request) => {
    const { id } = request.params as { id: string };
    const authUser = (request as any).authUser;
    return { data: await getSupportTicket(id, { userId: authUser?.sub }) };
  });

  app.post('/api/support/tickets/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parseBody(createSupportMessageSchema, request.body);
    const authUser = (request as any).authUser;
    const message = await addSupportTicketMessage(id, body, { type: 'user', id: authUser?.sub });
    return reply.code(201).send({ data: message });
  });

  app.get('/api/admin/support/tickets', async (request) => ({ data: await listAdminSupportTickets(listOptions(request)) }));
  app.get('/api/admin/support/analytics', async () => ({ data: await getSupportAnalytics() }));

  app.get('/api/admin/support/tickets/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getSupportTicket(id, { admin: true }) };
  });

  app.put('/api/admin/support/tickets/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(updateSupportTicketSchema, request.body);
    return { data: await updateSupportTicket(id, body) };
  });

  app.post('/api/admin/support/tickets/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parseBody(createSupportMessageSchema, request.body);
    const message = await addSupportTicketMessage(id, body, { type: 'admin', id: 'admin_api_key' });
    return reply.code(201).send({ data: message });
  });
}
