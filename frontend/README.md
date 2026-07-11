# Sivan Off-Ramp User Frontend

Premium responsive React + TypeScript user frontend for the Sivan off-ramp MVP.

## Purpose

This app is for normal Sivan users. It intentionally hides internal business information such as:

- Bridge KYC/KYB costs
- Bridge off-ramp cost
- Sivan margin
- Onboarding cost recovery
- Internal economics

Users only see the product flow:

- Signup
- Verification status
- Add bank account
- Create withdrawal
- USDC deposit address
- Withdrawal history
- User-facing Sivan fee percent

## Stack

- React
- TypeScript
- Vite
- Node.js tooling
- Responsive CSS

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

## Run user frontend

```bash
cd /home/user/sivan-offramp/frontend
npm install
npm run dev
```

User frontend runs on:

```text
http://localhost:5173
```

## Build

```bash
npm run build
```

## Current user-facing fee config

```env
SIVAN_OFFRAMP_FEE_PERCENT=1.25
```


## Environment files

The user frontend has its own environment files:

```text
frontend/.env.example        # local
frontend/.env.test.example   # Vercel test lane
frontend/.env.live.example   # Vercel live lane
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
