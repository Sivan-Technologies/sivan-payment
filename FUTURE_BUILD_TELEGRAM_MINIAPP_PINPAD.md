# Future Build Specification: Telegram Mini-App Masked PIN Keypad

**Feature Name:** Telegram Mini-App Masked PIN Keypad & Hybrid Authentication Flow  
**Target Channel:** Telegram Layer (`Telegram-layer`)  
**Target Release Phase:** Phase 2 (Post-Grant / Scale Phase)  
**Status:** Documented & Queued  

---

## 1. Executive Summary & Objective

Provide Sivan Telegram users with a high-security, native banking app-style PIN entry interface using Telegram Mini Apps (Web Apps).

When a user initiates a withdrawal or security-sensitive transaction, Sivan will present a `🔐 Enter PIN Securely` button that launches an embedded, masked numeric keypad (`• • • • • •`). This guarantees zero exposure of PIN digits inside chat message history while delivering a state-of-the-art fintech experience.

---

## 2. Target User Experience & Flow

### Interactive Steps:
1. User requests a withdrawal via chat (e.g. `withdraw 12 usd to my account`).
2. Sivan presents the withdrawal quote card with an inline Web App button: `[ 🔐 Enter PIN Securely ]`.
3. Tapping the button launches a native Telegram Mini-App modal sliding up over the chat window.
4. The user enters their 6-digit PIN on a sleek, responsive numeric keypad.
5. As the 6th digit is tapped, the Mini-App encrypts and submits the payload directly via HTTPS to `sivan-payment` backend (`/api/ngn/offramp/orders`).
6. The Mini-App automatically closes (`Telegram.WebApp.close()`).
7. Telegram chat updates with the order settlement card (`💸 Withdrawal Settlement Status`).

### Fallback Protection (Option A Integration):
- If a user chooses to type their PIN directly in text instead of tapping the button, the bot processes the request and **instantly auto-deletes the PIN message bubble from chat history** using `deleteMessage`.

---

## 3. Technical Requirements & Endpoints

- **Web App Route**: `/pin-pad?quoteId=...&userId=...` hosted on `https://sivan-payments.sivantech.online`.
- **BotFather Configuration**: Register Web App domain in BotFather.
- **Telegram Web App SDK**: `https://telegram.org/js/telegram-web-app.js` for `Telegram.WebApp.sendData()` or direct API fetch.
