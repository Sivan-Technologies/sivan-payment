# Future Build Plan - Per-Channel Notification Toggles & Default Policy

Status: QUEUED - Phase 1 Code Freeze Active  
Target: Phase 2 - Post Grant Applications and Soft Launch  
Document Reference: `FUTURE_BUILD_NOTIFICATION_CONTROLS.md`

---

## 🎯 1. Product Overview & Rationale

Currently, when a user links their Telegram or WhatsApp identity to their Sivan profile, real-time push notifications dispatch across available channels.

To optimize messaging costs, comply with WhatsApp business messaging guidelines, and give users complete privacy control, Sivan will introduce **Per-Channel Notification Toggles** in the Unified Identity dashboard section.

---

## ⚙️ 2. Default Notification Policy per Channel

| Channel | Default State upon Linking | Product & Cost Rationale |
|---|---|---|
| Telegram (`@Sivan_Ai`) | **ON (Enabled)** | Telegram Bot API is 100% free, instant, and non-intrusive. Gives users instant deal alerts out of the box. |
| WhatsApp (`whatsapp:+...`) | **OFF (Disabled)** | WhatsApp Meta/Twilio messaging carries per-message template fees. Defaulting to OFF prevents unnecessary API costs and spam compliance issues unless the user explicitly toggles it ON. |

---

## 🎨 3. Dashboard UI Placement & Controls

On the web dashboard under `SIVAN UNIFIED IDENTITY`:

### A. Linked WhatsApp Card
- Header: Linked WhatsApp / Service Agreement account
- Controls:
  - `[Refresh status]` button
  - `[Unlink]` button
  - **New Toggle**: `[Notifications: OFF / ON]` (Defaults to OFF upon linking)
  - Helper text: "Enable WhatsApp alerts for deal updates and payouts (Meta messaging rates apply)."

### B. Linked Telegram Card
- Header: Linked Telegram account
- Controls:
  - `[Refresh status]` button
  - `[Unlink]` button
  - **New Toggle**: `[Notifications: ON / OFF]` (Defaults to ON upon linking)
  - Helper text: "Receive instant free real-time alerts via @Sivan_Ai on Telegram."

---

## 🏗️ 4. Technical Architecture & Database Schema

### Database Schema Update (`sivan-payment` & `sivan-escrow-agent`)

In `user_preferences` table:

- Column: `telegram_notifications_enabled BOOLEAN NOT NULL DEFAULT true`
- Column: `whatsapp_notifications_enabled BOOLEAN NOT NULL DEFAULT false`

### Outbound Notification Dispatcher Logic (`notificationService.ts`)

```ts
if (channel === "telegram" && !userPrefs.telegramNotificationsEnabled) {
  return; // Skip Telegram push notification
}

if (channel === "whatsapp" && !userPrefs.whatsappNotificationsEnabled) {
  return; // Skip WhatsApp push notification
}
```

---

## 📋 5. Acceptance Criteria

1. Linking Telegram automatically sets `telegramNotificationsEnabled = true`.
2. Linking WhatsApp automatically sets `whatsappNotificationsEnabled = false`.
3. User can toggle either channel ON or OFF at any time from the Web Dashboard.
4. Toggling OFF instantly suppresses outbound push notifications for that specific channel.
5. Unlinking an account resets preferences cleanly.

---

## 🚀 Priority & Schedule

Build in Phase 2 Sprint 1 alongside USDC Structured Tiers.  
Estimated Effort: 1.5 development days.
