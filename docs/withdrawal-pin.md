# Withdrawal PIN

Status: proposed. Owned by sivan-payment.

The PIN belongs to the **payment user**, not to a channel. One person has one
PIN, and it works identically from WhatsApp, Telegram, and any channel added
later. Nobody is ever asked to "set up a PIN for Telegram" after already having
one for WhatsApp.

This is why the PIN lives here rather than in a bot: sivan-payment is the only
service that both channels already agree is the owner of the account. Putting it
in a bot would give one channel authority over the other, and adding a third
channel would mean either a third PIN or a bot depending on another bot.

## Why a PIN at all, stated precisely

On the web a user is behind email + password + optional TOTP. On a chat channel
they are behind **possession of a phone number, and nothing else**.

That distinction is the whole argument. A WhatsApp or Telegram account is bound
to a SIM, and SIM-swap is the dominant account-takeover vector in the market
Sivan serves - not exotic, just a bribed insider at a telco shop. Today whoever
controls the SIM inherits a persistent session that can move money and is never
challenged again. A PIN restores a factor a SIM swap does not grant: something
the user KNOWS.

## Where the PIN is set

**Set on the web. Verified in chat. Never set from chat.**

If the PIN can be set from a chat channel, an attacker holding that channel
simply sets it themselves and the PIN protects nothing. A factor is only a
second factor if compromising the first does not yield it.

- Set / change / reset: web dashboard only, behind the existing session and
  TOTP. A change emails the user and starts a withdrawal cooldown.
- Verify: any linked channel, for money-moving actions only.
- No PIN set yet means no withdrawal from chat. The bot says so and deep-links
  to the web page. A deliberate gate, not a gap.

## The verification contract

Both bots call the same endpoint and neither stores or interprets the PIN.

```
POST /api/identity/verify-pin      (service secret)
  { channel: 'whatsapp' | 'telegram', identity, pin }
  -> { stepUpToken, expiresAt }    single use, ~2 minutes
```

The withdrawal call then requires that `stepUpToken`. This matters: **the
service secret alone must never be able to move money.** The bots hold that
secret, so if withdrawal accepted it by itself, a leaked secret would drain
accounts. Requiring a token that can only be minted by presenting the user's
PIN keeps the secret an *authentication* credential for the bot and leaves
*authorization* with the user.

Consequences to preserve:

- The token is bound to one payment user, one amount, and one destination. It
  is not a general session. A token minted for a ₦5,000 payout cannot authorise
  ₦500,000, and re-prompting is cheap.
- Verification failures are rate-limited and locked out per identity. Reuse
  `assertPairingAttemptAllowed` / `rejectPairing` / `clearPairingAttempts` from
  identity.service - it already fails closed without revealing whether the
  account exists.
- The response never distinguishes "no such user" from "wrong PIN".

## Reads and writes are gated differently

Uniform gating adds friction with no benefit, and users route around friction.

| Action | Gate |
| --- | --- |
| View balance, list agreements, view a deal | Linked account. No PIN. |
| Create an escrow agreement | Linked + phone on file. No PIN. |
| Cash out / withdraw / payout | Linked + **PIN** + limits below. |
| Add or change a payout bank account | Web only. Never from chat. |

Balance is not secret enough to justify a prompt every time. Withdrawal is
irreversible, which is the line that matters.

## A PIN alone is not sufficient

A PIN stops a stolen session. It does not stop a PIN that was watched, phished,
or given up under duress. These do more work than the PIN itself and should
ship with it, not after:

1. **New payout account cooldown.** Withdrawals to a bank account added in the
   last 24h are held, and the hold is emailed to the web address. The
   attacker's first move is always adding their own account; this catches it
   even when the PIN is known.
2. **Daily cap on chat-initiated withdrawals**, lower than the web cap. Large
   amounts are pushed to the web, where auth is stronger.
3. **Notify on every chat-initiated withdrawal**, by email and on the other
   linked channel. Detection matters when prevention fails - and because the
   PIN is shared, the other channel is a genuinely independent path to the user.

## Handling the PIN in a chat transcript

A PIN typed into a chat is written to history on the user's device, on the
provider's servers, and into bot logs unless prevented. Both bots must:

- Delete the user's PIN message immediately on receipt, before other work.
- Never log the message body on the PIN step. Not at debug level.
- **Refuse a PIN in a group chat outright** - do not verify it, do not accept
  it "just this once". Reply neutrally and move the flow to DM. The Telegram
  layer's `groupSafety.ts` already scans group text for sensitive patterns and
  is the right place to add PIN-shaped input.
- For withdrawals above the daily cap, prefer a short-lived one-time web link,
  so the highest-value flows never put a PIN in chat at all.

## Storage

- Argon2id or bcrypt - whichever `auth.service.ts` already uses for passwords.
  Do not introduce a second scheme.
- Never store, log, or audit the plaintext. Audit that a PIN was verified,
  never what was entered.
- 6 digits minimum, and reject trivial PINs (repeated digits, sequences). Those
  are guessed first and the check costs nothing.
- One record per payment user. No per-channel PIN columns - that shape is what
  lets two PINs come into existence later.

## Prerequisite: chat balance and cash out do not currently work

Verified against sivan-payments-api-test on 2026-08-08, calling as the bot with
its service secret:

- `GET /api/identity/balance?whatsappNumber=...` -> **404**. The route the bot
  calls for balance was never implemented. Only three `/api/identity/*` routes
  exist, all link-redeem.
- `GET /api/users/whatsapp-payout-account?whatsapp=...` -> **403**. Exists, but
  is not auth-exempt, so it needs a user JWT the bot cannot hold. Cash out
  depends on it.
- `GET /api/users/whatsapp-balance?whatsapp=...` -> **403**, same cause.

This fails for every chat user, not one account. It is a missing backend
contract, not a misconfiguration.

Separately, the Telegram layer caches `phone` from the redeem response into
`identityStore` and never refreshes it. A user who links Telegram before
WhatsApp is cached with `phone: null` and is told "this account has no phone
number on file" permanently, even after linking WhatsApp.

## Build order

1. Fix the phone cache refresh. Small, and it unblocks testing everything else.
2. Add read-only balance + payout routes under `/api/identity/`, reusing the
   existing service-secret guard.
3. Ship withdrawal together with PIN verification and the limits above - not
   withdrawal first and PIN later, which ships the risk and defers the control.
