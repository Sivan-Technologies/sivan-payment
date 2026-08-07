# BVN providers: Monnify and Flutterwave

Companion to `KYC-DESIGN.md`. That document decides *what* Layer 1 is; this one
covers *who answers it* and the traps in each vendor.

---

## 1. Why two providers

BVN verification is the gate on Level 2, and Level 2 is what lifts a Nigerian
user from NGN 100,000 to NGN 5,000,000 per 30 days. A single vendor there is a
single point of failure on every Nigerian's limits: if Monnify is down,
rate-limited, or wrong about a valid BVN, nobody can reach Level 2 and there is
no lever to pull.

Both providers implement the same `KycLevelProvider` interface
(`src/kyc/providers/kyc-level-provider.ts`), so switching is one environment
variable and no code change:

```
KYC_LEVEL_PROVIDER = mock | monnify | flutterwave
```

They are **not** interchangeable in capability. Read §4 before switching.

---

## 2. Flutterwave: consent is not a lookup

This is the single most important fact about the Flutterwave integration, and
the thing most likely to be got wrong by someone reading only the happy path.

The CBN requires a merchant to obtain the BVN owner's **consent** before
reading their data. NIBSS enforces it. So Flutterwave v3 is a multi-step,
**asynchronous, human-in-the-loop** flow:

```
1. POST /v3/bvn/verifications  { bvn, firstname, lastname, redirect_url }
     -> { data: { url, reference } }

2. The CUSTOMER opens `url`, enters an OTP on a NIBSS page, and chooses
   what to share.                          <- a human, in a browser, later

3. NIBSS redirects them to redirect_url.

4. GET /v3/bvn/verifications/{reference}
     -> { data: { status: "COMPLETED", bvn_data: {...} } }
```

Steps 2–3 cannot be awaited by a server-side function. **`verifyBvnIdentity()`
therefore cannot return `matched` on the first call**, and it does not: it
returns `review` with the consent URL in `matchedFields.consentUrl`, plus the
`providerReference` needed to collect the result. The match is settled later by
`completeBvnConsent(reference, claimed)`.

> **The catastrophic shortcut.** Reading "HTTP 200 + `status: success`" from
> step 1 as a pass would grant Level 2 — and a NGN 5,000,000 ceiling — to
> anyone who typed eleven digits, with no consent and no verification. The
> initiation response looks maximally successful, which is exactly what makes
> it dangerous. `scripts/test-flutterwave-bvn.ts` asserts this cannot happen,
> and mutation-testing confirms the assertion bites.

### Returning customers get a null URL

If the customer has consented to this merchant before, `data.url` comes back
`null` and there is nothing to approve. The provider detects this and collects
the result immediately rather than redirecting them to a page that does not
exist.

### Enablement

Flutterwave gate this feature per account. Email **hi@flutterwavego.com** to
request approval before it will work in production.

---

## 3. Configuration

```bash
KYC_LEVEL_PROVIDER=flutterwave
FLUTTERWAVE_SECRET_KEY=FLWSECK-...
# Where NIBSS returns the customer. A FRONTEND page, not an API route -
# this is a human in a browser, and they must land on something renderable.
FLUTTERWAVE_BVN_REDIRECT_URL=https://app.sivantech.online/verification

# Optional. Defaults are correct for production.
FLUTTERWAVE_BASE_URL=https://api.flutterwave.com
FLUTTERWAVE_V2_BASE_URL=https://api.ravepay.co
FLUTTERWAVE_BVN_ALLOW_V2_DIRECT=false
```

`isKycLevelProviderConfigured()` requires the key **and** the redirect URL. A
key alone is not enough: without a redirect the consent call is refused, so
reporting "configured" would put a Level 2 button on screen that throws the
moment a user presses it.

> **Boolean env vars must use `booleanFromEnv`, never `z.coerce.boolean()`.**
> `z.coerce.boolean()` is JavaScript truthiness, so the *string* `'false'` is a
> non-empty string and coerces to **`true`**. Writing
> `FLUTTERWAVE_BVN_ALLOW_V2_DIRECT=false` would have silently *enabled* the
> no-consent path — the exact opposite of the operator's instruction, on a
> compliance switch. This shipped and was caught by a test that expected v3 and
> saw v2.

---

## 4. Capability differences — read before switching

