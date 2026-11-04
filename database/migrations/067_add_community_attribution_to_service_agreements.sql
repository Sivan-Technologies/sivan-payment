-- Migration 067: Add community group attribution to service agreements
-- Description: Adds originating_channel, originating_group_id, admin_referral_id, and community_revshare_amount to payments_service_agreements.

ALTER TABLE payments_service_agreements
    ADD COLUMN IF NOT EXISTS originating_channel VARCHAR(32) DEFAULT 'DIRECT_DM',
    ADD COLUMN IF NOT EXISTS originating_group_id VARCHAR(128),
    ADD COLUMN IF NOT EXISTS admin_referral_id VARCHAR(64),
    ADD COLUMN IF NOT EXISTS community_revshare_amount NUMERIC(14,2) DEFAULT 0.00;

CREATE INDEX IF NOT EXISTS idx_agreements_originating_group ON payments_service_agreements(originating_group_id);
CREATE INDEX IF NOT EXISTS idx_agreements_admin_ref ON payments_service_agreements(admin_referral_id);
