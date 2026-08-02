# Production Privy signer — cutover runbook

Generated **2026-08-02**. Verified live against Privy, not assumed.

```
PRIVY_AUTHORIZATION_KEY_QUORUM_ID = l7t1bfi2oudgbebdszhkkt65   ("sivan-production")
PRIVY_AUTHORIZATION_PRIVATE_KEY   = see .env.production-signer  (gitignored, never committed)
```

## What was verified

| # | Check | Result |
|---|---|---|
| 1 | Quorum exists, threshold 1 | `l7t1bfi2oudgbebdszhkkt65` "sivan-production" |
| 2 | Private key parses as P-256 PKCS#8 | yes |
| 3 | Wallet created with the new signer attached | `0x913C871599952d269Fa1Bcfe2EAeC150119DFd41` |
| 4 | Binding survives a re-read of the wallet | `bound=true` |
| 5 | **New key can actually sign** (`personal_sign`) | **HTTP 200**, real signature returned |
| 6 | **Old test key on the same wallet** | **HTTP 401** |

Step 5 is the one that matters. A registered quorum proves nothing about
whether the private half works — only a signed request does. Step 6 proves the
isolation is real: the old `sivan-base-e2e` key cannot touch a wallet issued
under the new quorum.

## The state of existing wallets

Counted live on the Privy app, all 258:

```
258  total wallets
 33  bound to the TEST quorum (dx66hdbkkv1tm82jpyort0pq)
167  no signer at all
 58  bound to some other quorum
```

**A wallet's signer is fixed at creation and cannot be changed.** `PATCH
/v1/wallets/{id}` returns 401 even when signed by the key being added, because
adding a signer requires the *owner's* signature, which Sivan does not hold.

So:

- The **33** test-bound wallets stay test-bound forever. They are e2e
  artifacts, not customers.
- The **167** with no signer can never be delegated to. The backend cannot move
  funds from them — `createTransfer` returns `pending_user_signature`.
- Everything created **after** the cutover binds to the production quorum.

None of this is recoverable by rotating the key later. That is precisely why
the cutover has to happen before real users exist.

## Cutover

Order matters. Setting the quorum without the private key, or the reverse,
leaves the service issuing wallets it cannot sign for.

1. **Set both variables together** on `sivan-payments-api-live` (and on the AWS
   instance when it replaces Render):

   ```
   PRIVY_AUTHORIZATION_KEY_QUORUM_ID=l7t1bfi2oudgbebdszhkkt65
   PRIVY_AUTHORIZATION_PRIVATE_KEY=<from .env.production-signer>
   ```

   Both are `sync: false` in `render.yaml`, so they live only in the dashboard
   and are not overwritten by a blueprint sync. That is deliberate — a
   hardcoded `value:` is re-applied on every sync and silently reverted
   `WALLET_PROVIDER` from `privy` to `bridge` once already.

2. **Deploy**, then confirm the running service agrees:

   ```
   GET /api/admin/wallets/health
   ```

   Expect `keyQuorumExists: true` and `delegatedSigningReady: true`. If either
   is false the key did not load — check for a mangled PEM (use the base64
   form; a raw PEM's newlines break dashboard env vars).

3. **Create one wallet through the live API and confirm it binds** to
   `l7t1bfi2oudgbebdszhkkt65`, not the old quorum. `linked_accounts` omits
   `additional_signers` entirely, so read `GET /v1/wallets/{id}` directly —
   the field is absent, not empty, and looks like "no signer" if you check the
   wrong place.

4. Only then let real users provision wallets.

## After launch

- **Do not delete the test quorum.** 33 wallets still reference it, and the
  e2e suite signs with it on Base Sepolia.
- The old key stays valid for those 33 wallets forever. Treat it as a live
  credential on testnet, not as revoked.
- If the production private key is ever lost, every wallet issued under it
  becomes permanently unsignable. There is no recovery path — Privy never
  received the private half. Back it up somewhere that survives losing the
  Render/AWS account.
