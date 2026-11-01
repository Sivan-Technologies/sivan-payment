-- Migration: 066_create_community_partner_ledgers.sql
-- Description: Creates community groups registry and double-entry revshare allocation ledger with administrative earning toggles and custom percentage controls.

CREATE TABLE IF NOT EXISTS community_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_jid VARCHAR(128) UNIQUE NOT NULL,
    group_name VARCHAR(255) NOT NULL,
    admin_actor_id VARCHAR(64) NOT NULL,
    admin_phone VARCHAR(32) NOT NULL,
    referral_code VARCHAR(32) UNIQUE NOT NULL,
    revshare_percent NUMERIC(5,2) DEFAULT 20.00 NOT NULL,
    is_earning_enabled BOOLEAN DEFAULT TRUE NOT NULL,
    status VARCHAR(32) DEFAULT 'ACTIVE' NOT NULL,
    total_deals_count INTEGER DEFAULT 0 NOT NULL,
    total_volume_ngn NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
    total_revenue_earned_ngn NUMERIC(14,2) DEFAULT 0.00 NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_community_groups_admin ON community_groups(admin_actor_id);
CREATE INDEX IF NOT EXISTS idx_community_groups_refcode ON community_groups(referral_code);

CREATE TABLE IF NOT EXISTS community_revshare_ledgers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID REFERENCES community_groups(id) ON DELETE RESTRICT,
    agreement_id VARCHAR(64) NOT NULL,
    admin_actor_id VARCHAR(64) NOT NULL,
    deal_amount_ngn NUMERIC(14,2) NOT NULL,
    platform_fee_ngn NUMERIC(14,2) NOT NULL,
    revshare_percent_applied NUMERIC(5,2) NOT NULL,
    revshare_amount_ngn NUMERIC(14,2) NOT NULL,
    allocation_status VARCHAR(32) DEFAULT 'CREDITED' NOT NULL,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revshare_agreement ON community_revshare_ledgers(agreement_id);
CREATE INDEX IF NOT EXISTS idx_revshare_admin ON community_revshare_ledgers(admin_actor_id);

