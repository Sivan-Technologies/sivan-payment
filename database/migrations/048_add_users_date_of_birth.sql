-- DATE OF BIRTH ON THE USER, because Bridge will not take it any other way.
--
-- Bridge refuses to approve a customer whose `base`/`sepa` endorsements are
-- missing `date_of_birth` and `min_age_18`. Verified against the real sandbox:
-- a stuck customer showed
--
--   base incomplete  missing: ["date_of_birth", "min_age_18", "post_processing"]
--
-- and a single PUT /v0/customers/{id} {"birth_date":"1990-01-15"} moved both
-- into `complete`. Nothing else changed.
--
-- WHY THE COLUMN EXISTS AT ALL, rather than posting straight through to Bridge:
--
--   1. POST /v0/kyc_links SILENTLY IGNORES birth_date. Measured: sent it, got
--      201, read the customer back and birth_date was null with the
--      requirement still missing. So the value has to survive the create call
--      and be applied afterwards by a separate PUT - which means we have to
--      hold it somewhere.
--   2. The PUT can fail. Bridge can be down, or the customer can be created
--      and the follow-up lost to a restart. Without the value stored there is
--      nothing to retry from and the user has to be asked again.
--   3. Support needs it. "Why is this customer stuck" is answered by seeing
--      whether we ever had a date of birth for them.
--
-- STORED AS DATE, NOT TEXT. A date column rejects 1990-13-45 at the database
-- rather than passing it to Bridge to reject later, and it makes an age
-- comparison a comparison rather than string surgery.
--
-- NULLABLE. Nigerians verify by bank-name resolution and never create a Bridge
-- customer, so requiring this for everyone would block the cheaper path for
-- the majority of users to satisfy a provider they never touch.

alter table users
  add column if not exists date_of_birth date;

comment on column users.date_of_birth is
  'Declared date of birth. Forwarded to Bridge as birth_date to satisfy the date_of_birth and min_age_18 endorsement requirements. Not proof of age - Persona verifies it against a government ID.';
