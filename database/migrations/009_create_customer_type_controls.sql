create table if not exists payments_customer_type_controls (
  customer_type text primary key,
  enabled boolean not null,
  label text not null,
  updated_by text,
  updated_at timestamptz not null,
  constraint payments_customer_type_controls_type_valid check (customer_type in ('individual', 'business'))
);

insert into payments_customer_type_controls (customer_type, enabled, label, updated_by, updated_at)
values
  ('individual', true, 'Individual', 'system', now()),
  ('business', false, 'Business', 'system', now())
on conflict (customer_type) do nothing;
