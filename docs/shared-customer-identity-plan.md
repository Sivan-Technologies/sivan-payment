# Sivan Shared Customer Identity Plan

## Purpose

Shared Customer Identity links an email-based Sivan Payment customer with a WhatsApp-based Sivan Escrow customer so the same person can use Sivan across web and WhatsApp without maintaining two unrelated accounts.

This is customer-facing first:

- Payment web users can link their WhatsApp / Escrow identity.
- WhatsApp escrow users can access safe, read-only Payment information after linking.
- Payment web users can later see their own escrow history after linking.

Admin modules remain separate and focused. Payment Admin and Escrow Admin show link status only by default. Cross-product support/compliance lookup is a later phase.

## Current models

### Sivan Payment

`UserRecord` already supports hybrid identity:

- `id`
- `email`
- `whatsappNumber?`
- `fullName`
- `primaryChannel?: "email" | "whatsapp" | "both"`
- `emailVerifiedAt?`
- `whatsappVerifiedAt?`

Payment/KYC/Bridge records attach to `userId`.

### Sivan Escrow

The `users` table already supports WhatsApp and email:

- `user_id`
- `whatsapp_number unique`
- `email unique`
- `password_hash`
- `first_name`
- `last_name`
- `role_history`

Escrow users are WhatsApp-first. Email users can exist with placeholder `whatsapp_number = web:<userId>` until they pair a real WhatsApp number.

### WhatsApp Bot

The bot already has API helpers:

- `pairWhatsApp(token, whatsappNumber)`
- `getProfileByEmail(email)`
- `signupWebUser(email, passwordHash)`
- `linkEmailToUser(whatsappNumber, email)`

## Linking rules

Non-negotiable rules:

- A verified Payment web session starts the link.
- Pairing tokens are short-lived.
- WhatsApp number proves control by sending/redeeming the token from WhatsApp.
- Email conflicts are blocked.
- WhatsApp conflicts are blocked.
- All link, cancel, redeem, and unlink events are audited.
- No automatic merge by name.
- No automatic merge by unverified email/phone.
- Admin modules do not show cross-module detail by default.

## Pairing flow

### Web starts link

1. Payment user signs in with email.
2. User opens Settings/Profile.
3. User clicks `Generate WhatsApp link code`.
4. Payment backend creates `SVP-XXXX-XX` token.
5. User sends code to Sivan on WhatsApp.

### WhatsApp redeems link

1. User sends `link SVP-XXXX-XX` or just `SVP-XXXX-XX`.
2. WhatsApp bot calls Payment backend service endpoint.
3. Payment backend validates token, expiry, and conflicts.
4. Payment backend updates Payment user with `whatsappNumber`, `whatsappVerifiedAt`, `primaryChannel = both`.
5. Payment backend creates active `customer_identity_links` record.
6. Bot can then call Escrow `/api/users/link-email` so Escrow user also stores the email.

## API endpoints

### Payment backend

- `GET /api/users/me/identity`
- `POST /api/users/me/identity/link-whatsapp/start`
- `POST /api/users/me/identity/link-whatsapp/cancel`
- `POST /api/users/me/identity/unlink-whatsapp`
- `POST /api/identity/link-whatsapp/redeem`

The redeem endpoint is service-protected with `x-sivan-identity-link-secret`.

## DB changes

Payment backend owns canonical link records:

### `customer_identity_links`

- `id`
- `paymentUserId`
- `escrowUserId?`
- `email`
- `whatsappNumber`
- `status: linked | unlinked`
- `linkedAt?`
- `unlinkedAt?`
- `createdAt`
- `updatedAt`
- `metadata`

### `identity_pairing_tokens`

- `id`
- `paymentUserId`
- `tokenHash`
- `status: pending | redeemed | canceled | expired`
- `expiresAt`
- `redeemedAt?`
- `canceledAt?`
- `whatsappNumber?`
- `escrowUserId?`
- `createdAt`
- `updatedAt`

## Admin Hub views

Now:

- Payment Admin shows `WhatsApp linked: Yes/No` only.
- Escrow Admin shows `Payment account linked: Yes/No` only.

Later:

- Support/compliance unified customer lookup with explicit RBAC.

## Test plan

- Payment backend build/typecheck.
- Start link requires logged-in user.
- Start link creates short-lived token.
- Cancel pending token works.
- Redeem requires service secret.
- Redeem rejects expired/invalid token.
- Redeem blocks WhatsApp conflicts.
- Redeem updates Payment user to `primaryChannel = both`.
- `GET /api/users/me/identity` returns link status.
- Payment frontend displays linked/not linked state.
- WhatsApp bot recognizes `SVP-XXXX-XX` and calls redeem endpoint.

## Rollout plan

1. Ship backend identity link service.
2. Ship Payment frontend link card.
3. Ship WhatsApp bot redeem command.
4. Enable read-only WhatsApp payment commands.
5. Later ship web escrow history.
6. Later ship transactional WhatsApp actions with limits and confirmations.
