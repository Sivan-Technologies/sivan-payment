-- Migration: 073_add_partner_portal_controls_to_b2b_merchants.sql
-- Description: Adds Live API toggle, Sandbox webhook URL, password authentication, and session tracking for partner.sivantech.online.

ALTER TABLE b2b_merchants
    ADD COLUMN IF NOT EXISTS is_sandbox_enabled BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS is_live_enabled BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS sandbox_webhook_url TEXT,
    ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255),
    ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS live_approved_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS live_approved_by VARCHAR(255);

