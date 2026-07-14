# Neon Database Integration

Sivan Payments now connects to the shared Neon database using `DATABASE_URL`.

## Identity model

The payments service does **not** create a separate users table.

The existing central table is the source of truth:

```text
users.user_id
```

Payments tables reference this central identity.

## Payments tables

The off-ramp/on-ramp payments engine uses namespaced tables so it does not collide with escrow tables:

```text
users
  ↑
  ├── escrows
  ├── payout_accounts
  ├── transactions
  └── payments_customers
        ├── payments_external_accounts
        ├── payments_liquidation_addresses
        ├── payments_withdrawals
        ├── payments_webhook_events
        ├── payments_reconciliation_runs
        ├── payments_reconciliation_findings
        └── payments_onboarding_costs
```

## Timestamps

New payments tables use `timestamptz` for production-grade timestamp handling.

## Migration

Migration file:

```text
database/migrations/001_create_payments_tables.sql
```

Run:

```bash
npm run db:migrate
```

## Runtime config

```env
DATABASE_PROVIDER=postgres
DATABASE_URL=postgresql://...
```

For local JSON mode:

```env
DATABASE_PROVIDER=json
DATABASE_FILE=.data/sivan-offramp.json
```

## Important note about users

The existing `users` table currently has this shape:

```text
user_id
whatsapp_number
first_name
last_name
role_history
created_at
updated_at
```

The current MVP user signup maps the frontend email field into `users.whatsapp_number` to keep the existing identity table as the source of truth.

Before production, align the user frontend with the real identity model, likely phone/WhatsApp-first or add a central email identity field if needed.

## Hybrid identity update

Sivan now supports a hybrid identity model:

```text
WhatsApp users can exist without email.
Web users should provide email.
Payments references user_id only.
```

Migration:

```text
database/migrations/002_evolve_users_hybrid_identity.sql
```

Added columns:

```text
email
email_verified_at
whatsapp_verified_at
primary_channel
```

The migration also allows `whatsapp_number` to be nullable and adds a safety check:

```sql
check (email is not null or whatsapp_number is not null)
```

Unique indexes:

```sql
users_email_unique on lower(email) where email is not null
users_whatsapp_number_unique on whatsapp_number where whatsapp_number is not null
```

Recommended product behavior:

- WhatsApp flow: require `whatsapp_number`; email optional.
- Web flow: require `email`; WhatsApp optional.
- Payment tables: only reference `users.user_id`.

## Passwordless auth tables

Migration `003_create_payments_auth_challenges.sql` adds:

```text
payments_auth_challenges
```

This supports email passwordless login using short-lived verification codes. User sessions use stateless JWTs signed by `USER_JWT_SECRET`.

Frontend users authenticate with:

```http
POST /api/auth/email/start
POST /api/auth/email/verify
GET  /api/auth/me
```

Protected user APIs require:

```http
Authorization: Bearer <user_jwt>
```

Admin APIs remain protected separately by `ADMIN_API_KEY` until Telegram Admin JWT/RBAC is integrated.
