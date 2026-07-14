-- 011_create_sivan_unified_webhook_logs.sql
CREATE TABLE IF NOT EXISTS sivan_unified_webhook_logs (
  id TEXT PRIMARY KEY,
  service_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_event_id TEXT,
  payment_reference TEXT,
  event_category TEXT,
  event_type TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_unified_webhook_logs_service ON sivan_unified_webhook_logs(service_name);
CREATE INDEX IF NOT EXISTS idx_unified_webhook_logs_provider ON sivan_unified_webhook_logs(provider);
CREATE INDEX IF NOT EXISTS idx_unified_webhook_logs_payment_ref ON sivan_unified_webhook_logs(payment_reference);
CREATE INDEX IF NOT EXISTS idx_unified_webhook_logs_created_at ON sivan_unified_webhook_logs(created_at DESC);
