create table if not exists payments_system_incidents (
  id text primary key,
  provider text not null,
  affected_service text not null,
  severity text not null,
  status text not null,
  message text not null,
  started_at timestamptz not null,
  eta text,
  resolved_at timestamptz,
  resolution_summary text,
  created_by text,
  resolved_by text,
  metadata jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index if not exists idx_payments_system_incidents_status_started on payments_system_incidents(status, started_at desc);
create index if not exists idx_payments_system_incidents_provider_started on payments_system_incidents(provider, started_at desc);
create index if not exists idx_payments_system_incidents_severity on payments_system_incidents(severity);
