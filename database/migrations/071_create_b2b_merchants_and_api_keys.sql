-- Migration: 071_create_b2b_merchants_and_api_keys.sql
-- Description: Creates B2B merchant tables, API keys, and dispatched Meta Flow tracking for partner checkouts.

CREATE TABLE IF NOT EXISTS b2b_merchants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(128) UNIQUE NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    webhook_url TEXT,
    webhook_secret VARCHAR(128),
    custom_greeting TEXT,
    custom_button_label VARCHAR(128),
    custom_success_message TEXT,
    total_volume_ngn NUMERIC(16,2) NOT NULL DEFAULT 0.00,
    total_deals_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS b2b_merchant_api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES b2b_merchants(id) ON DELETE CASCADE,
    key_prefix VARCHAR(16) NOT NULL,
    public_key VARCHAR(64) NOT NULL,
    secret_hash VARCHAR(128) NOT NULL,
    masked_key VARCHAR(32) NOT NULL,
    mode VARCHAR(16) NOT NULL DEFAULT 'live',
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS b2b_dispatched_flows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES b2b_merchants(id) ON DELETE CASCADE,
    reference VARCHAR(128) UNIQUE NOT NULL,
    customer_phone VARCHAR(64) NOT NULL,
    customer_name VARCHAR(128),
    amount_ngn NUMERIC(14,2) NOT NULL,
    currency VARCHAR(16) NOT NULL DEFAULT 'NGN',
    flow_type VARCHAR(64) NOT NULL DEFAULT 'checkout',
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    dedicated_account_number VARCHAR(32),
    dedicated_bank_name VARCHAR(64),
    meta_message_id VARCHAR(128),
    greeting_message TEXT,
    button_label VARCHAR(128),
    success_message TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_b2b_merchants_slug ON b2b_merchants(slug);
CREATE INDEX IF NOT EXISTS idx_b2b_api_keys_hash ON b2b_merchant_api_keys(secret_hash);
CREATE INDEX IF NOT EXISTS idx_b2b_dispatched_flows_ref ON b2b_dispatched_flows(reference);
CREATE INDEX IF NOT EXISTS idx_b2b_dispatched_flows_merchant ON b2b_dispatched_flows(merchant_id);

