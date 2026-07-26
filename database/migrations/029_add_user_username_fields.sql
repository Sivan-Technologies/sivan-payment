alter table users
  add column if not exists username text,
  add column if not exists username_updated_at timestamptz;

create unique index if not exists idx_users_username_unique
  on users (lower(username))
  where username is not null;

create index if not exists idx_users_username_updated_at
  on users (username_updated_at desc)
  where username is not null;
