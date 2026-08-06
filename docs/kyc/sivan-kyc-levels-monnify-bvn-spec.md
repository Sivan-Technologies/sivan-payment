# Sivan KYC Levels — Monnify BVN Review & Specification

Status: **Specification only — no implementation, no database change**

## 1. Context

Sivan currently uses regulated provider verification for core payment eligibility, and for Nigerian rails we also want a local identity confidence layer before allowing higher-risk NGN actions.

The proposed local Nigerian verification provider is Monnify VAS:

```txt
BVN + Account Name Match
POST /api/v1/vas/bvn-account-match

BVN Information Match
POST /api/v1/vas/bvn-details-match
```

Important Monnify notes from the provided information:

```txt
Both APIs are live only.
BVN + Account Match costs ₦10 per request.
BVN Information Match costs ₦10 per request.
```

Because these checks are live-only and paid, Sivan should run them only when they are needed, not on every page load or repeated form attempt.

---

## 2. Recommendation summary

Use **BVN Information Match** as the primary Level 2 identity verification.

Use **BVN + Account Match** as a secondary bank-ownership/payment-method verification, especially when the user adds or uses a Nigerian bank account for NGN withdrawal.

Recommended policy:

```txt
Level 1 = bank account resolver / account name check
Level 2 = BVN Information Match
Level 2 + bank ownership = BVN + Account Match for selected bank account
```

Do not treat bank resolver alone as full KYC. Bank resolver confirms account existence/name, but does not prove the user owns the identity strongly enough for higher-risk rails.

---

## 3. Why BVN Information Match should be primary Level 2

BVN Information Match can compare identity attributes:

```txt
BVN
firstName
lastName
dateOfBirth
mobileNo
```

This is stronger for identity verification because it checks the person, not just the bank account.

Use it to answer:

```txt
Does this BVN identity match the user profile Sivan has for this customer?
```

This is better for Level 2 KYC than only asking:

```txt
Does this BVN match this bank account name?
```

---

## 4. Where BVN + Account Match fits

BVN + Account Match should be used when the user is adding or using a payout bank account.

It answers:

```txt
Does the BVN match this specific bank account and account name?
```

This is useful for:

```txt
NGN withdrawal bank setup
first NGN withdrawal to a bank
high-value NGN withdrawal
account-change risk review
name mismatch review
```

It should not replace BVN Information Match as the main Level 2 identity check.

---

## 5. Recommended Sivan KYC levels

### Level 0 — Account access

Purpose:

```txt
Basic Sivan account ownership
```

Signals:

```txt
email OTP verified
active Sivan session
optional 2FA if enabled
```

Allows:

```txt
view dashboard
start onboarding
contact support
```

Does not allow:

```txt
payment movement
NGN ramp
supplier payout
```

---

### Level 1 — Bank account resolver / payout-name confidence

Purpose:

```txt
Low-friction Nigerian bank account confidence
```

Input:

```txt
bank code / bank id
account number
resolved account name
```

Possible providers:

```txt
Monnify bank resolver
Nomba bank resolver
Paystack resolver
PAJ bank resolve
```

Allows:

```txt
save payout bank candidate
pre-fill account holder name
show bank account confirmation UI
support/admin review signal
```

Does not allow by itself:

```txt
high-value NGN withdrawal
full local identity verification
unrestricted NGN rails
```

Reason:

```txt
A bank resolver verifies that the account exists and returns a name. It does not reliably prove identity ownership across all use cases.
```

---

### Level 2 — BVN Information Match

Purpose:

```txt
Local Nigerian identity verification for NGN rails
```

Provider:

```txt
Monnify BVN Information Match
POST /api/v1/vas/bvn-details-match
```

Input:

```txt
bvn
firstName
lastName
dateOfBirth
mobileNo
```

Decision:

```txt
pass = identity attributes match above threshold
review = partial match / phone mismatch / DOB mismatch / name fuzzy mismatch
fail = strong mismatch / invalid BVN / provider reject
```

Allows, if passed and other controls pass:

```txt
higher-confidence NGN on-ramp/off-ramp
one-click NGN withdrawal eligibility
reduced manual review for standard-value NGN withdrawals
```

Still requires:

```txt
Sivan account active
Bridge KYC approved when required by global product policy
account not restricted
transaction within limits
risk controls
```

---

### Level 2B — BVN + Bank Account Match

Purpose:

```txt
Bank ownership confidence for NGN payout destination
```

Provider:

```txt
Monnify BVN + Account Name Match
POST /api/v1/vas/bvn-account-match
```

Input:

```txt
bvn
bankCode
accountNumber
accountName
```

Use when:

```txt
user adds NGN bank account
user changes NGN payout bank
first NGN withdrawal to a bank
high-value NGN withdrawal
name/account mismatch risk flag
```

Allows:

```txt
mark bank account as BVN-matched
reduce payout destination risk
provide admin/support evidence
```

Does not by itself replace Level 2 identity check.

---

## 6. Proposed NGN rail eligibility rule

