-- Admin-controlled wallet provider.
--
-- WALLET_PROVIDER lived only in the environment, so changing custody provider
-- meant editing Render config and redeploying. That is the wrong shape for an
-- operational decision, and it is the same argument that moved the NGN
-- provider and the verification ceilings into the database.
--
-- What makes this SAFE to change at runtime: every wallet row already records
-- the provider that issued it. So switching the default affects which provider
-- issues the NEXT wallet, and never orphans an existing one - a Bridge wallet
-- keeps resolving to Bridge even after the default becomes Privy.
--
-- Deliberately NULL by default. A null value means "fall back to the
-- WALLET_PROVIDER environment variable", so this migration changes no
-- behaviour on its own and a deployment that never touches the admin toggle
-- keeps working exactly as before.
create table if not exists payments_wallet_controls (
  id text primary key,

  -- 'privy' | 'bridge' | 'mock'. NULL = use the environment.
  active_provider text,

  -- Recorded because switching custody provider is a decision a regulator or
  -- an incident review will ask about, and "someone changed it" is not an
  -- answer.
  reason text,
  updated_by text not null default 'system',
  updated_at timestamptz not null default now()
);
