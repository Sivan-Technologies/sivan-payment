# Future Build Plan - Explicit Delivery Deadline Field & Automated Countdown Alerts

Status: QUEUED - Phase 1 Code Freeze Active  
Target: Phase 2 - Post Grant Applications and Soft Launch  
Document Reference: `FUTURE_BUILD_DELIVERY_DEADLINE_TIMER.md`

---

## 🎯 1. Product Overview & Rationale

When creating a service agreement via natural language commands (e.g. "Draft a service agreement with John for logo design, $18, deliver in 1 days"), Phase 1 records the timeframe inside the scope of work (purpose).

In Phase 2, Sivan AI will introduce an explicit **`deadlineDays`** field and automated countdown tracking system to actively monitor delivery deadlines across Telegram, WhatsApp, and Web.

---

## ⚙️ 2. Core Functional Requirements

### A. Intent Parser Delivery Extraction
The natural language parser will extract explicit delivery durations:
- "deliver in 1 day" -> `deadlineDays = 1`
- "deliver in 3 days" -> `deadlineDays = 3`
- "deliver in 24 hours" -> `deadlineDays = 1`

### B. Live Chat Countdown Cards
Once an agreement is funded, Sivan AI updates status cards on Telegram and WhatsApp:
- Card display: "⏳ 18 hours remaining for John to submit delivery"
- Card display: "⚠️ Delivery due today at 5:00 PM"

### C. Automated Reminder Push Notifications
The background lifecycle sweeper dispatches push alerts:
- **6-Hour Warning (to Seller)**: "⏰ Reminder: 6 hours remaining to submit delivery for Agreement #SIV-1001."
- **Overdue Notice (to Buyer & Seller)**: "⌛ Delivery deadline passed. Buyer can extend time or request cancellation."

---

## 🎨 3. Database Schema & Architecture Updates

### Database Schema Update (`sivan-escrow-agent`)

In `escrows` table:
- Column: `deadline_days INTEGER DEFAULT 3`
- Column: `delivery_due_at TIMESTAMP WITH TIME ZONE`
- Column: `reminder_6h_sent BOOLEAN DEFAULT false`

### State Machine Rules (`escrowStore.ts`)

```ts
if (now > escrow.deliveryDueAt && escrow.status === "IN_PROGRESS") {
  // Flag as delivery overdue without auto-cancelling
  escrow.deliveryOverdue = true;
}
```

---

## 📋 4. Acceptance Criteria

1. Natural language sentence parsing extracts delivery timeframes into `deadlineDays`.
2. Agreement status cards compute and render remaining hours dynamically.
3. Automated push alert fires to seller 6 hours before deadline expiration.
4. Overdue agreements allow buyers to extend the delivery deadline or request immediate cancellation.

---

## 🚀 Priority & Schedule

Build in Phase 2 Sprint 1 alongside Notification Controls.  
Estimated Effort: 2 development days.
