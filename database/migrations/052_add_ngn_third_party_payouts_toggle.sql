-- Admin switch for paying a naira account that is NOT the user's own.
--
-- Defaults to FALSE, and that is the whole point of shipping it now: the
-- withdraw screen is about to offer a "Pay someone else" choice, and the
-- control that governs it must exist and be provably closed BEFORE the choice
-- appears. A feature that ships ahead of its off switch cannot be turned off
-- during the incident that makes you want to.
--
-- WHY THIS IS OFF AND NOT MERELY UNBUILT.
--
-- Breet cannot settle to an arbitrary account. It is deposit-address-centric:
-- one PERMANENT address per user per asset, and the destination bank is bound
-- to the WALLET, not to a transfer -
--
--     PUT /trades/wallets/{id}/bank              (bankId + accountNumber)
--     PUT /trades/wallets/{id}/auto-settlement
--
-- Paying a third party on this rail would mean re-linking the user's permanent
-- wallet to the recipient's bank before each transfer. Because the address is
-- reusable, a late or duplicated deposit then settles to WHOEVER WAS LINKED
-- LAST - so one user's own withdrawal could land in a stranger's account
-- because of a re-link that happened after they pressed send. Two withdrawals
-- in flight over one wallet is a race by construction.
--
-- So this column is not a placeholder for a half-built feature. It is the
-- gate that keeps a genuinely unsafe path shut until a provider exists that
-- takes the destination per payout.
--
-- NOT NULL DEFAULT FALSE, matching 045 and 032. Existing rows get the closed
-- behaviour with no backfill, and no deployment window where the column is
-- null and the adapter's Boolean() coerces an unknown into a silent false.
alter table payments_ngn_controls
  add column if not exists third_party_payouts_enabled boolean not null default false;

-- Close it on environments that already hold a migration-seeded row.
--
-- `add column ... default false` only governs rows created from here on. An
-- environment whose payments_ngn_controls row predates this file keeps
-- whatever the column default gave it - which is false today, but this UPDATE
-- states the launch posture explicitly rather than relying on that coincidence
-- surviving a future edit to the insert above.
--
-- `where updated_by = 'migration'` is the entire safety of this statement, for
-- the reason spelled out in 050: db-migrate.ts re-runs every migration on
-- EVERY deploy with no ledger. Without that predicate this would switch
-- third-party payouts off on every deploy, silently undoing an operator who
-- had turned them on from the admin hub minutes earlier. Once a human saves
-- the controls, updated_by becomes their identity and this stops matching
-- forever.
--
-- Idempotent by construction: after it runs the row still satisfies the
-- predicate but the value is already false, so re-running changes nothing.
update payments_ngn_controls
   set third_party_payouts_enabled = false
 where id = 'global'
   and updated_by = 'migration';
