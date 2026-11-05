-- Migration 072: Create B2B Webhook Outbox Table
-- Ensures 100% durable, idempotent, retryable webhook delivery to third-party merchant servers with exponential backoff.

CREATE TABLE IF NOT EXISTS b2b_webhook_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES b2b_merchants(id) ON DELETE CASCADE,
  flow_id UUID REFERENCES b2b_dispatched_flows(id) ON DELETE SET NULL,
  event_type VARCHAR(64) NOT NULL DEFAULT 'payment.successful',
  destination_url TEXT NOT NULL,
  payload JSONB NOT NULL,
  signature_header VARCHAR(128) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED')),
  last_error TEXT,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_b2b_outbox_pending ON b2b_webhook_outbox(status, next_retry_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_b2b_outbox_merchant ON b2b_webhook_outbox(merchant_id);
CREATE INDEX IF NOT EXISTS idx_b2b_outbox_flow ON b2b_webhook_outbox(flow_id);
