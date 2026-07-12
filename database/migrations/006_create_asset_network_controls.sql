create table if not exists payments_asset_controls (
  asset text primary key,
  enabled boolean not null,
  label text not null,
  updated_by text,
  updated_at timestamptz not null
);

create table if not exists payments_network_controls (
  network text primary key,
  enabled boolean not null,
  label text not null,
  sort_order integer not null default 100,
  updated_by text,
  updated_at timestamptz not null
);

insert into payments_asset_controls (asset, enabled, label, updated_by, updated_at)
values
  ('usdc', true, 'USDC', 'system', now()),
  ('usdt', false, 'USDT', 'system', now())
on conflict (asset) do nothing;

insert into payments_network_controls (network, enabled, label, sort_order, updated_by, updated_at)
values
  ('base', true, 'Base', 10, 'system', now()),
  ('polygon', true, 'Polygon', 20, 'system', now()),
  ('ethereum', true, 'Ethereum', 30, 'system', now()),
  ('solana', true, 'Solana', 40, 'system', now()),
  ('arbitrum', true, 'Arbitrum', 50, 'system', now()),
  ('avalanche_c_chain', true, 'Avalanche C-Chain', 60, 'system', now())
on conflict (network) do nothing;
