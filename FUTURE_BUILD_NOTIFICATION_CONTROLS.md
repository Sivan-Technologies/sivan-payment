# Future Build Plan - Per-Channel Notification Toggles and Default Policy

Document Identifier: FUTURE_BUILD_NOTIFICATION_CONTROLS
Status: ✅ COMPLETED & 100% VERIFIED
Target Release: Phase 2 - Dashboard and Notification Controls
Founder and Author: Samson Micheal (Founder, CEO, Technical Founder, Product Engineer)

---

## 1. Product Overview and Rationale

Currently, when a user links their Telegram or WhatsApp identity to their Sivan profile, real-time push notifications dispatch across available channels.

To optimize messaging costs, comply with WhatsApp business messaging guidelines, and give users complete privacy control, Sivan introduces Per-Channel Notification Toggles in the Unified Identity dashboard section.

---

## 2. Default Notification Policy per Channel

| Channel | Default State upon Linking | Product and Cost Rationale |
| :--- | :--- | :--- |
| Telegram (@SivanAi_bot) | ON (Enabled) | Telegram Bot API is free, instant, and non-intrusive. Gives users instant multi-chain deal alerts out of the box. |
| WhatsApp (whatsapp:+...) | OFF (Disabled) | WhatsApp Meta/Twilio messaging carries per-message template fees. Defaulting to OFF prevents unnecessary API costs unless explicitly enabled. |

---

## 3. Dashboard UI Placement and Controls

On the web dashboard under SIVAN UNIFIED IDENTITY:

### A. Linked WhatsApp Card
- Header: Linked WhatsApp / Service Agreement account
- Controls:
  - [Refresh status] button
  - [Unlink] button
  - New Toggle: [Notifications: OFF / ON] (Defaults to OFF upon linking)
  - Helper text: "Enable WhatsApp alerts for deal updates and payouts."

### B. Linked Telegram Card
- Header: Linked Telegram account
- Controls:
  - [Refresh status] button
  - [Unlink] button
  - New Toggle: [Notifications: ON / OFF] (Defaults to ON upon linking)
  - Helper text: "Receive instant free real-time alerts via @SivanAi_bot on Telegram."

---

## 4. Technical Architecture and Database Schema

### Database Schema Update (sivan-payment and sivan-escrow-agent)
In user_preferences table:
- Column: telegram_notifications_enabled BOOLEAN NOT NULL DEFAULT true
- Column: whatsapp_notifications_enabled BOOLEAN NOT NULL DEFAULT false
- Column: multi_chain_alerts_enabled BOOLEAN NOT NULL DEFAULT true

---

## 5. Acceptance Criteria

1. Linking a new Telegram account sets telegram_notifications_enabled to true.
2. Linking a new WhatsApp account sets whatsapp_notifications_enabled to false by default.
3. Users can toggle either switch independently on the web dashboard.
4. Outbound deal cards respect user channel preferences before dispatching.
