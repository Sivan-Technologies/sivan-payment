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
-- Each index uses CONCURRENTLY so it can be applied to a live production
-- database without locking the table or blocking in-flight transactions.
-- CONCURRENTLY cannot run inside an explicit BEGIN/COMMIT block; run this
-- migration outside a transaction (psql with --single-transaction=off).

create index concurrently if not exists idx_external_accounts_user_id
  on payments_external_accounts(user_id);

create index concurrently if not exists idx_ngn_payout_accounts_user_id
  on payments_ngn_payout_accounts(user_id);

create index concurrently if not exists idx_ngn_identity_verifications_user_id
  on payments_ngn_identity_verifications(user_id);

-- Secondary composite indexes for the exact ORDER BY clauses used in
-- the live queries (created_at asc / desc) so Postgres can satisfy
-- both the WHERE and ORDER BY from the index alone (index-only scan).

create index concurrently if not exists idx_external_accounts_user_id_created_asc
  on payments_external_accounts(user_id, created_at asc);

create index concurrently if not exists idx_ngn_payout_accounts_user_id_created_asc
  on payments_ngn_payout_accounts(user_id, created_at asc);

create index concurrently if not exists idx_ngn_identity_verifications_user_id_created_desc
  on payments_ngn_identity_verifications(user_id, created_at desc);
