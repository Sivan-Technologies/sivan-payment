-- Rollback Migration 072: Drop B2B Webhook Outbox Table

DROP TABLE IF EXISTS b2b_webhook_outbox CASCADE;
