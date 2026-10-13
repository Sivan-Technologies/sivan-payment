-- Migration 063: Add user_id indexes on KYC and payout tables
--
-- Context: End-to-end test run (36/36 passed, 2026-10-13) revealed sequential
-- scans on three tables during assertFundingLimits and getVerificationState
-- calls inside the NGN agreement risk-check path:
--
--   payments_external_accounts          932ms  (full seq scan on user_id)
--   payments_ngn_payout_accounts        825ms  (full seq scan on user_id)
--   payments_ngn_identity_verifications 796ms  (full seq scan on user_id)
--
-- These queries are called on every funding attempt, deposit verification,
-- and human ruling authorisation. Without indexes they scale linearly with
-- table row count and will degrade badly under real user load.
--
-- NOTE: CONCURRENTLY is intentionally omitted here. The project migration
-- runner (scripts/db-migrate.ts) wraps every file in BEGIN/COMMIT, and
-- Postgres forbids CREATE INDEX CONCURRENTLY inside a transaction block.
-- Plain CREATE INDEX IF NOT EXISTS is safe, idempotent, and transactional.
-- On Neon/AWS RDS the index build locks only the table briefly at the end
-- (not throughout) for small-to-medium tables with no concurrent heavy load.

-- Simple user_id lookup indexes (WHERE clause)
create index if not exists idx_external_accounts_user_id
  on payments_external_accounts(user_id);

create index if not exists idx_ngn_payout_accounts_user_id
  on payments_ngn_payout_accounts(user_id);

create index if not exists idx_ngn_identity_verifications_user_id
  on payments_ngn_identity_verifications(user_id);

-- Composite indexes matching the exact ORDER BY clauses in the live queries
-- so Postgres can satisfy WHERE + ORDER BY from the index alone (index-only scan).

create index if not exists idx_external_accounts_user_id_created_asc
  on payments_external_accounts(user_id, created_at asc);

create index if not exists idx_ngn_payout_accounts_user_id_created_asc
  on payments_ngn_payout_accounts(user_id, created_at asc);

create index if not exists idx_ngn_identity_verifications_user_id_created_desc
  on payments_ngn_identity_verifications(user_id, created_at desc);
