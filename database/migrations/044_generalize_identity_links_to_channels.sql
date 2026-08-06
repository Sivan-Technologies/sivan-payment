-- Generalize customer identity links from WhatsApp-only to per-channel.
--
-- WHY
--
-- 015_create_customer_identity_links.sql assumed one messaging channel. It
-- stored the counterpart identity in a NOT NULL `whatsapp_number` column and
-- enforced one active link per user:
--
--   create unique index ... on customer_identity_links(payment_user_id)
--     where status = 'linked';
--
-- Telegram breaks both assumptions. A Telegram link has no phone number at all
-- (Telegram only reveals one if the user shares a contact card, and we no
-- longer ask), and a user who is reachable on WhatsApp *and* Telegram needs two
-- active links, not one.
--
-- WHAT CHANGES
--
-- `channel` discriminates the link. `telegram_user_id` holds the Telegram
-- numeric id, which is what Telegram itself authenticates on every update and
-- is therefore a stronger binding than a self-asserted phone number.
--
-- BACKFILL
--
-- `default 'whatsapp'` is deliberate: every existing row is a WhatsApp link, so
-- the default backfills them correctly and no data migration is needed. New
-- code always writes `channel` explicitly.
--
-- The unique index on (payment_user_id) is REPLACED by (payment_user_id,
-- channel). Dropping it is safe because the replacement is strictly narrower:
-- it still forbids two active WhatsApp links for one user, it only permits one
-- WhatsApp plus one Telegram.

alter table customer_identity_links
  add column if not exists channel text not null default 'whatsapp',
  add column if not exists telegram_user_id text,
  add column if not exists telegram_username text;

-- A Telegram link has no phone number to put here.
alter table customer_identity_links
  alter column whatsapp_number drop not null;

-- One active link per user PER CHANNEL, replacing one active link per user.
drop index if exists idx_customer_identity_links_active_payment_user;
create unique index if not exists idx_customer_identity_links_active_user_channel
  on customer_identity_links(payment_user_id, channel)
  where status = 'linked';

-- A Telegram account may not be claimed by two Sivan users at once. Mirrors
-- idx_customer_identity_links_active_whatsapp from migration 015.
create unique index if not exists idx_customer_identity_links_active_telegram
  on customer_identity_links(telegram_user_id)
  where status = 'linked' and telegram_user_id is not null;

create index if not exists idx_customer_identity_links_channel
  on customer_identity_links(channel);

-- Pairing tokens carry the channel they were issued for, so a code generated
-- for Telegram cannot be redeemed by the WhatsApp bot and vice versa. Without
-- this, either bot could redeem any pending code for a user.
alter table identity_pairing_tokens
  add column if not exists channel text not null default 'whatsapp',
  add column if not exists telegram_user_id text;

-- Telegram identity on the user record, mirroring the whatsapp_* columns.
alter table users
  add column if not exists telegram_user_id text,
  add column if not exists telegram_username text,
  add column if not exists telegram_verified_at timestamptz;

create unique index if not exists idx_users_telegram_user_id
  on users(telegram_user_id)
  where telegram_user_id is not null;
