create table if not exists payments_virtual_account_controls (
  currency text primary key,
  enabled boolean not null default false,
  label text not null,
  provider text not null default 'bridge',
  account_type text not null,
  payment_rails text[] not null default '{}',
  updated_by text,
  updated_at timestamptz not null
);

insert into payments_virtual_account_controls (currency, enabled, label, provider, account_type, payment_rails, updated_by, updated_at)
values
  ('usd', false, 'USD virtual account', 'bridge', 'us', array['ach_push','wire'], 'system', now()),
  ('gbp', false, 'GBP virtual account', 'bridge', 'gb', array['faster_payments'], 'system', now()),
  ('eur', false, 'EUR virtual account', 'bridge', 'iban', array['sepa'], 'system', now())
on conflict (currency) do nothing;
