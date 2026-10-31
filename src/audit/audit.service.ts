import { db } from '../database/json-database.js';
import type { AuditLogRecord, AuditLogArchiveRecord } from '../database/types.js';
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
  createdAt?: string;
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
    createdAt: input.createdAt ?? nowIso()
  };

  await db.insertAuditLogRecord(record);

  return record;
}

export async function listAuditLogs(limit = 200) {
  if (typeof (db as any).listAuditLogsView === 'function') {
    return (db as any).listAuditLogsView({ limit, offset: 0 });
  }
  if (typeof (db as any).listAuditLogs === 'function') {
    return (db as any).listAuditLogs(limit, 0);
  }
  const data = await db.read();
  return (data.auditLogs ?? [])
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

/**
 * 90-Day Banking Compliance & Dispute Evidence Archival.
 *
 * Automatically migrates audit logs older than retentionDays (standard 90 days)
 * out of the hot payments_audit_logs table into payments_audit_logs_archive.
 * Dispute evidence, transaction trails, and regulatory records remain fully
 * preserved and queryable without degrading hot-path database performance.
 */
export async function archiveExpiredAuditLogs(retentionDays = 90): Promise<{ archivedCount: number; oldestRemainingDate: string | null }> {
  if (typeof (db as any).archiveAuditLogs === 'function') {
    return (db as any).archiveAuditLogs(retentionDays);
  }
  return { archivedCount: 0, oldestRemainingDate: null };
}

export async function listArchivedAuditLogs(options: {
  limit?: number;
  offset?: number;
  action?: string;
  resourceId?: string;
  actorId?: string;
  startDate?: string;
  endDate?: string;
} = {}): Promise<AuditLogArchiveRecord[]> {
  if (typeof (db as any).listArchivedAuditLogsView === 'function') {
    return (db as any).listArchivedAuditLogsView(options);
  }
  return [];
}

export async function getAuditArchiveStatus(): Promise<{
  activeCount: number;
  archiveCount: number;
  oldestActiveDate: string | null;
  oldestArchiveDate: string | null;
}> {
  if (typeof (db as any).getAuditLogStats === 'function') {
    return (db as any).getAuditLogStats();
  }
  return {
    activeCount: 0,
    archiveCount: 0,
    oldestActiveDate: null,
    oldestArchiveDate: null,
  };
}
