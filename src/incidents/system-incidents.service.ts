import { z } from 'zod';
import { db } from '../database/json-database.js';
import type { SystemIncidentRecord } from '../database/types.js';
import { createAuditLog } from '../audit/audit.service.js';
import { badRequest, notFound } from '../shared/errors.js';
import { id, nowIso } from '../shared/id.js';

export const incidentCreateSchema = z.object({
  provider: z.string().min(1).max(80).default('Sivan'),
  affectedService: z.enum(['withdrawals', 'onramp', 'virtual_accounts', 'webhooks', 'all', 'other']).default('all'),
  severity: z.enum(['info', 'warning', 'critical']).default('warning'),
  message: z.string().min(3).max(500),
  startedAt: z.string().datetime().optional(),
  eta: z.string().max(120).optional().nullable(),
  createdBy: z.string().max(80).optional().default('admin_api_key'),
  metadata: z.unknown().optional()
});

export const incidentUpdateSchema = z.object({
  provider: z.string().min(1).max(80).optional(),
  affectedService: z.enum(['withdrawals', 'onramp', 'virtual_accounts', 'webhooks', 'all', 'other']).optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  status: z.enum(['active', 'monitoring', 'resolved']).optional(),
  message: z.string().min(3).max(500).optional(),
  eta: z.string().max(120).optional().nullable(),
  resolutionSummary: z.string().max(500).optional().nullable(),
  actorId: z.string().max(80).optional().default('admin_api_key'),
  metadata: z.unknown().optional()
});

export async function listSystemIncidents(options: { status?: string; provider?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const provider = options.provider?.trim().toLowerCase();
  return (await db.listSystemIncidentRecords())
    .filter((incident) => !options.status || incident.status === options.status)
    .filter((incident) => !provider || incident.provider.toLowerCase().includes(provider))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit)
    .map(enrichIncident);
}

export async function listActiveSystemIncidents() {
  return listSystemIncidents({ status: undefined, limit: 50 }).then((items) => items.filter((item) => item.status !== 'resolved'));
}

export async function createSystemIncident(input: z.infer<typeof incidentCreateSchema>) {
  const now = nowIso();
  const record: SystemIncidentRecord = {
    id: id('inc'),
    provider: input.provider,
    affectedService: input.affectedService,
    severity: input.severity,
    status: 'active',
    message: input.message,
    startedAt: input.startedAt ?? now,
    eta: input.eta || undefined,
    createdBy: input.createdBy,
    metadata: input.metadata,
    createdAt: now,
    updatedAt: now
  };
  await db.upsertSystemIncidentRecord(record);
  await createAuditLog({ actorType: 'admin', actorId: input.createdBy, action: 'system_incident.created', resourceType: 'payments_system_incident', resourceId: record.id, severity: record.severity === 'critical' ? 'error' : 'warning', metadata: record });
  return enrichIncident(record);
}

export async function updateSystemIncident(incidentId: string, input: z.infer<typeof incidentUpdateSchema>) {
  const incidents = await db.listSystemIncidentRecords();
  const current = incidents.find((incident) => incident.id === incidentId);
  if (!current) throw notFound('System incident');
  const now = nowIso();
  const status = input.status ?? current.status;
  if (current.status === 'resolved' && status !== 'resolved') throw badRequest('Resolved incidents cannot be reopened. Create a new incident.');
  const next: SystemIncidentRecord = {
    ...current,
    provider: input.provider ?? current.provider,
    affectedService: input.affectedService ?? current.affectedService,
    severity: input.severity ?? current.severity,
    status,
    message: input.message ?? current.message,
    eta: input.eta === null ? undefined : input.eta ?? current.eta,
    resolvedAt: status === 'resolved' ? (current.resolvedAt ?? now) : current.resolvedAt,
    resolutionSummary: input.resolutionSummary === null ? undefined : input.resolutionSummary ?? current.resolutionSummary,
    resolvedBy: status === 'resolved' ? input.actorId : current.resolvedBy,
    metadata: input.metadata ?? current.metadata,
    updatedAt: now
  };
  await db.upsertSystemIncidentRecord(next);
  await createAuditLog({ actorType: 'admin', actorId: input.actorId, action: status === 'resolved' ? 'system_incident.resolved' : 'system_incident.updated', resourceType: 'payments_system_incident', resourceId: next.id, severity: status === 'resolved' ? 'info' : next.severity === 'critical' ? 'error' : 'warning', metadata: { previous: current, next } });
  return enrichIncident(next);
}

export async function resolveSystemIncident(incidentId: string, input: { actorId?: string; resolutionSummary?: string } = {}) {
  return updateSystemIncident(incidentId, { status: 'resolved', actorId: input.actorId ?? 'admin_api_key', resolutionSummary: input.resolutionSummary });
}

function enrichIncident(incident: SystemIncidentRecord) {
  const end = incident.resolvedAt ? new Date(incident.resolvedAt).getTime() : Date.now();
  const durationMinutes = Math.max(0, Math.round((end - new Date(incident.startedAt).getTime()) / 60000));
  return { ...incident, durationMinutes, customerMessage: formatIncidentCustomerMessage(incident) };
}

function formatIncidentCustomerMessage(incident: SystemIncidentRecord) {
  const prefix = incident.severity === 'critical' ? 'Service disruption' : incident.severity === 'warning' ? 'Service delay' : 'Service notice';
  const eta = incident.eta ? ` ETA: ${incident.eta}.` : '';
  return `${prefix}: ${incident.message}${eta}`;
}
