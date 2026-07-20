import type { FastifyInstance } from 'fastify';
import { parseBody } from '../shared/validation.js';
import { getSystemStatus, updateSystemStatus, updateSystemStatusSchema } from './system-status.service.js';
import { createSystemIncident, incidentCreateSchema, incidentUpdateSchema, listActiveSystemIncidents, listSystemIncidents, resolveSystemIncident, updateSystemIncident } from '../incidents/system-incidents.service.js';

export async function systemStatusRoutes(app: FastifyInstance) {
  app.get('/api/system/status', async () => ({ data: await getSystemStatus() }));
  app.get('/api/system/incidents', async () => ({ data: await listActiveSystemIncidents() }));
  app.get('/api/admin/system/status', async () => ({ data: await getSystemStatus() }));
  app.get('/api/admin/system/incidents', async (request) => {
    const query = (request.query ?? {}) as Record<string, string>;
    return { data: await listSystemIncidents({ status: query.status || undefined, provider: query.provider || undefined, limit: query.limit ? Number(query.limit) : undefined }) };
  });
  app.post('/api/admin/system/incidents', async (request, reply) => {
    const body = parseBody(incidentCreateSchema, request.body);
    return reply.code(201).send({ data: await createSystemIncident(body) });
  });
  app.put('/api/admin/system/incidents/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(incidentUpdateSchema, request.body);
    return { data: await updateSystemIncident(id, body) };
  });
  app.post('/api/admin/system/incidents/:id/resolve', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(incidentUpdateSchema.pick({ actorId: true, resolutionSummary: true }), request.body);
    return { data: await resolveSystemIncident(id, { actorId: body.actorId, resolutionSummary: body.resolutionSummary || undefined }) };
  });
  app.put('/api/admin/system/status', async (request) => {
    const body = parseBody(updateSystemStatusSchema, request.body);
    return { data: await updateSystemStatus(body) };
  });
}
