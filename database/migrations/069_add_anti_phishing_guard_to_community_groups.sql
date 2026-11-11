-- Migration: 069_add_anti_phishing_guard_to_community_groups.sql
-- Description: Adds is_anti_phishing_enabled and allowed_link_patterns to community_groups for automated scam and link filtering.

ALTER TABLE community_groups
    ADD COLUMN IF NOT EXISTS is_anti_phishing_enabled BOOLEAN DEFAULT FALSE NOT NULL,
    ADD COLUMN IF NOT EXISTS allowed_link_patterns TEXT DEFAULT '' NOT NULL;

CREATE INDEX IF NOT EXISTS idx_community_groups_guard ON community_groups(is_anti_phishing_enabled) WHERE is_anti_phishing_enabled = TRUE;

