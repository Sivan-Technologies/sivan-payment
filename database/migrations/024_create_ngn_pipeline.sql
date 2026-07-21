create table if not exists payments_ngn_controls (
  id text primary key,
  onramp_enabled boolean not null default false,
  offramp_enabled boolean not null default false,
  mock_provider_enabled boolean not null default true,
  bank_settlement_enabled boolean not null default false,
  virtual_account_enabled boolean not null default false,
  active_provider text not null default 'mock',
  backup_provider text,
  max_transaction_ngn text not null default '500000',
  daily_limit_ngn text not null default '2000000',
  high_value_review_threshold_ngn text not null default '1000000',
  updated_by text,
  updated_at timestamptz not null
);

insert into payments_ngn_controls (id, updated_by, updated_at)
values ('global', 'system', now())
on conflict (id) do nothing;

create table if not exists payments_ngn_quotes (
  id text primary key,
  user_id text not null references users(user_id),
  customer_id text,
  direction text not null,
  provider text not null,
  source_currency text not null,
  destination_currency text not null,
  source_amount text not null,
  destination_amount text not null,
  rate text not null,
  fee_amount text not null,
  status text not null,
  provider_quote_id text,
  expires_at timestamptz not null,
  metadata jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists payments_ngn_transfers (
  id text primary key,
  quote_id text not null references payments_ngn_quotes(id),
  user_id text not null references users(user_id),
  customer_id text,
  direction text not null,
  provider text not null,
  source_currency text not null,
  destination_currency text not null,
  source_amount text not null,
  destination_amount text not null,
  rate text not null,
  fee_amount text not null,
  status text not null,
  provider_quote_id text,
  provider_transfer_id text,
  bank_reference text,
  deposit_address text,
  virtual_account jsonb,
  settlement_reference text,
  destination_tx_hash text,
  metadata jsonb,
  timeline jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz
);

create table if not exists payments_ngn_webhook_events (
  id text primary key,
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  transfer_id text,
  payload jsonb,
  processed_at timestamptz,
  created_at timestamptz not null,
  unique(provider, provider_event_id)
);

create index if not exists idx_payments_ngn_quotes_user_created on payments_ngn_quotes(user_id, created_at desc);
create index if not exists idx_payments_ngn_quotes_status on payments_ngn_quotes(status, expires_at);
create index if not exists idx_payments_ngn_transfers_user_created on payments_ngn_transfers(user_id, created_at desc);
create index if not exists idx_payments_ngn_transfers_status on payments_ngn_transfers(status, updated_at desc);
create index if not exists idx_payments_ngn_transfers_provider_ref on payments_ngn_transfers(provider, provider_transfer_id);
create index if not exists idx_payments_ngn_webhooks_transfer on payments_ngn_webhook_events(transfer_id, created_at desc);
