-- Rollback Migration 067: Drop community group attribution columns
-- Description: Removes originating_channel, originating_group_id, admin_referral_id, and community_revshare_amount from payments_service_agreements.

DROP INDEX IF EXISTS idx_agreements_admin_ref;
DROP INDEX IF EXISTS idx_agreements_originating_group;

ALTER TABLE payments_service_agreements
    DROP COLUMN IF EXISTS originating_channel,
    DROP COLUMN IF EXISTS originating_group_id,
    DROP COLUMN IF EXISTS admin_referral_id,
    DROP COLUMN IF EXISTS community_revshare_amount;
