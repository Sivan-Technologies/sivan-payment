-- WITHDRAWAL PIN AND STEP-UP TOKENS.
--
-- On the web a user is behind email + password + optional TOTP. On WhatsApp or
-- Telegram they are behind POSSESSION OF A PHONE NUMBER AND NOTHING ELSE. The
-- identity link in customer_identity_links never expires, so whoever controls
-- that SIM inherits a session that can move money and is never challenged
-- again. SIM-swap is the dominant account-takeover vector in the market Sivan
-- serves. The PIN restores a factor a SIM swap does not grant: something the
-- user KNOWS.
--
-- ONE PIN PER PAYMENT USER, NOT PER CHANNEL. `user_id` is the primary key, not
-- (user_id, channel). This is the whole point: a person has one PIN and it
-- works identically from WhatsApp, Telegram, and any channel added later.
-- Nobody is ever asked to "set up a PIN for Telegram" after already having one
-- for WhatsApp. A per-channel column is precisely the shape that lets two PINs
-- come into existence later, so the schema forbids it rather than relying on
-- everyone remembering.
--
-- WHY IT LIVES IN sivan-payment. This is the only service both bots already
-- agree owns the account. Putting the PIN in a bot would give one channel
-- authority over the other, and a third channel would mean either a third PIN
-- or a bot depending on another bot.

-- The PIN itself. Never the plaintext - only a salted scrypt digest, matching
-- the scrypt-sha256-v1 scheme already used for 2FA recovery answers in
-- two-factor.service.ts. A second hashing scheme is a second thing to get
-- wrong, so this deliberately introduces none.
create table if not exists withdrawal_pins (
  user_id text primary key references users(user_id) on delete cascade,
  pin_hash text not null,
  pin_salt text not null,
  algorithm text not null default 'scrypt-sha256-v1',

  -- Set on the web, never from chat. If the PIN could be set from a chat
  -- channel, an attacker holding that channel would simply set it themselves
  -- and the PIN would protect nothing: a factor is only a second factor if
  -- compromising the first does not yield it.
  set_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A PIN change is exactly what an attacker does after taking an account, so
  -- a change starts a withdrawal cooldown. Reads as "withdrawals from chat are
  -- held until this moment passes". Null means no cooldown in force.
  withdrawals_held_until timestamptz,

  -- Lockout after repeated wrong PINs. Counted here rather than in memory so a
  -- restart, or a second instance, cannot reset an attacker's budget - the
  -- in-memory pairing limiter is per-process and would be trivially defeated by
  -- Render's rolling deploys.
  failed_attempts integer not null default 0,
  locked_until timestamptz
);

comment on table withdrawal_pins is
  'One withdrawal PIN per payment user, shared by every linked chat channel. Set on the web only; verified from chat for money-moving actions.';
comment on column withdrawal_pins.pin_hash is
  'scrypt digest. The plaintext PIN is never stored, logged, or written to an audit record - audits say that a PIN was verified, never what was entered.';
comment on column withdrawal_pins.withdrawals_held_until is
  'Chat withdrawals are refused until this time. Set when the PIN changes, because a PIN change is the attacker''s first move after a takeover.';

-- STEP-UP TOKENS: the proof that a human presented the PIN just now.
--
-- The bots hold the identity service secret. If a withdrawal accepted that
-- secret by itself, a leaked secret would drain every account. So the secret
-- stays an AUTHENTICATION credential for the bot ("which service is calling"),
-- and AUTHORIZATION to move money requires a token that can only be minted by
-- presenting the user's PIN.
create table if not exists withdrawal_step_up_tokens (
  id text primary key,
  user_id text not null references users(user_id) on delete cascade,

  -- The token is stored hashed for the same reason a password is: a leaked
  -- database read must not yield a usable bearer credential.
  token_hash text not null unique,

  -- BOUND TO ONE ACTION, NOT A GENERAL SESSION. A token minted for a ₦5,000
  -- payout must not authorise ₦500,000, and one minted for the user's own bank
  -- account must not authorise a payout to an account added a minute ago.
  --
  -- The binding is a hash of the canonical (user, currency, amount,
  -- destination) tuple computed in code. Comparing a hash rather than the
  -- columns avoids ever asking whether 5000, 5000.00 and 5.0e3 are the same
  -- number - a numeric comparison that silently succeeds on a rounded value is
  -- exactly the bug that would let an attacker widen a token.
  binding_hash text not null,

  -- Readable copies, for support answering "what did this token authorise".
  -- Never used for the authorisation decision itself.
  channel text not null,
  amount_text text,
  currency text,
  destination_ref text,

  -- Single use. Consumed by setting used_at, so a replayed token is refused
  -- even inside its two-minute window.
  used_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

comment on table withdrawal_step_up_tokens is
  'Short-lived single-use proof that the account owner presented their PIN for one specific withdrawal. Required by the withdrawal endpoint in addition to the bot service secret.';
comment on column withdrawal_step_up_tokens.binding_hash is
  'sha256 over the canonical user/currency/amount/destination tuple. A withdrawal is authorised only when it recomputes to this exact value.';

create index if not exists idx_withdrawal_step_up_tokens_user on withdrawal_step_up_tokens(user_id);
create index if not exists idx_withdrawal_step_up_tokens_expires_at on withdrawal_step_up_tokens(expires_at);
