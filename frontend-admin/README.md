# Sivan Off-Ramp Admin Frontend

Premium responsive React + TypeScript admin dashboard for the Sivan off-ramp engine.

## Purpose

This admin frontend is for internal Sivan operators only. It shows controls and internal economics including:

- User/customer state
- KYC/KYB cost tracking
- Bridge cost assumptions
- Sivan fee revenue
- Onboarding cost recovery
- Bank accounts
- Withdrawals
- Deposit addresses
- Withdrawal history

Do **not** expose this app to normal users without authentication and role-based access.

## Run backend

From the repo root:

```bash
cd /home/user/sivan-offramp
npm run dev
```

Backend defaults to:

```text
http://localhost:3000
```

## Run admin frontend

```bash
cd /home/user/sivan-offramp/frontend-admin
npm install
npm run dev
```

Admin frontend runs on:

```text
http://localhost:5174
```

## Current pricing config

```env
SIVAN_OFFRAMP_FEE_PERCENT=1.25
BRIDGE_OFFRAMP_COST_PERCENT=0.5
BRIDGE_KYC_COST_USD=2
BRIDGE_KYB_COST_USD=10
```


## Environment files

The admin frontend has its own environment files:

```text
frontend-admin/.env.example        # local
frontend-admin/.env.test.example   # Vercel test lane
frontend-admin/.env.live.example   # Vercel live lane
```

Only variables prefixed with `VITE_` are exposed to the browser.

For Vercel TEST:

```env
VITE_APP_ENV=test
VITE_API_BASE_URL=https://sivan-payments-api-test.onrender.com
```

For Vercel LIVE:

```env
VITE_APP_ENV=live
VITE_API_BASE_URL=https://sivan-payments-api-live.onrender.com
```

Do **not** put `ADMIN_API_KEY` in a Vercel frontend env variable. The admin key must be entered in the admin UI sidebar and stored locally in the admin user's browser.
