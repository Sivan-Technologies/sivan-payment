# SIVAN DUAL VIRTUAL ACCOUNT, SMART FLOAT ROUTING, AND TREASURY SWEEPER SPECIFICATION
## Comprehensive Architecture for Resilient NGN Inflows, Intelligent Outflow Routing, and Automated Liquidity Sweeping

### 1. Executive Overview

This specification establishes the financial architecture for Sivan Ai dual virtual account collections, intelligent outflow liquidity routing, and scheduled treasury sweeping.

As Sivan Ai integrates 9PSB alongside Nomba:
1. Inflow Layer: Every user receives two Dedicated Virtual Accounts (DVAs) - 9PSB and Nomba / Wema. Both deposit rails feed into one unified Sivan Ai NGN ledger balance.
2. Outflow Layer: User withdrawals and vendor payouts use Smart Float Routing. The system evaluates provider balances and fulfills withdrawals from a single provider whenever possible, avoiding split transfer fees and customer confusion. Multi-tranche split payouts are reserved strictly as an automated fallback for high-value requests.
3. Treasury Liquidity Layer: A 12-hour hybrid threshold-and-schedule sweeper engine automatically aggregates excess collection floats into a primary corporate treasury pool while preserving an essential operational reserve buffer.

---

### 2. Dual Inflow Architecture (The Dual DVA Model)

#### 2.1 Multi-Bank Redundancy
In Nigeria, interbank settlement rails experience localized outages (e.g. mobile banking apps may intermittently fail when routing to Wema, but route without issue to 9PSB, or vice versa). Providing two distinct partner banks guarantees 99.9% deposit uptime.

Every registered Sivan Ai user profile holds two active DVA records:
- Primary DVA: 9PSB (Bank: 9PSB, e.g. Account Number: 9912345678)
- Secondary DVA: Nomba / Wema (Bank: Wema Bank or Providus, e.g. Account Number: 0198765432)

#### 2.2 Unified Ledger Aggregation
Sivan Ai maintains a single authoritative balance per user (`users.ngn_balance`):
- When a customer or employer transfers ₦25,000 to the user 9PSB account:
  9PSB issues an inbound webhook. Sivan Ai verifies the signature and credits ₦25,000 to the user ledger.
- When the user transfers ₦35,000 to their Nomba account:
  Nomba issues an inbound webhook. Sivan Ai verifies the signature and credits ₦35,000 to the same user ledger.
- Authoritative User Spendable Balance: ₦60,000.
- Both banking partners see active transaction throughput, preventing dormancy flags and satisfying bank compliance velocity rules.

#### 2.3 Webhook Ingestion and Idempotency Protocol
Every incoming payment webhook must satisfy strict safety requirements:
1. HMAC-SHA512 Signature Validation: Reject any payload with an invalid or missing signature.
2. Stable Provider Reference: Index every event by `provider_reference` (e.g. `nomba_dva_tx_...` or `9psb_txn_...`).
3. Atomic Ledger Credit: Check if `provider_reference` already exists in `ledger_transactions`. If present, return HTTP 200 immediately without crediting twice.
4. Instant Push Notification: Dispatch instant WhatsApp / Web / Telegram receipt confirming the bank rail that received the funds.

---

### 3. Outflow Architecture (Smart Float Routing)

When a user requests a withdrawal or initiates a Service Agreement milestone payout, Sivan Ai does not blindly split the transaction. It evaluates real-time provider balances to deliver a clean customer experience.

#### 3.1 Routing Decision Engine

Step 1. Liquidity Evaluation:
Query the current real-time float balances:
- Float A: Nomba Available Float (`float_nomba`)
- Float B: 9PSB Available Float (`float_9psb`)

Step 2. Single-Rail Priority Matching:
If the withdrawal amount is ₦40,000:
- Rule A: If Primary Provider (Nomba) has >= ₦40,000, dispatch the full ₦40,000 via Nomba.
- Rule B: If Nomba has < ₦40,000, but Secondary Provider (9PSB) has >= ₦40,000, dynamically route the full ₦40,000 via 9PSB.
- Outcome: Single bank alert received by the user, single transfer fee incurred by Sivan, zero partial-failure state.

Step 3. Automated Multi-Tranche Fallback (Emergency Split):
If neither provider individually holds ₦40,000, but combined liquidity is sufficient (e.g. Nomba has ₦25,000 and 9PSB has ₦20,000):
- Sivan Ai activates the multi-tranche execution pipeline:
  • Tranche 1: Dispatch ₦25,000 via Nomba (Reference: `wd_98234_t1`)
  • Tranche 2: Dispatch ₦15,000 via 9PSB (Reference: `wd_98234_t2`)
- WhatsApp / Interface Notification explicitly clarifies:
  "Your withdrawal of ₦40,000 is on its way in 2 instant tranches (₦25,000 and ₦15,000) for maximum delivery speed."
- Reversal Safety: If Tranche 1 succeeds but Tranche 2 fails upstream, only the unfulfilled ₦15,000 is re-credited to the user spendable balance with an explicit incident alert.

---

### 4. Automated Treasury Sweeper Engine

Because deposits arrive across two separate collection pools, secondary pools accumulate idle funds. A dedicated treasury sweeper aggregates liquidity into the primary operational floating balance.

#### 4.1 Hybrid Sweeper Model: Schedule + Threshold

Running a sweeper purely on a time schedule is inefficient (sweeping ₦500 wastes transfer fees). Running purely on threshold can delay liquidity during low-volume periods. Sivan Ai uses a Hybrid Threshold-and-Schedule model:

