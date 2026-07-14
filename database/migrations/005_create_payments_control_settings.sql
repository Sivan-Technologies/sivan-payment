create table if not exists payments_control_settings (
  currency text primary key,
  enabled boolean not null,
  label text not null,
  account_type text not null,
  default_payment_rail text not null,
  updated_by text,
  updated_at timestamptz not null
);

insert into payments_control_settings (currency, enabled, label, account_type, default_payment_rail, updated_by, updated_at)
values
  ('usd', true, 'USD — US bank account', 'us', 'ach', 'system', now()),
  ('gbp', true, 'GBP — UK bank account', 'gb', 'faster_payments', 'system', now()),
  ('eur', true, 'EUR — SEPA / IBAN', 'iban', 'sepa', 'system', now())
on conflict (currency) do nothing;
