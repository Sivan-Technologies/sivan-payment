create table if not exists customer_identity_links (
  id text primary key,
  payment_user_id text not null references users(user_id),
  escrow_user_id text,
  email text not null,
  whatsapp_number text not null,
  status text not null,
  linked_at timestamptz,
  unlinked_at timestamptz,
  metadata jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

-- ONE ACTIVE LINK PER USER - true only before migration 044.
--
-- THIS BLOCK FAILED EVERY RENDER DEPLOY, and the guard is the fix:
--
--   error: could not create unique index
--          "idx_customer_identity_links_active_payment_user"
--   detail: Key (payment_user_id)=(usr_1c2937b2-...) is duplicated.
--
-- The runner (scripts/db-migrate.ts) has no ledger - it replays EVERY .sql file
-- on every deploy and relies on `if not exists` for idempotence. That holds
-- until a later migration deliberately removes something an earlier one
-- created, which is exactly what 044 does:
--
--   044:44  drop index if exists idx_customer_identity_links_active_payment_user;
--           create unique index ... on (payment_user_id, channel) ...
--
-- So on replay the index is genuinely absent, `if not exists` does not fire,
-- and this statement tries to reimpose one-active-link-per-USER on a table that
-- 044 widened to one-active-link-per-user-PER-CHANNEL.
--
-- It only started failing when the first real user linked BOTH WhatsApp and
-- Telegram: two rows, same payment_user_id, both status='linked'. Legal under
-- 044, fatal here. Nothing was wrong with that data - the Telegram feature
-- working as designed is what bricked the deploy, and it would have failed on
-- every deploy from then on.
--
-- Guarded on the `channel` column rather than on the index, because `channel`
-- is what marks the table as generalized. Pre-044 (including a fresh database
-- reaching this file) the column does not exist and the index is created, so
-- history is preserved; post-044 this is correctly a no-op.
--
-- The replay behaviour itself is fixed in scripts/db-migrate.ts, which now
-- keeps a ledger. This guard stays regardless: it makes the file honest about
-- the era it belongs to, and any database that predates the ledger still
-- replays this file exactly once.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'customer_identity_links' and column_name = 'channel'
  ) then
    create unique index if not exists idx_customer_identity_links_active_payment_user
      on customer_identity_links(payment_user_id)
      where status = 'linked';
  end if;
end $$;

create unique index if not exists idx_customer_identity_links_active_whatsapp
  on customer_identity_links(whatsapp_number)
  where status = 'linked';

create index if not exists idx_customer_identity_links_email on customer_identity_links(lower(email));
create index if not exists idx_customer_identity_links_escrow_user on customer_identity_links(escrow_user_id);

create table if not exists identity_pairing_tokens (
  id text primary key,
  payment_user_id text not null references users(user_id),
  token_hash text not null unique,
  status text not null,
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  canceled_at timestamptz,
  whatsapp_number text,
  escrow_user_id text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index if not exists idx_identity_pairing_tokens_user_status on identity_pairing_tokens(payment_user_id, status);
create index if not exists idx_identity_pairing_tokens_expires_at on identity_pairing_tokens(expires_at);
