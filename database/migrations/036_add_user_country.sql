-- Which country a user is in, because it decides their entire verification path.
--
-- Nigeria verifies at Level 1 through bank-account name resolution: the CBN
-- directive of 1 March 2024 means a Nigerian account cannot transact without
-- BVN/NIN linkage, so a licensed bank has already checked the holder. That
-- evidence does not exist anywhere else - the resolver only understands
-- NUBANs - so a user in the US or the EU has no equivalent path and must
-- verify through Bridge instead.
--
-- Country was collected NOWHERE before this: not on the user, not on the
-- customer, not in the signup form, not in the KYC form. So there was nothing
-- to branch on, and every user was implicitly treated as Nigerian.
--
-- DECLARED, NOT PROVEN. This is a routing hint - it decides which flow a user
-- is shown, and nothing more. What a user is actually ALLOWED to do is decided
-- by verified evidence: a resolved NUBAN proves Nigeria, an approved Bridge
-- KYC proves whatever Bridge checked. Treating a dropdown as fact would let a
-- self-declared country gate a regulated decision.
--
-- Nullable on purpose. Existing users have no country and must not be blocked
-- or silently assigned one; they are prompted when they next verify.
alter table users
  add column if not exists country text;

-- ISO 3166-1 alpha-2, uppercase. Constrained rather than free text so 'NG',
-- 'Nigeria' and 'nigeria' cannot all coexist and silently route differently.
alter table users
  add constraint users_country_iso2
  check (country is null or country ~ '^[A-Z]{2}$')
  not valid;

create index if not exists idx_users_country on users(country) where country is not null;