For standard NGN ramp access:

```txt
Sivan account verified
+ Bridge KYC approved / Sivan global KYC approved
+ Level 2 BVN Information Match passed
+ account not restricted
+ NGN provider controls enabled
```

For NGN withdrawal to bank:

```txt
standard NGN eligibility
+ Level 2B BVN + Account Match passed for selected bank
+ withdrawal within limits
+ 2FA/risk hold checks if applicable
```

For high value or risky cases:

```txt
manual review required even if BVN checks pass
```

---

## 7. Cost-control policy

Because each Monnify BVN check costs money, do not call Monnify repeatedly.

Recommended cost controls:

```txt
Do not run on page load.
Do not run while user types.
Run only when user submits Level 2 verification.
Run bank match only when bank account is submitted or first used.
Cache successful result.
Cache failed attempts with cooldown.
Limit attempts per user per day.
Admin can manually re-run with reason.
```

Suggested limits:

```txt
Level 2 BVN Information Match: max 3 attempts per user per 24h
BVN + Account Match: max 3 attempts per bank account per 24h
Admin rerun requires reason and audit log
```

---

## 8. Privacy and data handling

BVN is highly sensitive. Sivan should treat it as restricted PII.

Rules:

```txt
Never log raw BVN.
Never return raw BVN to frontend after submission.
Never store BVN in plaintext.
Never expose BVN in Admin Hub tables by default.
Never send BVN to Sivan AI.
Never include BVN in support ticket metadata.
```

If storage is required later, use:

```txt
encrypted BVN
BVN last4
BVN hash for duplicate detection
verification provider response summary
```

Admin display should show:

```txt
BVN: •••••••1234
Status: matched / review / failed
Checked at
Provider reference
```

Not:

```txt
full BVN
full DOB
full phone
raw provider response
```

---

## 9. Suggested request/response design

No implementation yet. Proposed future backend endpoints:

### Start Level 2 BVN verification

```http
POST /api/users/:userId/kyc/ngn-bvn/verify
```

Body:

```json
{
  "bvn": "12345678901",
  "firstName": "John",
  "lastName": "Doe",
  "dateOfBirth": "31-12-1990",
  "mobileNo": "08012345678"
}
```

Customer-safe response:

```json
{
  "status": "matched",
  "level": "ngn_level_2",
  "message": "Your Nigerian identity check was successful."
}
```

Do not return raw Monnify payload.

---

### Verify bank account ownership with BVN

```http
POST /api/users/:userId/kyc/ngn-bank-account/match
```

Body:

```json
{
  "bvn": "12345678901",
  "bankCode": "058",
  "accountNumber": "0123456789",
  "accountName": "John Doe"
}
```

Customer-safe response:

```json
{
  "status": "matched",
  "level": "ngn_bank_ownership",
  "message": "Your bank account was matched successfully."
}
```

---

## 10. Admin Hub view proposal

Admin Hub should show a clean identity panel:

```txt
Nigerian verification
- Level 1 bank resolver: passed / review / failed
- Level 2 BVN identity: matched / review / failed
- Bank ownership: matched / review / failed
- Last checked at
- Provider: Monnify
- Attempts today
- Manual review required: yes/no
```

Admin should not see raw BVN by default.

---

## 11. Decision matrix

| Situation | Action |
|---|---|
| BVN info match passes | Mark NGN Level 2 identity passed |
| BVN info partial mismatch | Manual review |
| BVN info fails | Block Level 2 and show customer-safe retry/support message |
| Bank resolver name differs slightly | Let user confirm, then BVN + Account Match or review |
| BVN + Account Match passes | Mark bank account BVN-matched |
| BVN + Account Match fails | Block that payout bank or manual review |
| Provider unavailable | Do not charge repeated attempts; show retry later |
| Too many attempts | Cooldown and support route |

---

## 12. Recommended answer to the product question

Use both, but not for the same job.

Primary Level 2 identity check:

```txt
BVN Information Match
```

Bank ownership / payout account check:

```txt
BVN + Account Match
```

Lean launch option:

```txt
Run BVN Information Match once for Level 2.
Run BVN + Account Match only when the user adds or first uses an NGN payout bank.
```

This gives strong identity confidence without unnecessary cost.

---

## 13. Open questions before implementation

Ask Monnify / confirm internally:

```txt
What exact match score fields are returned?
Are names returned as booleans, percentages, or detailed fields?
Does mobileNo require 080 format or +234 format?
Does dateOfBirth require dd-MM-yyyy only?
Can business users use BVN, or should this only apply to individuals?
What are failure/error codes for invalid BVN vs mismatch vs provider unavailable?
Are there daily/monthly VAS limits?
Is webhook/asynchronous verification ever used, or all synchronous?
```

---

## 14. Non-goals for this phase

No implementation in this spec.

No database migration in this spec.

No raw BVN storage in this spec.

No replacement of Bridge KYC in this spec.

No AI/Sivan Assistant access to BVN data.

No automatic Monnify calls on page load.
