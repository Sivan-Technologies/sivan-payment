-- NGN only. No balances are imported or credited by this migration.
-- This module is not enabled until authenticated adapters/reconciliation ship.
CREATE TABLE ngn_agreement_accounts (
  id text PRIMARY KEY,
  balance_kobo bigint NOT NULL DEFAULT 0,
  CHECK (balance_kobo >= 0 OR id = 'provider:paystack:clearing')
);
CREATE TABLE ngn_balance_agreements (
  id text PRIMARY KEY,
  buyer_id text NOT NULL,
  seller_id text NOT NULL,
  title text NOT NULL,
  principal_kobo bigint NOT NULL CHECK (principal_kobo > 0),
  fee_kobo bigint NOT NULL CHECK (fee_kobo >= 0),
  fee_bps integer NOT NULL CHECK (fee_bps = 100),
  policy_version text NOT NULL CHECK (policy_version = 'ngn-balance-v1'),
  status text NOT NULL CHECK (status IN ('DRAFT_PENDING_SELLER_KYC', 'PENDING_PAYMENT',
    'FUNDED_PENDING_ACCEPTANCE', 'FUNDED', 'IN_DELIVERY', 'DELIVERED', 'DISPUTED', 'COMPLETED', 'CANCELLED')),
  accepted_at timestamptz,
  funded_at timestamptz,
  started_at timestamptz,
  delivered_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (buyer_id <> seller_id)
);
CREATE INDEX ngn_balance_agreements_buyer_pending ON ngn_balance_agreements (buyer_id, status);
CREATE INDEX ngn_balance_agreements_expiry ON ngn_balance_agreements (expires_at)
  WHERE status IN ('DRAFT_PENDING_SELLER_KYC', 'PENDING_PAYMENT', 'FUNDED_PENDING_ACCEPTANCE');
CREATE TABLE ngn_agreement_operations (
  id text PRIMARY KEY,
  fingerprint text NOT NULL,
  result jsonb NOT NULL
);
CREATE TABLE ngn_agreement_postings (
  operation_id text NOT NULL REFERENCES ngn_agreement_operations(id),
  account_id text NOT NULL REFERENCES ngn_agreement_accounts(id),
  delta_kobo bigint NOT NULL CHECK (delta_kobo <> 0),
  PRIMARY KEY (operation_id, account_id)
);
CREATE TABLE ngn_agreement_cancellation_consents (
  agreement_id text NOT NULL REFERENCES ngn_balance_agreements(id),
  actor_id text NOT NULL,
  PRIMARY KEY (agreement_id, actor_id)
);
CREATE TABLE ngn_agreement_outbox (
  id text PRIMARY KEY REFERENCES ngn_agreement_operations(id),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);
