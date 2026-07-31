-- Admin toggle for NIN/BVN identity verification.
--
-- Defaults to FALSE. No NIN/BVN provider is integrated yet, so requiring
-- identity would strand every user at verification Level 1 with no way to
-- clear it. With this off, Level 2 is reachable on the bank check alone.
--
-- Deliberately a visible, auditable switch rather than a hardcoded constant:
-- an admin can see it is off, and turning it on is one toggle once a provider
-- exists.
alter table payments_ngn_controls
  add column if not exists identity_verification_enabled boolean not null default false;
