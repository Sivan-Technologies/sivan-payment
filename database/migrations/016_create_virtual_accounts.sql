create table if not exists payments_virtual_account_requests (
  id text primary key,
  user_id text not null references users(user_id),
  payments_customer_id text references payments_customers(id),
  currency text not null,
  country text,
  use_case text,
  status text not null,
  reviewed_by text,
  reviewed_at timestamptz,
  rejection_reason text,
  metadata jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index if not exists idx_payments_virtual_account_requests_user on payments_virtual_account_requests(user_id, created_at desc);
create index if not exists idx_payments_virtual_account_requests_status on payments_virtual_account_requests(status, created_at desc);
create index if not exists idx_payments_virtual_account_requests_currency on payments_virtual_account_requests(currency, status);

create table if not exists payments_virtual_accounts (
  id text primary key,
  request_id text references payments_virtual_account_requests(id),
  user_id text not null references users(user_id),
  payments_customer_id text references payments_customers(id),
  provider text not null,
  provider_account_id text not null,
  currency text not null,
  country text,
  bank_name text,
  account_name text,
  account_number_masked text,
  routing_number_masked text,
  iban_masked text,
  status text not null,
  raw_provider_payload jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique(provider, provider_account_id)
);

create index if not exists idx_payments_virtual_accounts_user on payments_virtual_accounts(user_id, created_at desc);
create index if not exists idx_payments_virtual_accounts_status on payments_virtual_accounts(status);
create index if not exists idx_payments_virtual_accounts_currency on payments_virtual_accounts(currency, status);
