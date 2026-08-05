-- PER-USER LIMIT OVERRIDES
--
-- Until now a limit could only be changed for a whole TIER: the
-- payments_verification_limit_overrides table is keyed (flow, rail, level), so
-- raising one customer's ceiling meant raising it for every user at that
-- level. Support's most ordinary request - "this verified merchant needs a
-- higher cap this month" - had no answer that did not also lift the cap for
-- every stranger on the platform.
--
-- One row per (user, flow, rail). NOT per level: the override is a statement
-- about a PERSON, and it must not silently stop applying because they
-- completed another verification step and moved up a level.
--
-- cumulative_ngn NULL means UNLIMITED, and is deliberately different from 0,
-- which closes the flow entirely. Both are legitimate instructions, so the
-- column is nullable and the API refuses to guess between them.
CREATE TABLE IF NOT EXISTS payments_user_limit_overrides (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  flow             TEXT NOT NULL,
  rail             TEXT NOT NULL,
  cumulative_ngn   NUMERIC,

  -- WHY, and WHO. A limit exception is an AML-relevant act: an examiner asking
  -- "why did this account move 20x the tier ceiling" must get an answer from
  -- the database, not from somebody's memory. reason is NOT NULL for that
  -- reason - the API rejects a blank one rather than storing an empty string.
  reason           TEXT NOT NULL,
  updated_by       TEXT NOT NULL,

  -- An exception that cannot expire becomes permanent by accident. NULL is
  -- allowed (a genuinely permanent uplift for an institutional client), but
  -- the admin UI defaults to a date so the safe option is the easy one.
  expires_at       TIMESTAMPTZ,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Upsert target. Two overrides for the same user and flow would make
  -- "which one applies" a question about row order.
  CONSTRAINT payments_user_limit_overrides_unique UNIQUE (user_id, flow, rail)
);

CREATE INDEX IF NOT EXISTS payments_user_limit_overrides_user_idx
  ON payments_user_limit_overrides (user_id);

-- WINDOW RESETS, kept separately from overrides ON PURPOSE.
--
-- Raising a ceiling and forgiving spend already counted are different acts
-- with different risk. An override says "this person may go higher"; a reset
-- says "the 30 days of volume we already recorded no longer count against
-- them". Storing the second as a mutation of the first would destroy the
-- evidence that it happened.
--
-- Nothing is deleted here. The reset records a WATERMARK, and the usage
-- calculation ignores transactions at or before it. The underlying
-- transactions stay exactly where they are, which is what keeps the audit
-- trail intact and lets a reset be explained - or reversed - later.
CREATE TABLE IF NOT EXISTS payments_user_limit_resets (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  flow           TEXT NOT NULL,
  rail           TEXT NOT NULL,
  -- Volume recorded at or before this instant does not count toward the limit.
  reset_at       TIMESTAMPTZ NOT NULL,
  -- What was forgiven, captured at the moment of the reset. Recomputing it
  -- later is impossible once the window rolls.
  forgiven_ngn   NUMERIC NOT NULL DEFAULT 0,
  reason         TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_user_limit_resets_user_idx
  ON payments_user_limit_resets (user_id, flow, rail, reset_at DESC);
