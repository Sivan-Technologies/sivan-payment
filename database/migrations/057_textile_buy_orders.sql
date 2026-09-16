-- Recovery records only: no ledger entries, balances or provider actions.
create table if not exists textile_buy_orders (
  wallet text not null,
  chain_id bigint not null,
  provider text not null,
  intent_key text not null,
  amount text not null,
  provider_transfer_id text unique,
  encrypted_result text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (wallet, chain_id, provider, intent_key)
);
create index if not exists textile_buy_orders_wallet_recent
  on textile_buy_orders (wallet, chain_id, provider, created_at desc);
