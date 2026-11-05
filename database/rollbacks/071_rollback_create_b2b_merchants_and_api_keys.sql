-- Rollback: 071_rollback_create_b2b_merchants_and_api_keys.sql

DROP TABLE IF EXISTS b2b_dispatched_flows CASCADE;
DROP TABLE IF EXISTS b2b_merchant_api_keys CASCADE;
DROP TABLE IF EXISTS b2b_merchants CASCADE;