| Check | Monnify | Flutterwave |
|---|---|---|
| BVN → identity (name, DOB, phone) | ✅ one synchronous call | ✅ but **consent flow**, async |
| BVN → bank account ownership | ✅ `bvn-account-match` | ❌ not offered |
| Customer consent (CBN) | n/a for its endpoint | ✅ built in (v3) |
| Cost | per contract | **₦50 per call**, from wallet balance |

`FlutterwaveKycLevelProvider.verifyBvnBankAccount()` **throws** rather than
returning a cheerful `matched`. Inventing a verification that never happened is
worse than an error message naming the provider that can actually do it.

**Cost note:** ₦50 per call, billed against the Flutterwave wallet. A failing
integration that retries is a *spending* bug, not just a broken one — which is
why nothing in the provider retries on its own.

---

## 5. Matching rules

Implemented in `decideFlutterwaveStatus()`. Every unknown path lands on
`review`, never `matched`, because the failure mode of guessing is granting a
NGN 5,000,000 ceiling to an unverified person.

- **Watchlisted is never a pass.** NIBSS returns a `watchlisted` field. It is
  checked *first* so no later branch can talk past it, and the flag is recorded
  for the reviewer. A perfect name match on a watchlisted BVN is `review`.
- **Name is load-bearing.** Either name disagreeing is `failed` — a different
  person, whatever else lines up.
- **Missing ≠ mismatched.** A field NIBSS did not return is absent from
  `matchedFields`, not `false`. "We could not check this" and "this disagreed"
  are different findings and only one is evidence.
- **DOB formats differ.** NIBSS sends `1976-11-30`; the Sivan form sends
  `30-11-1976`. Both are accepted.
- **Phone formats differ.** `08169835630` and `+2348169835630` are the same
  number. NIBSS also routinely leaves `phoneNumber1` null and fills
  `phoneNumber2`, so both are read.

---

## 6. What must never be stored

The NIBSS record is far richer than the question being asked. A completed
response contains, among other things:

```
bvn, nin, email, gender, faceImage (base64 JPEG), dateOfBirth,
phoneNumber1/2, maritalStatus, stateOfOrigin, lgaOfResidence,
enrollBankCode, watchlisted, ...
```

**Persist only the last 4 digits and a peppered HMAC-SHA256 of the BVN**, as
`ngn-identity-verifications` already does (migration 047). Storing that blob
would convert a verification step into a data-breach liability, and it is
exactly the kind of thing that gets written "temporarily" for debugging.
`KYC-DESIGN.md §7` says the same: *store the provider's reference and result,
not raw NIN/BVN or ID images.*

---

## 7. The v2 direct lookup, and why it is off

Flutterwave v2 (`GET /v2/kyc/bvn/{bvn}?seckey=...`) returns BVN details in one
call with **no consent step**. It is simpler, and it is the wrong default: the
CBN expects consent before a merchant reads BVN data.

It is reachable behind `FLUTTERWAVE_BVN_ALLOW_V2_DIRECT=true` for accounts that
still have it enabled, because a silent fallback would be worse — skipping
consent is a compliance decision, and it should be one an operator makes
knowingly and can be audited on. When enabled:

- results carry `consentObtained: false` and `apiVersion: 'v2'`
- `health()` returns a **WARNING** in its message

---

## 8. Testing

```bash
npm run test:flutterwave-bvn     # 48 assertions
```

Flutterwave's sandbox BVN credentials are in their
[testing docs](https://developer.flutterwave.com/v3.0/docs/testing#bvn-credentials).
On the NIBSS sandbox consent page choose the **email** option and enter OTP
`111111` to approve.

Five mutations were verified to break assertions: returning `matched` before
consent, ignoring the watchlist flag, passing an empty record, dropping the
11-digit guard, and tolerating a name mismatch.

---

## 9. Status

| | |
|---|---|
| Provider implemented | ✅ `flutterwave-kyc-level.provider.ts` |
| Registered and selectable | ✅ `kyc-level-provider-registry.ts` |
| Unit tested | ✅ 48 assertions, 5 mutations |
| **Run against real Flutterwave** | ❌ **never** — no key held |
| Consent redirect page built | ❌ frontend must handle the return from NIBSS |
| Webhook receiver | ❌ polling `completeBvnConsent` only |

The last three are the remaining work. Until a real key exists, this is a
correct implementation of a documented API, not a proven integration — the
distinction that matters, and the same one that applies to the Bridge → Privy
sweep.
