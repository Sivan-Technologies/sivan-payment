# Sivan Ai - Dynamic Admin Default Network Switch Specification

## Overview
This specification defines the architectural capability for Sivan administrators to configure, promote, and dynamically switch the primary default blockchain network (such as Stellar, Solana, Celo, Base, or BNB Chain) across all client interfaces (Telegram, WhatsApp, and Web Dashboard) via the Admin Control Panel with zero code deployments.

Document Version: 1.0.0
Author: Samson Micheal, Founder & CEO (Abuja, Nigeria)
Platform: Sivan Ai / Sivan Payment Ai

---

## 1. Motivation & Use Cases

### A. Ecosystem Grant & Partner Campaigns
When running partner campaigns or grant milestones (such as a Stellar Community Fund campaign, Celo Builder Soft Launch, or Solana Colosseum sprint), the platform can set that specific network as the primary default deposit and settlement rail across all conversational surfaces.

### B. Gas Optimization & Network Congestion
If a particular chain experiences temporary congestion or high gas spikes, administrators can immediately shift the default suggested deposit network to an ultra-low-fee rail (such as Stellar or Celo) in real time.

---

## 2. Technical Architecture

### A. Database Schema Extension
Table: payments_network_controls

Add a boolean column:
- is_default BOOLEAN DEFAULT FALSE

Constraint:
Only one network row may have is_default = TRUE at any given time. Setting a new default network automatically updates the previous default to FALSE.

### B. Admin API Endpoints

1. GET /api/admin/network-controls
Returns the list of supported networks, their enabled status, sort order, and which network is currently flagged as default.

Response Shape:
{
  "networks": [
    { "network": "stellar", "enabled": true, "isDefault": true, "label": "Stellar", "sortOrder": 10 },
    { "network": "solana", "enabled": true, "isDefault": false, "label": "Solana", "sortOrder": 20 },
    { "network": "celo", "enabled": true, "isDefault": false, "label": "Celo", "sortOrder": 30 },
    { "network": "base", "enabled": true, "isDefault": false, "label": "Base", "sortOrder": 40 },
    { "network": "bsc", "enabled": true, "isDefault": false, "label": "BNB Chain", "sortOrder": 50 }
  ],
  "defaultNetwork": "stellar"
}

2. PUT /api/admin/network-controls/default
Admin payload:
{
  "defaultNetwork": "stellar"
}

Actions:
- Verifies that the requested network is enabled.
- Atomically sets is_default = true on the chosen network.
- Invalidates the cached network control snapshot in Redis / memory.
- Writes an audit log entry: admin.network_controls.default_changed.

---

## 3. Client Integration Across Channels

### A. Telegram Layer (dispatcher.ts)
When a user clicks "Receive Crypto" or types "deposit" with no network specified:
- Instead of hardcoding options?.network || "solana", the dispatcher reads getDefaultNetwork() from the cached network controls API.
- If the default is set to Stellar, the bot automatically renders the Stellar Deposit Card (USDC & USDT) with Stellar marked as Active in the inline keyboard.

### B. WhatsApp Bot (balance.ts & deposit.ts)
- When a user asks for deposit details, the primary QR code and deposit address card presented first corresponds to the active default network.

### C. Web Dashboard (ReceiveView.tsx)
- The deposit modal automatically opens with the admin-configured default network tab pre-selected (e.g. Stellar tab active instead of Solana).

---

## 4. Security & Validation Rules

1. Enabled Check: An administrator cannot set a disabled network as the default.
2. Fallback Safety: If the database is unreachable or no default is configured, the system falls back safely to Solana or Base.
3. Audit Trail: Every change logs the admin actor email, IP address, and timestamp.

---

## 5. Implementation Roadmap

- Phase 1: Database column migration on payments_network_controls.
- Phase 2: Update payment-controls.service.ts and admin routes with default network schema.
- Phase 3: Update Telegram and WhatsApp dispatchers to dynamically query and honor the active default network.
- Phase 4: Add Default Network Radio Selector in the Admin Dashboard UI.
