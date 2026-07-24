-- Initial users table creation for Sivan Payments
create table if not exists users (
  user_id text primary key,
  whatsapp_number text unique,
  email text unique,
  password_hash text,
  first_name text,
  last_name text,
  role_history text,
  primary_channel text,
  email_verified_at timestamptz,
  whatsapp_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_users_whatsapp_number on users(whatsapp_number) where whatsapp_number is not null;
create index if not exists idx_users_email on users(lower(email)) where email is not null;
