-- Follow-up migration; do not edit an already released outbox migration.
-- Skipped events are processed, but were never delivered to a remote service.
ALTER TABLE ngn_agreement_outbox ADD COLUMN skipped_at timestamptz;
