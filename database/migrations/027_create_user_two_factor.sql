create table if not exists payments_user_two_factor (
  user_id text primary key references users(user_id) on delete cascade,
  enabled boolean not null default false,
  secret_encrypted text not null,
  recovery_code_hashes text[] not null default array[]::text[],
  enabled_at timestamptz,
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_payments_user_two_factor_enabled on payments_user_two_factor(enabled, updated_at desc);
