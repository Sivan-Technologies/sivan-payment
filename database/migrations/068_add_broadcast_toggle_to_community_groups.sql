-- Migration: 068_add_broadcast_toggle_to_community_groups.sql
-- Description: Adds is_broadcast_enabled flag to community_groups for morning market rates and utilities broadcast opt-in.

ALTER TABLE community_groups
    ADD COLUMN IF NOT EXISTS is_broadcast_enabled BOOLEAN DEFAULT FALSE NOT NULL;

CREATE INDEX IF NOT EXISTS idx_community_groups_broadcast ON community_groups(is_broadcast_enabled) WHERE is_broadcast_enabled = TRUE;

