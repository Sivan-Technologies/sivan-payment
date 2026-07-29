-- Per-customer Bridge wallets.
--
-- Bridge's documented pattern is one wallet per customer, with that customer's
-- virtual account settling into it:
--
--   POST /customers/{id}/wallets              -> wallet for that customer
--   POST /customers/{id}/virtual_accounts
--        destination.bridge_wallet_id = that customer's wallet
--
-- Previously every virtual account settled into a single pooled Sivan wallet,
-- which made Sivan the custodian of user funds and put ownership tracking in
-- Sivan's own database. Bridge ToS 2.1(m) prohibits holding funds on behalf of
-- users. With per-customer wallets Bridge is custodian and source of truth.

create table if not exists payments_user_wallets (
  id                    text primary key,
  user_id               text not null references users(id) on delete cascade,
  payments_customer_id  text not null,
  provider              text not null default 'bridge',
  provider_wallet_id    text not null,
  chain                 text not null,
  address               text not null,
  status                text not null default 'active',
  custodial             boolean not null default true,
  raw                   jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint payments_user_wallets_chain_check
    check (chain in ('solana', 'base', 'ethereum')),
  constraint payments_user_wallets_status_check
    check (status in ('provisioning', 'active', 'suspended', 'closed', 'failed'))
);

-- A user must never hold two open wallets on the same chain. Deposits could
-- otherwise land on an address the UI is not displaying.
create unique index if not exists idx_payments_user_wallets_user_chain_open
  on payments_user_wallets (user_id, chain)
  where status <> 'closed';

-- Provider ids are globally unique; guards against double-inserting the same
-- Bridge wallet if a create call is retried.
create unique index if not exists idx_payments_user_wallets_provider_wallet
  on payments_user_wallets (provider, provider_wallet_id);

create index if not exists idx_payments_user_wallets_user
  on payments_user_wallets (user_id);

create index if not exists idx_payments_user_wallets_address
  on payments_user_wallets (address);
