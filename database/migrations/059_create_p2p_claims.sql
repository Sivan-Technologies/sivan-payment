-- Create the P2P claims table for transfers to unregistered phone numbers.
--
-- WHY THIS IS MIGRATION 059
--
-- payments_p2p_claims was referenced in saveP2pClaim() and findP2pClaimByToken()
-- but was never formally included in the migration ledger. On a fresh schema or
-- any schema that predates this file, the INSERT into payments_p2p_claims throws:
--
--   DatabaseError: relation "payments_p2p_claims" does not exist
--
-- This migration creates it idempotently so that existing databases where the
-- table was created manually are unaffected, and fresh databases get the
-- correct schema applied in order.

create table if not exists payments_p2p_claims (
  id                text        primary key,
  claim_token       text        not null unique,
  sender_user_id    text        not null references users(user_id) on delete cascade,
  recipient_phone   text        not null,
  amount            numeric(20, 8) not null,
  asset             text        not null default 'usdc',
  status            text        not null default 'pending'
                                check (status in ('pending', 'claimed', 'expired', 'cancelled')),
  expires_at        timestamptz not null,
  claimed_by_user_id text       references users(user_id) on delete set null,
  claimed_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_payments_p2p_claims_sender
  on payments_p2p_claims(sender_user_id, created_at desc);

create index if not exists idx_payments_p2p_claims_recipient_phone
  on payments_p2p_claims(recipient_phone, status);

create index if not exists idx_payments_p2p_claims_status_expires
  on payments_p2p_claims(status, expires_at)
  where status = 'pending';
