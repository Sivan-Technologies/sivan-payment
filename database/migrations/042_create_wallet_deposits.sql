-- INBOUND DEPOSITS HAD NO RECORD ANYWHERE.
--
-- A Sivan user sells on an exchange and withdraws USDC to their Sivan address.
-- That is the single most common way money ENTERS this product for the launch
-- market. Before this table, here is everything the system did about it:
--
--   nothing.
--
-- unified-balance.service.ts read a live chain balance and the number was
-- bigger than last time. No record was written, no row appeared in the
-- activity feed, and the user was never told. All six activity sources are
-- records Sivan CREATED - a deposit initiated by a stranger is in none of
-- them, which is why the feed's own docstring claiming "every way money moves"
-- was structurally false for the most common inbound path.
--
-- Worse: UnifiedAssetBalance.chainUnavailable exists precisely because RPC
-- reads fail. When one does, the deposit did not appear AT ALL, while the user
-- held an exchange receipt saying it was sent. There was no record in the
-- system with which to answer that support ticket.
--
--
-- THIS TABLE IS AN OBSERVATION LOG, NOT A LEDGER.
--
-- The boundary matters enough to state in the schema. Spendable balance still
-- comes from reading the chain in unified-balance.service.ts. These rows say
-- "this was observed, at this time, from this source" and nothing more. They
-- must never become a second authority on how much money a user has, because
-- two authorities on a balance is exactly the ledger-vs-chain drift documented
-- in LEDGER-VERDICT.md. Nothing in this migration credits anybody.
create table if not exists payments_wallet_deposits (
  id text primary key,
  user_id text not null,

  -- The wallet row this landed in, and the address denormalised alongside it.
  --
  -- Both, deliberately. wallet_id is the join; address is the historical fact.
  -- A wallet row can be closed, re-provisioned or re-filed under a different
  -- chain string - that last one is not hypothetical, every wallet in this
  -- deployment is stored as chain:'base' while walletsToProvision() calls it
  -- 'ethereum'. If we kept only the id, a deposit's "where did this arrive"
  -- would silently change meaning underneath it. The address is what the user
  -- copied into an exchange withdrawal form and is the thing they will quote
  -- back to support.
  wallet_id text not null,
  address text not null,

  chain text not null,
  asset text not null,

  -- HUMAN UNITS, six decimal places. Not wei, not lamports, not a bigint
  -- string. Both USDC and USDT use six decimals on every chain we support, and
  -- the rest of this codebase (money() in unified-balance.service.ts) already
  -- settled on six. Storing a raw chain integer here would mean every reader -
  -- the feed, the email, the notification - has to know each token's decimals
  -- to render it, and one of them eventually would not.
  amount text not null,

  -- Absent for the balance-poll detector, which sees a delta rather than a
  -- transaction. Present for every webhook-based detector. Nullable rather
  -- than defaulted so "we do not know" stays distinguishable from "empty".
  tx_hash text,
  sender text,
  block_number bigint,
  block_timestamp timestamptz,

  -- pending  - observed on chain, not yet final
  -- confirmed- final
  -- failed   - reverted after being observed
  status text not null default 'pending',

  -- balance_poll | rpc_webhook | privy_webhook | manual
  --
  -- Recorded per row, not inferred from current configuration, for the same
  -- reason payments_ngn_payout_accounts records its provider: the detector
  -- WILL be swapped (poll -> RPC webhooks -> possibly Privy), and when it is,
  -- the only way to reconcile the overlap window is to know which detector
  -- produced which row. Reading it from the environment at query time would
  -- relabel history every time the config changed.
  detection_source text not null,

  -- THE UNIQUE CONSTRAINT IS THE POINT OF THIS TABLE.
  --
  -- Every detector delivers at least once. Privy documents "at least once"
  -- with an eight-step retry schedule; RPC webhook vendors re-fire; a poller
  -- re-reads the same balance on every tick. A duplicate row here is a
  -- duplicated feed row and, far worse, a second "you received money" message
  -- for money received once - which in a payments product reads as either a
  -- double credit or a phishing attempt.
  --
  -- Enforced by the DATABASE, not by a check-then-insert in the service. A
  -- read-then-write races against itself the moment two detectors run
  -- concurrently, which is guaranteed during the poll -> webhook migration
  -- when both are deliberately live at once. The unique index makes the second
  -- writer fail with 23505, which the service catches and treats as "already
  -- known" - the only formulation that is correct under concurrency.
  --
  -- Key shape depends on what the detector can see:
  --   with a transaction:  chain:txHash:logIndex
  --   balance poll:        chain:address:asset:balance:windowStart
  --
  -- The poll form is deliberately coarse. Two real deposits inside one tick
  -- collapse into a single record. That is a known, documented limitation of
  -- that detector and it disappears the moment detection moves to webhooks; it
  -- is preferred over the alternative, because a missed second observation is
  -- recoverable from the chain while a duplicated one is not recoverable from
  -- the user's trust.
  idempotency_key text not null,

  -- Null means a notification is still OWED. The notifier stamps this to claim
  -- the row, so a crash between "email sent" and "row updated" cannot re-send,
  -- and a deposit is never announced twice. Not a boolean: the timestamp also
  -- answers "how long after arrival did we actually tell them", which is the
  -- number that matters if users start complaining the alert is slow.
  notified_at timestamptz,

  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists payments_wallet_deposits_idem_uq
  on payments_wallet_deposits (idempotency_key);

-- The feed queries by user, newest first. Without this it is a sequential scan
-- on every dashboard load, on the table that grows fastest.
create index if not exists payments_wallet_deposits_user_created_idx
  on payments_wallet_deposits (user_id, created_at desc);

-- The notifier's hot query: "deposits nobody has been told about yet".
-- Partial, because once notified a row is never a candidate again, and the
-- unnotified set stays small while the table grows without bound.
create index if not exists payments_wallet_deposits_unnotified_idx
  on payments_wallet_deposits (created_at)
  where notified_at is null;

-- The confirmer's hot query: pending deposits awaiting finality. Same
-- reasoning - pending is a transient state, so a partial index stays tiny.
create index if not exists payments_wallet_deposits_pending_idx
  on payments_wallet_deposits (created_at)
  where status = 'pending';
