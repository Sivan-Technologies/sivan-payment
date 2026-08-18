-- Migration 054: Comprehensive Audit Log and Ledger Query Optimization
--
-- Adds composite and expression indexes to payments_audit_logs to ensure
-- sub-10ms query execution across ledger checks, action searches, and timelines.

create index if not exists idx_audit_logs_action_created
  on payments_audit_logs(action, created_at desc);

create index if not exists idx_audit_logs_action_user_created
  on payments_audit_logs(action, ((metadata->>'userId')), created_at asc);

create index if not exists idx_audit_logs_action_resource_created
  on payments_audit_logs(action, resource_id, created_at desc);

create index if not exists idx_audit_logs_actor_created
  on payments_audit_logs(actor_type, actor_id, created_at desc);

create index if not exists idx_audit_logs_created_desc
  on payments_audit_logs(created_at desc);
