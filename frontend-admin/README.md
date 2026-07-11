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
