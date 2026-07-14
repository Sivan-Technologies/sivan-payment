create table if not exists payments_auth_challenges (
  id text primary key,
  email text not null,
  code_hash text not null,
  intent text not null,
  full_name text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null
);

create index if not exists idx_payments_auth_challenges_email on payments_auth_challenges(lower(email));
create index if not exists idx_payments_auth_challenges_expires_at on payments_auth_challenges(expires_at);
