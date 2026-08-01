-- Admin-controlled verification ceilings.
--
-- The ceilings lived only in FLOW_LIMITS, a hardcoded table in
-- src/kyc/types/verification.types.ts. Changing one meant a code change and a
-- deploy, which is wrong for a number that has to move with the business.
--
-- The concrete failure that forced this: Breet's live minimum deposit is $50,
-- about NGN 80,000, while the BANK-level off-ramp ceiling was NGN 50,000 per
-- 30 days. A Level 1 user therefore could not clear a SINGLE withdrawal - the
-- smallest transaction the provider accepts was larger than the most the
-- policy allowed them to move in a month. No frontend work could fix that.
--
-- Stored as a sparse override table rather than a full copy of FLOW_LIMITS:
-- a row exists only where an admin has deliberately departed from the default.
-- That keeps the shipped defaults meaningful, makes "what has been changed"
-- answerable in one query, and means a bad override is deleted rather than
-- reconstructed.
--
-- NULL cumulative_ngn means UNLIMITED, matching FLOW_LIMITS where ENHANCED
-- carries null. It is distinct from 0, which means the flow is closed at that
-- level. Both are legitimate settings, so the column is nullable and the
-- absence of a ROW - not a null value - is what means "use the default".
create table if not exists payments_verification_limit_overrides (
  id text primary key,

  -- Matches FlowType: 'escrow' | 'offramp' | 'onramp'.
  flow text not null,

  -- Matches RailFamily: 'ngn' | 'foreign'.
  rail text not null,

  -- Matches VerificationLevel: 0 NONE, 1 BANK, 2 IDENTITY, 3 ENHANCED.
  level integer not null,

  -- NULL = unlimited. 0 = closed. Any positive value = the 30-day ceiling.
  cumulative_ngn numeric(20, 2),

  -- Who moved a compliance limit, and why. A regulator asking "why was this
  -- user allowed NGN 2,000,000" needs an answer that is not "someone changed
  -- it at some point".
  reason text,
  updated_by text not null default 'system',
  updated_at timestamptz not null default now(),

  -- One override per combination. Upsert on this rather than accumulating
  -- rows, so the effective limit is never ambiguous.
  constraint payments_verification_limit_overrides_unique unique (flow, rail, level)
);

create index if not exists payments_verification_limit_overrides_lookup
  on payments_verification_limit_overrides (flow, rail, level);
