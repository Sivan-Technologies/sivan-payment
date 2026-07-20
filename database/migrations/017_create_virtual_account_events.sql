create table if not exists payments_virtual_account_events (
  id text primary key,
  provider text not null,
  provider_event_id text not null,
  virtual_account_id text references payments_virtual_accounts(id),
  provider_account_id text,
  deposit_id text,
  event_type text not null,
  source_currency text,
  destination_currency text,
  source_amount numeric(36,18),
  destination_amount numeric(36,18),
  payment_rail text,
  status text not null,
  deposit_reference text,
  destination_tx_hash text,
  raw_payload jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique(provider, provider_event_id)
);

create index if not exists idx_payments_virtual_account_events_account on payments_virtual_account_events(virtual_account_id, created_at desc);
create index if not exists idx_payments_virtual_account_events_provider_account on payments_virtual_account_events(provider, provider_account_id);
create index if not exists idx_payments_virtual_account_events_deposit on payments_virtual_account_events(provider, deposit_id);

create table if not exists payments_virtual_account_transactions (
  id text primary key,
  provider text not null,
  virtual_account_id text references payments_virtual_accounts(id),
  provider_account_id text,
  deposit_id text not null,
  user_id text references users(user_id),
  payments_customer_id text references payments_customers(id),
  source_currency text,
  destination_currency text,
  source_amount numeric(36,18),
  destination_amount numeric(36,18),
  payment_rail text,
  status text not null,
  deposit_reference text,
  destination_tx_hash text,
  last_provider_event_id text,
  raw_payload jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz,
  unique(provider, deposit_id)
);

create index if not exists idx_payments_virtual_account_transactions_user on payments_virtual_account_transactions(user_id, created_at desc);
create index if not exists idx_payments_virtual_account_transactions_account on payments_virtual_account_transactions(virtual_account_id, created_at desc);
create index if not exists idx_payments_virtual_account_transactions_status on payments_virtual_account_transactions(status, created_at desc);
