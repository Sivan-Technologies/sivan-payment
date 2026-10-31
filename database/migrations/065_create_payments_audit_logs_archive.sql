-- Migration 065: Audit Log Archival & Banking Compliance Dispute Evidence Retention
--
-- Banking compliance requires retaining dispute evidence, transaction histories,
-- and operational audit trails for regulatory examination. However, queries
-- against payments_audit_logs on hot paths must remain sub-10ms.
--
-- This migration creates payments_audit_logs_archive to store audit logs older than
-- 90 days. It replicates the schema of payments_audit_logs with an added archived_at
-- timestamp and appropriate indexes for fast administrative & compliance search.

create table if not exists payments_audit_logs_archive (
  id text primary key,
  actor_type text not null,
  actor_id text,
  action text not null,
  resource_type text,
  resource_id text,
  severity text not null default 'info',
  ip_address text,
  user_agent text,
  metadata jsonb,
  created_at timestamptz not null,
  archived_at timestamptz not null default now()
);

create index if not exists idx_payments_audit_logs_archive_created_at
  on payments_audit_logs_archive(created_at desc);

create index if not exists idx_payments_audit_logs_archive_action
  on payments_audit_logs_archive(action, created_at desc);

create index if not exists idx_payments_audit_logs_archive_resource
  on payments_audit_logs_archive(resource_type, resource_id);

create index if not exists idx_payments_audit_logs_archive_user
  on payments_audit_logs_archive(action, ((metadata->>'userId')), created_at asc);
