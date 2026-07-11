-- Hybrid identity support for Sivan.
-- WhatsApp users may exist without email; web users should provide email.
-- Payments references users.user_id only.

alter table users add column if not exists email text;
alter table users add column if not exists email_verified_at timestamptz;
alter table users add column if not exists whatsapp_verified_at timestamptz;
alter table users add column if not exists primary_channel text;

-- Existing users were created from WhatsApp/legacy flows.
update users
set primary_channel = case
  when email is not null and whatsapp_number is not null then 'both'
  when email is not null then 'email'
  else 'whatsapp'
end
where primary_channel is null;

-- Allow web-created users to exist before they connect WhatsApp.
alter table users alter column whatsapp_number drop not null;

create unique index if not exists users_email_unique
  on users (lower(email))
  where email is not null;

create unique index if not exists users_whatsapp_number_unique
  on users (whatsapp_number)
  where whatsapp_number is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_has_identity_channel'
  ) then
    alter table users add constraint users_has_identity_channel
      check (email is not null or whatsapp_number is not null);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_primary_channel_valid'
  ) then
    alter table users add constraint users_primary_channel_valid
      check (primary_channel is null or primary_channel in ('whatsapp', 'email', 'both'));
  end if;
end $$;
