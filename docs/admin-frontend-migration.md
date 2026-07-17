# Admin frontend migration

The Sivan Payment standalone admin frontend has moved out of this repository.

Official admin repo:

```text
https://github.com/Samswitchy/sivan-admin-hub
```

Admin Hub routes administrators into the Sivan Payment module at:

```text
/dashboard/modules/sivan-payment
```

## What remains in `sivan-payment`

Keep the backend payment admin APIs. Admin Hub depends on them through its server-side proxy:

```text
/api/admin/*
```

Do not remove these backend routes unless Admin Hub is migrated at the same time.

## Admin Hub payment env

TEST:

```env
SIVAN_PAYMENT_API_URL=https://sivan-payments-api-test.onrender.com
SIVAN_PAYMENT_ADMIN_API_KEY=<TEST_ADMIN_API_KEY>
NEXT_PUBLIC_DATABASE_MODE=test
```

LIVE:

```env
SIVAN_PAYMENT_API_URL=https://sivan-payments-api-live.onrender.com
SIVAN_PAYMENT_ADMIN_API_KEY=<LIVE_ADMIN_API_KEY>
NEXT_PUBLIC_DATABASE_MODE=live
```

`SIVAN_PAYMENT_ADMIN_API_KEY` must stay server-side. Never expose it as a `NEXT_PUBLIC_*` or `VITE_*` variable.
