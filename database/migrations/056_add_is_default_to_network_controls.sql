-- Add is_default column to payments_network_controls table
alter table payments_network_controls add column if not exists is_default boolean default false;

-- Set solana as default if no default is currently set
update payments_network_controls set is_default = true where network = 'solana' and not exists (
  select 1 from payments_network_controls where is_default = true
);
