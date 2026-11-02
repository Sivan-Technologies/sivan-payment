-- Rollback Migration: 066_rollback_community_partner_ledgers.sql
-- Description: Drops community groups registry and revshare ledger tables safely.

DROP TABLE IF EXISTS community_revshare_ledgers;
DROP TABLE IF EXISTS community_groups;

