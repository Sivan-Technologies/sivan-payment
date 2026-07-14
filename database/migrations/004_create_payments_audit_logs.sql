create table if not exists payments_audit_logs (
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
  created_at timestamptz not null
);

create index if not exists idx_payments_audit_logs_actor on payments_audit_logs(actor_type, actor_id);
create index if not exists idx_payments_audit_logs_action on payments_audit_logs(action);
create index if not exists idx_payments_audit_logs_resource on payments_audit_logs(resource_type, resource_id);
create index if not exists idx_payments_audit_logs_created_at on payments_audit_logs(created_at);
