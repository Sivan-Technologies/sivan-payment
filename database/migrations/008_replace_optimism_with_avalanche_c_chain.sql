-- Replace Optimism with Avalanche C-Chain in source network controls.
-- Bridge's payment_rail / chain enum uses avalanche_c_chain.

delete from payments_network_controls where network = 'optimism';

insert into payments_network_controls (network, enabled, label, sort_order, updated_by, updated_at)
values ('avalanche_c_chain', true, 'Avalanche C-Chain', 60, 'system', now())
on conflict (network) do update set
  label = excluded.label,
  sort_order = excluded.sort_order,
  updated_at = excluded.updated_at;
