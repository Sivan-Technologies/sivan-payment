-- Turn cross-border supplier payouts OFF on environments that already have a row.
--
-- WHY A MIGRATION AND NOT JUST A CODE DEFAULT.
--
-- Migration 025 INSERTED `payments_supplier_controls` with
-- supplier_payments_enabled = true, and a saved row always beats a code
-- default. Verified against the deployed test API before writing this: it
-- reports `supplierPaymentsEnabled: true, updatedBy: "migration"`. So lowering
-- the default in supplier-risk.service.ts alone would have changed NOTHING on
-- any environment that has ever run 025 - the flow would have stayed open
-- while the code claimed it shipped closed.
--
-- WHY THIS ONLY TOUCHES THE MIGRATION-SEEDED ROW.
--
-- `where updated_by = 'migration'` is the whole safety of this file.
-- db-migrate.ts re-runs every migration on EVERY deploy with no ledger, so an
-- unguarded UPDATE would switch supplier payouts off on every single deploy -
-- silently undoing an operator who had deliberately turned them on, minutes
-- earlier, from the admin hub. Once a human saves the controls the row's
-- updated_by becomes their identity and this stops matching it forever.
--
-- Idempotent by construction: after it runs once the row no longer satisfies
-- the predicate, so re-running is a no-op.
update payments_supplier_controls
   set supplier_payments_enabled = false,
       third_party_supplier_payouts_enabled = false,
       reason = 'Supplier payouts disabled by default for a lean launch. Enable deliberately in the admin hub.',
       updated_at = now()
 where id = 'global'
   and updated_by = 'migration';
