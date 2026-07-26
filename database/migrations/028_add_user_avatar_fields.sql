alter table users
  add column if not exists avatar_url text,
  add column if not exists avatar_object_key text,
  add column if not exists avatar_updated_at timestamptz;

create index if not exists idx_users_avatar_updated_at on users(avatar_updated_at desc) where avatar_url is not null;
