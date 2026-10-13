ALTER TABLE ngn_agreement_outbox ADD COLUMN sequence bigserial;
ALTER TABLE ngn_agreement_outbox ADD COLUMN lease_token text;
ALTER TABLE ngn_agreement_outbox ADD COLUMN lease_until timestamptz;
ALTER TABLE ngn_agreement_outbox ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE ngn_agreement_outbox ADD COLUMN last_error_code text;
CREATE UNIQUE INDEX ngn_agreement_outbox_sequence ON ngn_agreement_outbox(sequence);
CREATE INDEX ngn_agreement_outbox_due ON ngn_agreement_outbox(next_attempt_at)
  WHERE delivered_at IS NULL;
