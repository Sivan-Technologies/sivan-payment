-- Rollback: 068_rollback_add_broadcast_toggle_to_community_groups.sql
-- Description: Drops is_broadcast_enabled column and index from community_groups.

DROP INDEX IF EXISTS idx_community_groups_broadcast;

ALTER TABLE community_groups
    DROP COLUMN IF EXISTS is_broadcast_enabled;

