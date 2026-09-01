-- Migration 055: Create service agreements table with delivery deadline tracking.
--
-- Adds a first-class payments_service_agreements table. Each row represents one
-- two-party service agreement between a buyer and a seller, funded by crypto,
-- with a structured delivery deadline extracted from natural language at creation
-- time.
--
-- DEADLINE SENTINEL COLUMNS:
--   reminder_6h_sent     - set to true after the 6-hour warning fires; prevents
--                          duplicate alerts from overlapping sweeper ticks.
--   overdue_notice_sent  - set to true after the overdue notice fires; same
--                          exactly-once guarantee, same idempotency pattern as
--                          the deposit notifier.
--
-- NETWORK COLUMN:
--   Stores which chain holds the funds (stellar | celo | solana | base | bsc).
--   Indexed because the sweeper and the developer gateway both filter on it.

CREATE TABLE IF NOT EXISTS payments_service_agreements (
  id                   TEXT PRIMARY KEY,

  buyer_user_id        TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  seller_user_id       TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,

  title                TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',

  amount_usdc          NUMERIC(20, 6) NOT NULL CHECK (amount_usdc > 0),
  currency             TEXT NOT NULL DEFAULT 'usdc',
  network              TEXT NOT NULL DEFAULT 'stellar',

  -- Lifecycle status. See ServiceAgreementStatus in types.ts for the allowed
  -- transitions. Indexed to allow the sweeper to skip released/cancelled rows.
  status               TEXT NOT NULL DEFAULT 'pending_payment',

  -- Delivery deadline. deadline_days is extracted from the natural language
  -- description at creation time. delivery_due_at is computed at funding time
  -- as funded_at + deadline_days * INTERVAL '1 day'.
  deadline_days        INTEGER NOT NULL DEFAULT 3,
  delivery_due_at      TIMESTAMP WITH TIME ZONE,

  -- Sentinel flags: each flips from false to true exactly once, acting as a
  -- compare-and-swap claim. The sweeper updates with WHERE reminder_6h_sent = false
  -- (or overdue_notice_sent = false) so two overlapping ticks cannot both send.
  reminder_6h_sent     BOOLEAN NOT NULL DEFAULT false,
  overdue_notice_sent  BOOLEAN NOT NULL DEFAULT false,

  -- Lifecycle timestamps. funded_at anchors delivery_due_at computation.
  funded_at            TIMESTAMP WITH TIME ZONE,
  delivered_at         TIMESTAMP WITH TIME ZONE,
  released_at          TIMESTAMP WITH TIME ZONE,

  created_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- The sweeper queries: status IN ('funded','in_delivery') AND delivery_due_at IS NOT NULL
-- This partial index covers exactly that filter without scanning released/cancelled rows.
CREATE INDEX IF NOT EXISTS idx_service_agreements_deadline_sweep
  ON payments_service_agreements (delivery_due_at)
  WHERE status IN ('funded', 'in_delivery') AND delivery_due_at IS NOT NULL;

-- Fast lookups by participant.
CREATE INDEX IF NOT EXISTS idx_service_agreements_buyer
  ON payments_service_agreements (buyer_user_id);

CREATE INDEX IF NOT EXISTS idx_service_agreements_seller
  ON payments_service_agreements (seller_user_id);

-- Network filter for developer gateway queries.
CREATE INDEX IF NOT EXISTS idx_service_agreements_network
  ON payments_service_agreements (network, status);
