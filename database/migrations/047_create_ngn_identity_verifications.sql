-- LEVEL 2: BVN IDENTITY VERIFICATION, PERSISTED.
--
-- The BVN provider, service and route already existed and worked - a user
-- could submit their details and Monnify would answer 'matched'. Nothing was
-- written down. grep showed the service touching the database zero times, so
-- the result lived only in the HTTP response: refresh the page and the user was
-- Level 1 again, with no record that they had ever verified.
--
-- Same shape as the deposit confirmer: the machinery was built and nothing
-- persisted its outcome, so the feature could never actually take effect.
--
--
-- THE BVN ITSELF IS NOT STORED. THIS IS THE POINT OF THE TABLE'S DESIGN.
--
-- A Bank Verification Number is the single most sensitive identifier a
-- Nigerian holds - it links every bank account they own. Storing 11 digits in
-- plaintext turns any future database leak into an identity-theft incident for
-- every verified user, and Sivan gains nothing by keeping it: the provider has
-- already answered the only question we asked ("does this BVN match this
-- person?"), and re-asking means re-submitting, not re-reading our own row.
--
-- What is stored instead:
--   bvn_last4       enough for support to confirm "the one ending 4821"
--   bvn_hash        SHA-256, so the SAME BVN registering twice is detectable
--                   without the value being recoverable
--
-- The hash is deliberately of the bare BVN with a server-side pepper, not a
-- per-row salt: the whole purpose is cross-user comparison, and a per-row salt
-- would make two identical BVNs hash differently and defeat it.
create table if not exists payments_ngn_identity_verifications (
  id text primary key,
  user_id text not null,

  -- 'bvn_info' today. Named rather than assumed so a later NIN check, or the
  -- BVN-to-account ownership check the provider already supports, is a new
  -- value here instead of a new table.
  check_type text not null default 'bvn_info',

  -- matched | review | failed, straight from KycLevelMatchStatus.
  --
  -- 'review' is stored, not discarded. A provider that cannot decide is a case
  -- a human must pick up, and without a row there is no queue to pick it up
  -- from - the user would simply see nothing happen.
  status text not null,

  provider text not null,
  provider_reference text,

  bvn_last4 text,
  bvn_hash text,

  -- Which individual fields the provider matched (firstName, dateOfBirth...).
  -- Kept because a 'review' outcome is unreadable without it: "name matched,
  -- date of birth did not" is actionable, "review" alone is not.
  matched_fields jsonb,

  -- Set only on a matched row. This is what deriveLevel() reads, so it is the
  -- single fact that grants Level 2 - separate from created_at, because a
  -- failed attempt also has a created_at and must never be mistaken for one.
  verified_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The hot query: "is this user identity-verified?", asked on every
-- verification-summary and every NGN quote. Without it that is a sequential
-- scan on a table holding a row per attempt.
create index if not exists payments_ngn_identity_verifications_user_idx
  on payments_ngn_identity_verifications (user_id, created_at desc);

-- ONE verified identity per user. A partial unique index rather than a plain
-- one, because failed and review attempts are expected to repeat - only the
-- SUCCESS is singular. Without this a retry storm could write several
-- verified rows and the "when did they verify" answer becomes ambiguous.
create unique index if not exists payments_ngn_identity_verifications_verified_uq
  on payments_ngn_identity_verifications (user_id, check_type)
  where verified_at is not null;

-- Detects one BVN being used by several accounts, which is the fraud pattern
-- this check exists to catch. NOT unique: a legitimate re-verification after a
-- failed attempt would collide, and blocking that would strand a real user.
create index if not exists payments_ngn_identity_verifications_bvn_hash_idx
  on payments_ngn_identity_verifications (bvn_hash)
  where bvn_hash is not null;
