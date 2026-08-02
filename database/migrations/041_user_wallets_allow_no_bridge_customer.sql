-- A NIGERIAN COULD NEVER BE GIVEN A WALLET.
--
-- payments_user_wallets.payments_customer_id was declared
--
--     payments_customer_id text not null references payments_customers(id)
--
-- in 031, when a wallet existed only as "the wallet belonging to a Bridge
-- customer". That premise died when the Nigerian bank path shipped: a user who
-- verifies by NUBAN name check NEVER becomes a Bridge customer, so
-- ensureUserWallet() passed customerId = undefined and Postgres rejected the
-- row with 23502.
--
-- The user saw a bare 500 from POST /api/users/:id/wallets. No wallet means no
-- deposit address, which means no off-ramp and no on-ramp - the entire product
-- for the launch market, blocked by a column default written for the other
-- rail. Reproduced against the live test database:
--
--     null value in column "payments_customer_id"
--     of relation "payments_user_wallets" violates not-null constraint
--
-- The FOREIGN KEY is kept. It is still true that if a wallet does name a
-- Bridge customer, that customer must exist - dropping the reference would
-- allow a dangling id, which is a different bug. Only the NOT NULL goes,
-- because "this wallet has no Bridge customer" is now a legitimate state and
-- must be representable.
--
-- Guarded so the migration runner (which replays every file on every deploy,
-- see 036) can apply it repeatedly.
do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_name = 'payments_user_wallets'
       and column_name = 'payments_customer_id'
       and is_nullable = 'NO'
  ) then
    alter table payments_user_wallets
      alter column payments_customer_id drop not null;
  end if;
end $$;
