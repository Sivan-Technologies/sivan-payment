-- Whether Sivan holds a delegated signer on a wallet.
--
-- Stored rather than derived because it is IMMUTABLE at the provider and
-- therefore permanent per wallet. Privy attaches additional signers at wallet
-- creation and refuses to add one afterwards: the PATCH must be signed by the
-- wallet's owner, which is the user, and Sivan cannot produce that signature.
-- Verified live - an app-credentialled PATCH and one signed by the key being
-- added both return 401, and the signer list stays empty.
--
-- So two wallets from the same provider differ permanently, and the difference
-- decides whether an off-ramp is one tap or a manual send. The code has to be
-- able to tell them apart.
--
-- Defaults to FALSE, which is the correct reading of every EXISTING row: they
-- were created before delegated signing existed, so none of them has a signer
-- and none of them can ever gain one. They must be reprovisioned to become
-- delegated, which issues a NEW address.
alter table payments_user_wallets
  add column if not exists delegated_signing_enabled boolean not null default false;

alter table payments_user_wallets
  add column if not exists delegated_signer_id text;
