-- Rollback Migration: 070_rollback_add_kyc_intent_to_users.sql

DROP INDEX IF EXISTS idx_users_kyc_routing;

ALTER TABLE users
    DROP COLUMN IF EXISTS intent_virtual_accounts,
    DROP COLUMN IF EXISTS intent_offramp,
    DROP COLUMN IF EXISTS intent_service_agreements,
    DROP COLUMN IF EXISTS intent_configured_at,
    DROP COLUMN IF EXISTS kyc_routing_assigned;

