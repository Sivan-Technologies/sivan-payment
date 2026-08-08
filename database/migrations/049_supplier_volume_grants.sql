-- Admin-granted supplier volume floors.
--
-- The supplier fee discount is driven by a user's 30-day volume, which Sivan
-- can only measure for flows it processes. A customer who settles half their
-- invoices through another provider is a bigger customer than these records
-- show, and inferring that would be inventing data. This table is the honest
-- alternative: a human decision, recorded with who made it, why, and when it
-- lapses.
--
-- IDEMPOTENT. db-migrate.ts runs every file on every deploy with no ledger,
-- so this must be safe to re-run - see the note in that script.
create table if not exists payments_supplier_volume_grants (
  id text primary key,
  user_id text not null,
  -- The 30-day volume to credit, in USD. Applied as a FLOOR: if the user's
  -- real Sivan volume is higher, the real figure wins.
  volume_usd numeric(18,2) not null,
  reason text not null,
  granted_by text not null,
  -- Grants expire by default. A forgotten discount that never ends is worse
  -- than one that has to be renewed.
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_supplier_volume_grants_user
  on payments_supplier_volume_grants (user_id);
