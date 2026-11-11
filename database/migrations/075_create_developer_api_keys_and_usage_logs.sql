-- Migration: 075_create_developer_api_keys_and_usage_logs.sql
-- Description: Multi-tenant developer API keys, scopes, monthly quotas, and request usage logs.

CREATE TABLE IF NOT EXISTS developer_api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_prefix VARCHAR(32) NOT NULL,
    key_hash VARCHAR(128) NOT NULL,
    masked_key VARCHAR(48) NOT NULL,
    developer_name VARCHAR(128) NOT NULL,
    email VARCHAR(255) NOT NULL,
    organization VARCHAR(128),
    environment VARCHAR(16) NOT NULL DEFAULT 'live',
    permitted_endpoints JSONB NOT NULL DEFAULT '["all"]'::jsonb,
    monthly_limit INTEGER NOT NULL DEFAULT 1000,
    current_month_requests INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    expiry_date TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_by VARCHAR(64) NOT NULL DEFAULT 'superadmin',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    revoked_reason TEXT,
    webhook_url TEXT,
    webhook_secret VARCHAR(128)
);

CREATE TABLE IF NOT EXISTS developer_usage_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_id UUID NOT NULL REFERENCES developer_api_keys(id) ON DELETE CASCADE,
    endpoint VARCHAR(128) NOT NULL,
    method VARCHAR(8) NOT NULL,
    status_code INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    ip_address VARCHAR(64),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_developer_api_keys_prefix ON developer_api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_developer_api_keys_status ON developer_api_keys(status);
CREATE INDEX IF NOT EXISTS idx_developer_usage_logs_key_time ON developer_usage_logs(key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_developer_usage_logs_created_at ON developer_usage_logs(created_at DESC);
