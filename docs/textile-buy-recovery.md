# Buy cNGN recovery

This change preserves the existing Textile Ramp buy flow. It does not create
ledger credits, provision accounts automatically, change swap execution, or
mark transfers completed. Status continues to come from Textile GET.

## Deployment prerequisites (not applied automatically)

- Apply `database/migrations/057_textile_buy_orders.sql` through the existing
  migration process after reviewing the migration ledger and backing up the DB.
- Configure `DATABASE_URL` for PostgreSQL.
- Configure `TEXTILE_BUY_STORAGE_KEY` as an independently generated 32-byte
  cryptographically random key encoded as 64 hexadecimal characters. Supply it
  through the server secret manager; never put it in Git or frontend variables.
- Keep a protected backup of the key. All API instances must use the same key.
  Changing it without re-encrypting existing rows prevents recovery of old
  credentials. This patch does not implement key rotation.
- `TEXTILE_CREDIT_API_URL` remains server configured and must be HTTPS, ending
  in the v2 base path (an existing `/ramp` suffix is also accepted).

No migration, deployment, environment update or live provider write is performed
by the tests. Missing storage/key/schema prevents booking a new purchase.

## Recovery and retry behavior

The wallet, chain, provider, amount and idempotency key are saved before booking.
A lost response leaves a recoverable intent. Only an explicit user retry calls
Textile again, using that same key. Retries for a saved result do not book again.
PostgreSQL row locking serializes same-key requests across API instances.

The provider response and claim token are encrypted with AES-256-GCM and bound
to the owner and intent as authenticated data. Signatures and KYC documents are
not stored in this table. A fresh wallet signature verified by Textile is required
before the recovery endpoint releases any stored result. Recovery is scoped to
the wallet and chain, independent of current new-purchase availability.

The UI lists up to 50 recent attempts. Selecting a saved purchase re-reads its
current status from Textile; the saved creation snapshot is not settlement proof.
Older orders created before this migration are not backfilled automatically:
existing session claim tokens still work, but a previously lost token is not
magically recoverable from Sivan's new table.

## Isolated verification

From `sivan-payment`:

```
node --import tsx scripts/test-textile-buy.ts
node --import tsx ../sivan-minipay-app/test/buy-view-session.test.ts
npm run typecheck
```

The backend test uses isolated embedded PostgreSQL (PGlite) and intercepted
provider responses. These prove local recovery/error behavior, not live Celo
support, valid real-wallet signatures at Textile, or delivered purchases.
Run the MiniPay production build separately with `npm run build`.
