-- Rollback Migration: 069_rollback_add_anti_phishing_guard_to_community_groups.sql

DROP INDEX IF EXISTS idx_community_groups_guard;

ALTER TABLE community_groups
    DROP COLUMN IF EXISTS is_anti_phishing_enabled,
    DROP COLUMN IF EXISTS allowed_link_patterns;

