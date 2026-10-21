-- Migration 064: Create payments_json_store key-value table
--
-- Context: GHS corridor and generic document store operations rely on
-- payments_json_store as a schemaless key-value JSONB store.
-- Prior to this migration, queries to payments_json_store failed with 42P01.

CREATE TABLE IF NOT EXISTS payments_json_store (
    key VARCHAR(255) PRIMARY KEY,
    value JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_json_store_key_prefix
    ON payments_json_store (key text_pattern_ops);
