-- Migration: 070_add_kyc_intent_to_users.sql
-- Description: Adds compliance intent preferences and assigned KYC routing to the users table for intent-aware KYC routing.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS intent_virtual_accounts BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS intent_offramp BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS intent_service_agreements BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS intent_configured_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS kyc_routing_assigned VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_users_kyc_routing ON users(kyc_routing_assigned) WHERE kyc_routing_assigned IS NOT NULL;

