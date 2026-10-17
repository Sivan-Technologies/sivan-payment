-- Add missing active network controls (celo, stellar, bsc, arc, starknet) if not already present
insert into payments_network_controls (network, enabled, is_default, label, sort_order, updated_by, updated_at)
values
  ('bsc', true, false, 'BNB Chain', 25, 'system', now()),
  ('arc', true, false, 'Arc', 26, 'system', now()),
  ('arbitrum', true, false, 'Arbitrum', 27, 'system', now()),
  ('stellar', true, false, 'Stellar', 28, 'system', now()),
  ('celo', true, false, 'Celo', 29, 'system', now()),
  ('starknet', true, false, 'Starknet', 30, 'system', now())
on conflict (network) do nothing;
