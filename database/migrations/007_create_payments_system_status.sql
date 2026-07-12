create table if not exists payments_system_status (
  id text primary key,
  mode text not null,
  message text,
  estimated_resume_at timestamptz,
  updated_by text,
  updated_at timestamptz not null,
  constraint payments_system_status_mode_valid check (mode in ('active', 'maintenance', 'paused'))
);

insert into payments_system_status (id, mode, message, estimated_resume_at, updated_by, updated_at)
values ('global', 'active', null, null, 'system', now())
on conflict (id) do nothing;
