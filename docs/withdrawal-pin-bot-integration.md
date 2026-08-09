# Withdrawal PIN — bot integration spec

Status: **backend done and verified. Bot PIN prompts are BLOCKED — and should stay blocked.
Do not implement §2 yet. Read the blocker first.**

The backend (migration 051, `withdrawal-pin.service.ts`, routes, `app.ts` auth wiring) is
complete: 22/22 on JSON, 17/17 on Postgres. Nothing enforces the PIN yet, so production
behaviour is unchanged today.

---

## ⛔ BLOCKER — neither bot moves money, so a PIN prompt would be theatre

Discovered while reading the handlers to implement §2. **Neither chat flow calls any execute
endpoint.**

- `Telegram-layer/src/handlers/cashout.ts` — imports exactly two API functions,
  `getPaymentBalance` and `getPaymentPayoutAccount`. Both reads. `summariseCashout` says so
  in as many words: *"I cannot complete the transfer from here."* It hands off to
  `/withdraw` on the web. **This flow is honest.**
- `whatsapp-bot/src/handlers/cashoutSwap.ts` — imports the *same two reads* and nothing
  else. No execute call exists in the file. Yet line 323 replies **"✅ Cash Out Initiated"**,
  with a reference from `Math.random()` (line 23), a fee hardcoded at 1.7% (lines 250, 320),
  and hardcoded bank details. **This flow claims money moved when nothing happened.**

### Why adding the PIN prompt now would make things worse, not safer

1. **There is nothing to authorise.** The step-up token is bound to an amount, currency and
   destination for a payout that never executes. It would be minted and left to expire.
   Zero security gained.

2. **It trains users to phish themselves.** Conditioning people to type their withdrawal PIN
   into a chat window — for an operation that moves no money — builds exactly the habit an
   attacker needs. Anyone who spoofs the bot, or impersonates it in a group, inherits a
   ready-made PIN-harvesting channel. On WhatsApp the message cannot even be deleted, so the
   PIN stays in the transcript on both devices.

3. **It would launder the false confirmation.** WhatsApp already tells users their cash out
   was initiated when it was not. Put a PIN ceremony in front of that and the claim becomes
   *credible* — the user just performed a security ritual, so of course they believe the
   money is moving. A PIN would convert a bug users might catch into one they will not.

### The correct order

The PIN belongs where money actually moves. Today that is the **web dashboard**, where the
user already holds a JWT and both `/api/users/me/withdrawal-pin` and the step-up token flow
work end to end. So:

1. **Fix the WhatsApp false confirmation.** It is a live integrity bug, independent of this
   feature, and more urgent than it. `cashout.ts` on Telegram is the model for honest copy.
2. **Wire the PIN into the web withdrawal path**, where a real payout exists to bind to.
3. **Only if and when a bot can genuinely execute a withdrawal**, revisit §2 below — with
   the group-chat and message-deletion rules in §4 treated as hard requirements.

§2 is left intact because it is correct *for the world where a bot can move money*. It is
simply not this world yet.

---

Everything below assumes that blocker is resolved. The ordering in §5 is a safety property,
not a preference.


---

## 0. Status of the prerequisites

1. ~~Is there a bot-reachable "does this user have a PIN?" route?~~ **RESOLVED — there was
   not, and now there is.** A `GET /api/users/me/withdrawal-pin` existed but sits behind
   `/api/users/me/`, a user-JWT path no bot can reach. `POST /api/identity/withdrawal-pin-status`
   was added for the bots (contract in §1). Verified: 22/22 assertions on JSON, including
   that it is reachable with only the service secret, refuses without it, and answers an
   unknown identity identically to a known account with no PIN.
2. **Still open: how each bot currently calls the withdrawal endpoint** —
   `Telegram-layer/src/services/sivanApi.ts` and `whatsapp-bot/src/services/sivanApi.ts`.
   Neither exposes an obvious cashout function (`grep` finds `savePayoutAccount` and
   `getPaymentPayoutAccount` but no withdraw/offramp submit), so find where the payout is
   actually submitted before planning where the token attaches. The Telegram handler calls
   `getPaymentBalance` and a local `readAvailable`, so the submit may be indirect.


---

## 1. Backend contract (verified — build against this exactly)

### Mint a token: `POST /api/identity/verify-pin`

```
headers: x-sivan-identity-link-secret: <IDENTITY_LINK_SERVICE_SECRET>
body:    { channel, identity, pin, amount, currency, destinationRef }
→ 200    { stepUpToken: string, userId: string }
```

- No user JWT required. This route is in the JWT-exemption list in `app.ts` on purpose —
  the bot is calling on behalf of a user who has no web session. (A missing exemption here
  was a real bug found by the test; it made the route return `auth_required` for every bot
  call. Do not "tidy" it back out.)
- Without the service secret → **403**. Anonymous callers cannot reach it.
- `amount`, `currency`, `destinationRef` are **not decoration** — they are hashed into the
  token's binding. Send the exact values the user confirmed. See §3.

### Set a PIN: `POST /api/users/me/withdrawal-pin`

```
headers: Authorization: Bearer <user JWT>
body:    { pin }
```

- **The service secret alone cannot set a PIN — 401.** This is the property that makes the
  PIN a real second factor: an attacker who steals the bot's secret still cannot mint one.
  Bots must therefore *never* collect a new PIN. They deep-link the user to the web app.
- Weak PINs are rejected server-side (`123456`, repeated digits, etc.). Surface the server's
  message rather than reimplementing the rules in each bot.

### Spend a token (backend-internal, §5)

```
consumeStepUpToken({ token, userId, amount, currency, destinationRef })
```

