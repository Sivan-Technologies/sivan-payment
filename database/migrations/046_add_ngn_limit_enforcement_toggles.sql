-- PER-FLOW ENFORCEMENT SWITCHES FOR VERIFICATION-TIER CEILINGS.
--
-- Three columns, deliberately, and NOT one master "limits off".
--
-- A global kill switch removes every ceiling for every user with one click,
-- and it is exactly the control that gets flipped during an incident and never
-- flipped back. Limits are the compliance boundary; they should not have a
-- single point of total failure. Per-flow also means loosening on-ramp cannot
-- silently uncap off-ramp - the riskier direction, since off-ramp turns crypto
-- of unknown origin into naira.
--
-- DEFAULT TRUE, unlike 045's external_funding_enabled which defaults false.
-- The safe direction differs per control: hiding a confusing UI is safe by
-- default, whereas a control whose whole job is to REFUSE must enforce when
-- nobody has said otherwise. An un-seeded deployment therefore applies limits.
--
-- NOT NULL so the adapter never sees a null it has to interpret. The mapper
-- still uses `?? true` rather than Boolean() as belt and braces: Boolean(null)
-- is false, which would silently uncap every flow on any row that predates
-- this migration.
alter table payments_ngn_controls
  add column if not exists limit_enforcement_offramp boolean not null default true;
alter table payments_ngn_controls
  add column if not exists limit_enforcement_onramp boolean not null default true;
alter table payments_ngn_controls
  add column if not exists limit_enforcement_escrow boolean not null default true;
