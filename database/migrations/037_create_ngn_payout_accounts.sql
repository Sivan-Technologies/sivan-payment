-- Nigerian payout accounts, with the name-match verdict that justifies Level 1.
--
-- WHY A NEW TABLE RATHER THAN payments_external_accounts
--
-- External accounts are Bridge-shaped. account_type is 'us' | 'gb' | 'iban' |
-- 'unknown' and the row carries a routing number, a sort code or an IBAN. A
-- NUBAN is none of those: it is a bare ten-digit number plus a provider-
-- specific bank id, and the provider id is the part that matters - a Breet
-- bank id handed to PajRamp resolves to the wrong bank or to nothing.
--
-- Forcing a NUBAN into that table would mean account_type 'unknown' with the
-- real identifiers buried in the raw payload, which is precisely the shape
-- that makes a payout silently go somewhere else two years from now.
--
-- WHAT THIS TABLE IS ACTUALLY FOR
--
-- Until now a resolved account name was shown to the user and thrown away.
-- Nothing was stored, so nothing could be matched, and Level 1 was never
-- actually granted by the Nigerian path - the modal confirmed and reloaded.
-- This is the record that makes the bank check evidence instead of theatre.
create table if not exists payments_ngn_payout_accounts (
  id text primary key,
  user_id text not null,

  -- Which provider's directory this bank id came from. WITHOUT THIS THE ROW IS
  -- DANGEROUS: bank ids are not portable, so a row saved under Breet and later
  -- read while NGN_PROVIDER=paj would pay a different bank with the same id.
  -- Recorded per row rather than read from the environment at payout time,
  -- because the environment can change after the account is saved.
  provider text not null,
  bank_id text not null,
  bank_name text,

  -- Stored in full, not masked. This is a payout destination - the exact
  -- digits are needed to send money, and a masked value cannot be un-masked.
  -- Display masking is the UI's job.
  account_number text not null,

  -- The name the BANK returned. Since the CBN directive of 1 March 2024 a
  -- Nigerian account cannot transact without BVN/NIN linkage, so this name was
  -- verified by a licensed bank - that is the entire basis of Level 1.
  account_name text not null,

  -- The name the USER declared at signup, captured AT THE TIME OF THE MATCH.
  -- Denormalised on purpose: users.full_name can be edited afterwards, and a
  -- verdict has to remain auditable against what was actually compared. A
  -- reviewer looking at this row in six months needs the inputs, not today's
  -- values.
  declared_name text not null,

  -- 'match' | 'review' | 'mismatch'. Only 'match' grants Level 1; see
  -- nameMatchGrantsVerification. 'review' is PENDING, not verified - treating
  -- pending as verified would let every partial through while looking enforced.
  match_verdict text not null,
  match_score numeric(4,3) not null default 0,
  match_explanation text,
  matched_tokens jsonb,
  unmatched_bank_tokens jsonb,

  -- False when the resolution came from a sandbox. Breet's development
  -- environment returns a plausible name for ANY account number - verified
  -- live: 0000000000 at UBA resolved to "Samuel Udochukwu". A match against a
  -- fabricated name is not evidence, so this must gate the grant. Without it
  -- every sandbox user would silently hold real Level 1.
  resolution_trustworthy boolean not null default false,

  -- 'pending_review' | 'verified' | 'rejected'.
  status text not null default 'pending_review',

  -- Who cleared or refused a review case, and why. A human decision that
  -- unlocks withdrawal limits is exactly what an audit asks about.
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,

  raw_provider_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The hot path: "does this user have a verified payout account?" runs on every
-- verification-state read, which runs on every quote.
create index if not exists idx_ngn_payout_accounts_user
  on payments_ngn_payout_accounts(user_id);

-- The admin review queue.
create index if not exists idx_ngn_payout_accounts_status
  on payments_ngn_payout_accounts(status)
  where status = 'pending_review';

-- One row per (user, provider, bank, account). Re-submitting the same account
-- must update the existing row rather than accumulate duplicates - otherwise a
-- user who was rejected could simply resubmit until a fresh row appeared, and
-- the review queue would fill with copies of the same decision.
--
-- Scoped by provider because the same bank under Breet and PajRamp has
-- different ids, and those are genuinely different rows.
create unique index if not exists idx_ngn_payout_accounts_unique
  on payments_ngn_payout_accounts(user_id, provider, bank_id, account_number);
