create table if not exists payments_suppliers (
  id text primary key,
  user_id text not null references users(user_id),
  payments_customer_id text not null references payments_customers(id),
  supplier_name text not null,
  supplier_type text not null check (supplier_type in ('individual','business')),
  supplier_country text not null,
  currency text not null check (currency in ('usd','gbp','eur','mxn','brl')),
  bank_name text not null,
  account_owner_name text not null,
  account_type text not null check (account_type in ('us','gb','iban','clabe','pix','unknown')),
  account_last4 text,
  bridge_external_account_id text,
  status text not null check (status in ('draft','pending_review','approved','rejected','disabled')),
  risk_level text not null check (risk_level in ('low','medium','high','critical')),
  risk_score integer not null default 0,
  review_reason text,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_payments_suppliers_user on payments_suppliers(user_id, created_at desc);
create index if not exists idx_payments_suppliers_status on payments_suppliers(status, created_at desc);
create index if not exists idx_payments_suppliers_bridge_external on payments_suppliers(bridge_external_account_id);

create table if not exists payments_supplier_payments (
  id text primary key,
  user_id text not null references users(user_id),
  supplier_id text not null references payments_suppliers(id),
  amount numeric(24, 8) not null,
  source_asset text not null check (source_asset in ('usdc','usdt')),
  destination_currency text not null check (destination_currency in ('usd','gbp','eur','mxn','brl')),
  payment_purpose text not null,
  invoice_url text,
  status text not null check (status in ('draft','pending_review','approved','processing','completed','rejected','failed')),
  bridge_transfer_id text,
  risk_level text not null check (risk_level in ('low','medium','high','critical')),
  risk_score integer not null default 0,
  admin_decision text check (admin_decision in ('approved','rejected')),
  admin_decision_by text,
  admin_decision_at timestamptz,
  review_reason text,
  ace_risk_review jsonb,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_payments_supplier_payments_user on payments_supplier_payments(user_id, created_at desc);
create index if not exists idx_payments_supplier_payments_supplier on payments_supplier_payments(supplier_id, created_at desc);
create index if not exists idx_payments_supplier_payments_status on payments_supplier_payments(status, created_at desc);
create index if not exists idx_payments_supplier_payments_bridge_transfer on payments_supplier_payments(bridge_transfer_id);

create table if not exists payments_supplier_controls (
  id text primary key default 'global' check (id = 'global'),
  -- OFF by default: this column GRANTS a capability, so it fails closed.
  supplier_payments_enabled boolean not null default false,
  third_party_supplier_payouts_enabled boolean not null default false,
  auto_approve_approved_suppliers boolean not null default false,
  require_invoice_for_supplier_payouts boolean not null default true,
  manual_review_threshold numeric(24, 8) not null default 1000,
  new_supplier_first_payment_review boolean not null default true,
  new_customer_review_window_days integer not null default 7,
  new_customer_review_threshold numeric(24, 8) not null default 250,
  high_risk_countries text[] not null default array['RU','BY','VE','NG'],
  blocked_countries text[] not null default array['IR','KP','SY','CU'],
  daily_supplier_payout_limit numeric(24, 8) not null default 5000,
  monthly_supplier_payout_limit numeric(24, 8) not null default 25000,
  updated_by text,
  reason text,
  updated_at timestamptz not null default now()
);

insert into payments_supplier_controls (id, supplier_payments_enabled, third_party_supplier_payouts_enabled, auto_approve_approved_suppliers, require_invoice_for_supplier_payouts, manual_review_threshold, new_supplier_first_payment_review, new_customer_review_window_days, new_customer_review_threshold, daily_supplier_payout_limit, monthly_supplier_payout_limit, updated_by, reason)
values ('global', false, false, false, true, 1000, true, 7, 250, 5000, 25000, 'migration', 'Initial supplier payout controls. Payouts ship OFF and must be enabled deliberately.')
on conflict (id) do nothing;
