-- 074_create_web_auth_challenges.sql
-- Unified Cross-Device Web Challenge (QR Code & Instant Bot Deep-Link Login)

CREATE TABLE IF NOT EXISTS web_auth_challenges (
  id VARCHAR(64) PRIMARY KEY, -- wch_...
  device_info VARCHAR(255) NOT NULL,
  ip_address VARCHAR(64) NOT NULL,
  location VARCHAR(128),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'APPROVED', 'DECLINED', 'CONSUMED', 'EXPIRED'
  user_id VARCHAR(64),
  auth_token TEXT,
  auth_user_data JSONB,
  authorized_channel VARCHAR(32), -- 'telegram' or 'whatsapp'
  authorized_identifier VARCHAR(128), -- telegramId or phone
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  authorized_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_web_auth_challenges_status_expires 
  ON web_auth_challenges(status, expires_at);

