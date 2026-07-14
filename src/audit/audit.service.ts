import { db } from '../database/json-database.js';
import type { AuditLogRecord } from '../database/types.js';
import { id, nowIso } from '../shared/id.js';

export interface CreateAuditLogInput {
  actorType: AuditLogRecord['actorType'];
  actorId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  severity?: AuditLogRecord['severity'];
  ipAddress?: string;
  userAgent?: string;
  metadata?: unknown;
}

export async function createAuditLog(input: CreateAuditLogInput) {
  const record: AuditLogRecord = {
    id: id('audit'),
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    severity: input.severity ?? 'info',
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    metadata: input.metadata,
    createdAt: nowIso()
  };

  await db.insertAuditLogRecord(record);

  return record;
}

export async function listAuditLogs(limit = 200) {
  const data = await db.read();
  return (data.auditLogs ?? [])
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}
