create table if not exists payments_onramp_orders (
  id text primary key,
  user_id text not null references users(user_id),
  payments_customer_id text not null references payments_customers(id),
  provider text not null,
  provider_transfer_id text,
  source_currency text not null,
  source_payment_rail text not null,
  destination_currency text not null,
  destination_chain text not null,
  destination_address text not null,
  amount numeric(36, 18) not null,
  fee_percent numeric(10, 6),
  fee_amount numeric(36, 18),
  net_amount numeric(36, 18),
  provider_reference text,
  source_deposit_instructions jsonb,
  destination_tx_hash text,
  status text not null,
  status_reason text,
  receipt jsonb,
  raw_payload jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz,
  unique (provider, provider_transfer_id)
);

create index if not exists idx_payments_onramp_orders_user_id on payments_onramp_orders(user_id);
create index if not exists idx_payments_onramp_orders_customer_id on payments_onramp_orders(payments_customer_id);
create index if not exists idx_payments_onramp_orders_status on payments_onramp_orders(status);
create index if not exists idx_payments_onramp_orders_created_at on payments_onramp_orders(created_at);
