-- Sivan Payments tables.
-- These tables intentionally reference the existing central users table.
-- Do not create another users table in the payments service.

create table if not exists payments_customers (
  id text primary key,
  user_id text not null references users(user_id),
  provider text not null,
  provider_customer_id text not null,
  customer_type text,
  kyc_link_id text,
  kyc_link text,
  tos_link text,
  kyc_status text not null,
  tos_status text,
  onboarding_cost_usd numeric(18, 2),
  onboarding_cost_type text,
  onboarding_cost_recorded_at timestamptz,
  raw_payload jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (provider, provider_customer_id)
);

create index if not exists idx_payments_customers_user_id on payments_customers(user_id);
create index if not exists idx_payments_customers_provider_customer on payments_customers(provider, provider_customer_id);

create table if not exists payments_external_accounts (
  id text primary key,
  user_id text not null references users(user_id),
  payments_customer_id text not null references payments_customers(id),
  provider text not null,
  provider_external_account_id text not null,
  currency text not null,
  account_type text not null,
  bank_name text,
  account_name text,
  account_owner_name text not null,
  account_last4 text,
  payment_rail text not null,
  status text not null,
  raw_payload jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (provider, provider_external_account_id)
);

create index if not exists idx_payments_external_accounts_user_id on payments_external_accounts(user_id);
create index if not exists idx_payments_external_accounts_customer_id on payments_external_accounts(payments_customer_id);

create table if not exists payments_liquidation_addresses (
  id text primary key,
  user_id text not null references users(user_id),
  payments_customer_id text not null references payments_customers(id),
  payments_external_account_id text not null references payments_external_accounts(id),
  provider text not null,
  provider_liquidation_address_id text not null,
  address text not null,
  memoless_address text,
  chain text not null,
  source_currency text not null,
  destination_currency text not null,
  destination_payment_rail text not null,
  return_address text,
  return_instructions jsonb,
  custom_developer_fee_percent numeric(10, 6),
  status text not null,
  raw_payload jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (provider, provider_liquidation_address_id)
);

create index if not exists idx_payments_liquidation_addresses_user_id on payments_liquidation_addresses(user_id);
create index if not exists idx_payments_liquidation_addresses_customer_id on payments_liquidation_addresses(payments_customer_id);
create index if not exists idx_payments_liquidation_addresses_external_account_id on payments_liquidation_addresses(payments_external_account_id);
create index if not exists idx_payments_liquidation_addresses_address on payments_liquidation_addresses(address);

create table if not exists payments_withdrawals (
  id text primary key,
  user_id text not null references users(user_id),
  payments_customer_id text not null references payments_customers(id),
  payments_external_account_id text not null references payments_external_accounts(id),
  payments_liquidation_address_id text not null references payments_liquidation_addresses(id),
  provider text not null,
  provider_drain_id text,
  source_currency text not null,
  destination_currency text not null,
  source_amount numeric(36, 18),
  destination_amount numeric(36, 18),
  fee_percent numeric(10, 6),
  fee_amount numeric(36, 18),
  deposit_tx_hash text,
  destination_reference text,
  destination_tx_hash text,
  status text not null,
  status_reason text,
  raw_payload jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz
);

create unique index if not exists idx_payments_withdrawals_provider_drain_id
  on payments_withdrawals(provider, provider_drain_id)
  where provider_drain_id is not null;
create index if not exists idx_payments_withdrawals_user_id on payments_withdrawals(user_id);
create index if not exists idx_payments_withdrawals_status on payments_withdrawals(status);
create index if not exists idx_payments_withdrawals_created_at on payments_withdrawals(created_at);

create table if not exists payments_webhook_events (
  id text primary key,
  provider text not null,
  provider_event_id text not null,
  event_category text,
  event_type text,
  event_object_id text,
  payload jsonb not null,
  processed_at timestamptz,
  created_at timestamptz not null,
  unique (provider, provider_event_id)
);

create index if not exists idx_payments_webhook_events_provider_event on payments_webhook_events(provider, provider_event_id);
create index if not exists idx_payments_webhook_events_category on payments_webhook_events(event_category);

create table if not exists payments_reconciliation_runs (
  id text primary key,
  provider text,
  dry_run boolean not null,
  status text not null,
  summary jsonb,
  error text,
  started_at timestamptz not null,
  completed_at timestamptz
);

create table if not exists payments_reconciliation_findings (
  id text primary key,
  run_id text not null references payments_reconciliation_runs(id),
  provider text,
  severity text not null,
  finding_type text not null,
  withdrawal_id text,
  liquidation_address_id text,
  provider_drain_id text,
  message text not null,
  expected jsonb,
  actual jsonb,
  status text not null,
  created_at timestamptz not null
);

create index if not exists idx_payments_reconciliation_findings_run_id on payments_reconciliation_findings(run_id);
create index if not exists idx_payments_reconciliation_findings_status on payments_reconciliation_findings(status);

create table if not exists payments_onboarding_costs (
  id text primary key,
  user_id text not null references users(user_id),
  payments_customer_id text references payments_customers(id),
  provider text not null,
  cost_type text not null,
  amount numeric(18, 2) not null,
  currency text not null default 'usd',
  status text not null default 'recorded',
  metadata jsonb,
  created_at timestamptz not null,
  recovered_at timestamptz
);

create index if not exists idx_payments_onboarding_costs_user_id on payments_onboarding_costs(user_id);
create index if not exists idx_payments_onboarding_costs_customer_id on payments_onboarding_costs(payments_customer_id);
