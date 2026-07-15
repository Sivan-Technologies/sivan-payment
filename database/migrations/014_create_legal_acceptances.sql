create table if not exists payments_legal_acceptances (
  id text primary key,
  user_id text not null references users(user_id) on delete cascade,
  email text not null,
  terms_version text not null,
  privacy_version text not null,
  risk_disclosure_version text not null,
  accepted_at timestamptz not null,
  ip_address text,
  user_agent text,
  source text not null default 'signup',
  created_at timestamptz not null default now()
);

create index if not exists idx_payments_legal_acceptances_user_id on payments_legal_acceptances(user_id);
create index if not exists idx_payments_legal_acceptances_email on payments_legal_acceptances(lower(email));
create index if not exists idx_payments_legal_acceptances_accepted_at on payments_legal_acceptances(accepted_at desc);

alter table payments_auth_challenges add column if not exists legal_terms_version text;
alter table payments_auth_challenges add column if not exists legal_privacy_version text;
alter table payments_auth_challenges add column if not exists legal_risk_disclosure_version text;
alter table payments_auth_challenges add column if not exists legal_accepted_at timestamptz;
alter table payments_auth_challenges add column if not exists legal_acceptance_ip_address text;
alter table payments_auth_challenges add column if not exists legal_acceptance_user_agent text;