Single-use. Bound to user + amount + currency + destination. Rejections in §3.

---

## 2. Bot flow

```
… existing confirm step ("Withdraw ₦5,000 to GTB ****1234?")
      │
      ├─ group chat?  ──────────────► refuse (§4). Never prompt for a PIN in a group.
      │
      ├─ hasPin == false ──────────► "Set up a withdrawal PIN first: <deep link>"
      │                               Do not collect a PIN in chat. Abort the withdrawal.
      │
      └─ hasPin == true  ──────────► new state: AWAITING_PIN
                                        │
                       user sends 6 digits
                                        │
              ┌─────────────────────────┴──────────────────────────┐
              │ 1. delete the user's message immediately (§4)      │
              │ 2. POST /api/identity/verify-pin with the EXACT    │
              │    amount / currency / destinationRef confirmed    │
              │ 3. store stepUpToken in the session                │
              │ 4. proceed to the existing withdrawal call         │
              └────────────────────────────────────────────────────┘
```

**Session state to add** (both bots): `stepUpToken`, plus the `amount`/`currency`/
`destinationRef` that were confirmed. Clear all of it on success, cancel, timeout, or any
rejection — a stale token in a session is a loaded gun pointed at the next withdrawal.

**Do not log the PIN.** Not at debug level, not in an error path, not in a "raw update" dump.
Audit every logger call on the path you touch.

---

## 3. Rejections the bots must handle

These messages are the tested contract. Match on them, and surface them close to verbatim —
they were written to tell an honest user what to do and an attacker nothing.

| Server says | Means | Bot should |
|---|---|---|
| `That PIN is not correct.` | wrong PIN — **or** unknown identity, deliberately indistinguishable | re-prompt, decrement a local attempt display if you show one |
| `Too many incorrect PIN attempts…` | 5 failures → locked; the **correct** PIN is refused too | stop re-prompting, surface the lockout, abort the withdrawal |
| `…changed after you confirmed…` | amount **or** destination no longer matches the token binding | abort, restart the confirm step from scratch — never silently retry |
| `…already used…` | token replay | abort. Treat as a bug in your own flow, and log it (without the PIN) |
| `…needs your PIN` | token belongs to a different user | abort. Should be unreachable; log loudly |

Amount and destination mismatches share one message **on purpose** — a field-specific error
would let someone holding a captured token discover, field by field, what it was minted for.
Do not "improve" this by telling the user which field changed.

---

## 4. Group chats and message deletion

Both are security requirements, not polish.

- **Refuse in groups.** A PIN typed into a group chat is disclosed to every member and to
  the group's history. `Telegram-layer/src/groupSafety.ts` already exists and is the right
  place to hang this — reuse it rather than inventing a second check. Reply with a direct
  message or a "continue in DM" link; never prompt in-channel.
- **Delete the user's PIN message immediately** after reading it, before any network call,
  so a slow or failing backend cannot leave the PIN sitting in the chat. On Telegram this is
  `deleteMessage`. Handle the failure case: if deletion fails (missing permission, message
  already gone), still proceed, but tell the user to delete it manually — silently leaving a
  PIN in the transcript is the bad outcome.
- WhatsApp cannot delete a user's message. Say so plainly in the prompt ("we can't delete
  your message on WhatsApp — please delete it after sending") rather than pretending.

---

## 5. Enforcement — ship LAST, on its own deploy

Wiring `consumeStepUpToken` into the chat withdrawal path is the final step, and it must go
out **after both bots can prompt**. Reversing this order breaks withdrawals for every chat
user: the backend would demand a token that no bot knows how to mint.

Suggested rollout:

1. Deploy bots with prompting behind a flag, defaulted **off**.
2. Turn the flag on. Confirm real tokens are being minted (they are inert — nothing consumes
   them yet, so a bug here cannot block a withdrawal).
3. Only then deploy enforcement, and keep a kill switch.

At enforcement time the withdrawal path calls `consumeStepUpToken` with the **same** amount,
currency and destination it is about to execute — read them from the payout being performed,
not from whatever the bot echoed back. If those two can drift, the binding proves nothing.

---

## 6. Tests to add

Extend `sivan-payment/scripts/test-withdrawal-pin.ts` (run it on **both** providers —
`npm run test:withdrawal-pin` and `npm run test:withdrawal-pin:pg`, the latter needs a
`DATABASE_URL`; a local scratch DB `sivan_pin_test` already exists).

Per bot:

- [ ] a group-chat withdrawal never reaches the PIN prompt
- [ ] the user's PIN message is deleted (assert the delete call fired, and that a delete
      failure still does not strand the PIN silently)
- [ ] the PIN never appears in any log line on the happy path or any error path
- [ ] the token sent to the withdrawal call is the one minted for *that* confirmation
- [ ] changing the amount between confirm and PIN entry aborts with the "changed" message
- [ ] session state is cleared on success, cancel, timeout, and every rejection in §3
- [ ] a bot cannot set a PIN (assert the 401 from the bot's own credentials)

---

## 7. Notes carried over from the backend session

- `sivan-payment/.env` has `DATABASE_URL` pointing at a **Neon cloud database**. This test
  creates users and deliberately triggers lockouts — do not run it against that. Inline env
  vars do win (`dotenv.config()` has no `override`), which is why the Postgres run targets a
  local scratch DB.
- Scratch DB `sivan_pin_test` on local Postgres has all 51 migrations applied. Drop it with
  `dropdb -h 127.0.0.1 -U postgres sivan_pin_test` when finished.
- `app.ts` route-matching is shared by every route. After touching it, re-run at minimum:
  `test:withdrawal-pin`, `test:identity`, `test:telegram-pairing`, `test:auth-signup-signin`.
