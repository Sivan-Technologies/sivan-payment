# Future Build Plan - Explicit Delivery Deadline Field and Automated Countdown Alerts

Document Identifier: FUTURE_BUILD_DELIVERY_DEADLINE_TIMER
Status: ✅ COMPLETED & 100% VERIFIED
Target Release: Phase 2 - Multi-Chain Milestone Enhancements
Founder and Author: Samson Micheal (Founder, CEO, Technical Founder, Product Engineer)

---

## 1. Product Overview and Rationale

When creating a service agreement via natural language commands (e.g. "Draft a service agreement with John for logo design, 25 USDC, deliver in 1 days"), Phase 1 records the timeframe inside the agreement scope of work.

In Phase 2, Sivan payment AI introduces an explicit deadlineDays field and automated countdown tracking system to actively monitor delivery deadlines across Telegram, WhatsApp, and the Web across all active networks (Stellar, Celo, Solana, Base).

---

## 2. Core Functional Requirements

### A. Intent Parser Delivery Extraction
The natural language parser extracts explicit delivery durations:
- "deliver in 1 day" -> deadlineDays = 1
- "deliver in 3 days" -> deadlineDays = 3
- "deliver in 24 hours" -> deadlineDays = 1

### B. Live Chat Countdown Cards
Once an agreement is funded, Sivan payment AI updates status cards on Telegram and WhatsApp:
- Card display: "⏳ 18 hours remaining for John to submit delivery"
- Card display: "⚠️ Delivery due today at 5:00 PM"
- Multi-Chain Settlement indicator: "Settling on Stellar (Zero Gas) / Celo (cUSD) / Solana / Base"

### C. Automated Reminder Push Notifications
The background lifecycle sweeper dispatches push alerts:
- 6-Hour Warning (to Seller): "Reminder: 6 hours remaining to submit delivery for Agreement #SIV-1001."
- Overdue Notice (to Buyer and Seller): "Delivery deadline passed. Buyer can extend time or request mutual cancellation."

---

## 3. Database Schema and Architecture Updates

### Database Schema Update (sivan-escrow-agent)
In agreements table:
- Column: deadline_days INTEGER DEFAULT 3
- Column: delivery_due_at TIMESTAMP WITH TIME ZONE
- Column: reminder_6h_sent BOOLEAN DEFAULT false
- Column: network VARCHAR(50) DEFAULT 'stellar'

---

## 4. Acceptance Criteria

1. Natural language sentence parsing extracts delivery timeframes into deadlineDays.
2. Agreement status cards compute and render remaining hours dynamically.
3. Automated push notifications fire to sellers at the 6-hour remaining mark.
4. Overdue agreements allow buyers to extend duration or request mutual cancellation.