1. Schedule Frequency: Every 12 Hours (06:00 WAT and 18:00 WAT)
   - Synchronized with Nigerian banking settlement windows.
   - 06:00 WAT: Prepares maximum liquidity for morning business hours.
   - 18:00 WAT: Aggregates evening collections for overnight settlement.

2. Sweeping Minimum Threshold (`TREASURY_SWEEP_MIN_THRESHOLD_NGN`):
   - Default: ₦100,000
   - If accumulated secondary collection balance is below ₦100,000, no sweep occurs. This prevents fee erosion on small balances.

3. Mandatory Liquidity Reserve Buffer (`TREASURY_SWEEP_RESERVE_BUFFER_NGN`):
   - Default: ₦50,000
   - Rule: NEVER sweep an account to zero.
   - Always retain ₦50,000 on the secondary provider to cover unexpected chargebacks, dispute holds, and instant micro-withdrawals without bouncing.

#### 4.2 Sweeper Calculation Formula

```
Available Balance on Secondary Provider = B_sec
Reserve Buffer = R (₦50,000)
Minimum Sweep Threshold = T_min (₦100,000)

Calculated Sweep Amount = B_sec - R

If (Calculated Sweep Amount >= T_min):
    Execute Inter-Account Treasury Sweep(Amount = Calculated Sweep Amount)
    Target: Primary Treasury Pool (Nomba Float)
Else:
    Skip sweep execution. Log: "Balance below sweep threshold. Retaining float."
```

#### 4.3 Sweeper Execution Lifecycle

1. Audit Snapshot:
   Record current balances across both providers before initiating transfer.
2. Idempotent Sweep Reference:
   Generate unique corporate transfer reference: `sweep_sec_to_pri_YYYYMMDD_HHMM`.
3. Outbound Provider Transfer:
   Call secondary provider transfer API to send the calculated amount to the primary corporate settlement bank account.
4. Reconciliation Verification:
   Poll provider transfer status. On confirmation, update treasury float records in Sivan database and append an entry in the immutable audit log.
5. Slack / Telegram Operational Alert:
   Dispatch alert to internal devops channel:
   "Treasury Sweep Complete: ₦450,000 swept from 9PSB to Nomba. 9PSB retained buffer: ₦50,000."

---

### 5. Database Schema Requirements

To support dual DVAs and treasury sweeping, the following relational structures are maintained:

```sql
-- Multi-DVA Association Table
CREATE TABLE user_virtual_accounts (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id),
    provider VARCHAR(32) NOT NULL, -- '9psb', 'nomba', 'paystack'
    bank_name VARCHAR(128) NOT NULL,
    account_number VARCHAR(16) NOT NULL,
    account_name VARCHAR(128) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (user_id, provider)
);

-- Treasury Sweeps Record
CREATE TABLE treasury_sweeps (
    id VARCHAR(64) PRIMARY KEY,
    reference VARCHAR(128) UNIQUE NOT NULL,
    source_provider VARCHAR(32) NOT NULL,
    destination_provider VARCHAR(32) NOT NULL,
    amount_ngn NUMERIC(14, 2) NOT NULL,
    retained_buffer_ngn NUMERIC(14, 2) NOT NULL,
    fee_ngn NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    status VARCHAR(32) NOT NULL, -- 'initiated', 'confirmed', 'failed'
    initiated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    settled_at TIMESTAMP WITH TIME ZONE,
    metadata JSONB
);
```

---

### 6. User Experience on WhatsApp and Web App

#### 6.1 WhatsApp Inflow Display
When user types "DEPOSIT" or taps "Add Funds", Sivan Ai sends an interactive dual-account card:

```
Sivan Ai . Instant Deposit Options

Transfer to any of your dedicated accounts below to top up your spendable balance immediately:

Option 1 (9PSB):
• Bank: 9PSB
• Account: 9912345678
• Name: Sivan / Samson Micheal

Option 2 (Wema / Nomba):
• Bank: Wema Bank
• Account: 0198765432
• Name: Sivan / Samson Micheal

• Zero deposit fees. Both accounts credit your same Sivan balance instantly.
```

#### 6.2 Web Frontend Display (`sivan-user-frontend/src/routes/receive.tsx`)
In the "Bank Transfer" tab of the Deposit page:
- Clean segmented toggle or side-by-side cards: "9PSB Virtual Account" and "Wema Virtual Account".
- One-tap copy buttons for account numbers and bank names.
- Dynamic indicator showing "Network 100% Operational" for both banks.

---

### 7. Implementation Roadmap

Phase 1: Inflow Multi-DVA Storage
Update user profile services in `sivan-payment` to store and query multiple virtual account records per user. Expose `GET /api/ngn/virtual-accounts` returning both 9PSB and Nomba accounts.

Phase 2: Outflow Smart Float Router
Refactor withdrawal dispatch in `sivan-payment` to inspect live float balances before selecting the dispatch rail. Add multi-tranche fallback logic for amounts exceeding single-provider liquidity.

Phase 3: 12-Hour Treasury Sweeper Worker
Implement the cron background job `treasury_sweeper` executing at 06:00 and 18:00 WAT with `TREASURY_SWEEP_MIN_THRESHOLD_NGN` and `TREASURY_SWEEP_RESERVE_BUFFER_NGN` safety guards.

Phase 4: WhatsApp and Web Display Updates
Update `whatsapp-bot/src/handlers/cashoutSwap.ts` and `sivan-user-frontend/src/routes/receive.tsx` to render both accounts simultaneously.
