create table if not exists ace_support_sessions (
  id text primary key,
  user_id text,
  channel text not null,
  resource_type text,
  resource_id text,
  confidence text not null,
  needs_human boolean not null default false,
  tools_used text[] not null default '{}',
  evidence_snapshot jsonb,
  created_at timestamptz not null
);

create table if not exists ace_support_messages (
  id text primary key,
  session_id text not null references ace_support_sessions(id) on delete cascade,
  role text not null,
  message text not null,
  created_at timestamptz not null
);

create table if not exists ace_tool_calls (
  id text primary key,
  session_id text not null references ace_support_sessions(id) on delete cascade,
  tool_name text not null,
  status text not null,
  summary text,
  created_at timestamptz not null
);

create table if not exists ace_support_resolutions (
  id text primary key,
  session_id text not null references ace_support_sessions(id) on delete cascade,
  resolution_type text not null,
  summary text not null,
  created_at timestamptz not null
);

create index if not exists idx_ace_support_sessions_user_created on ace_support_sessions(user_id, created_at desc);
create index if not exists idx_ace_support_sessions_resource on ace_support_sessions(resource_type, resource_id);
create index if not exists idx_ace_tool_calls_session on ace_tool_calls(session_id, created_at asc);
