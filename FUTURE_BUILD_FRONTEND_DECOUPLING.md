# Future Build Specification: Frontend Decoupling and Standalone Repository

Document ID: FUTURE_BUILD_FRONTEND_DECOUPLING
Target Release: Phase 3 (Post-Grant and Scaling Phase)
Status: ⏳ QUEUED FOR PHASE 3 (Post-Grant Scaling Phase — Protected under Code Freeze Protocol)
Author: Samson Micheal (Founder, CEO, and Product Engineer)
Location: Abuja, Nigeria

---

## 1. Executive Summary

This specification outlines the architectural roadmap for decoupling the user-facing client interface (currently housed under sivan-payment/frontend) into an independent repository and edge-hosted web service during Phase 3.

During Phase 1 and Phase 2, maintaining the client and backend within the sivan-payment repository is intentional and critical:
- It eliminates cross-origin resource sharing (CORS) configuration issues and cookie domain complexities.
- It simplifies staging and production builds into unified Render pipelines.
- It protects system stability while all focus is dedicated to the Demo Video, Grant Submissions (Stellar SCF, Celo/Alliance), and initial user soft launch.

Decoupling will take place in Phase 3 once initial transaction volume is established and dedicated frontend engineering resources are allocated.

---

## 2. Why Retain the Monorepo Structure in Phase 2

1. Execution Priority Over Restructuring
Grant committees and pilot users evaluate real transaction flow, multi-chain settlement speed, and Nigerian bank off-ramp reliability (sub-second 0.15s ledger settlement and near-instant bank delivery under 1 to 2 minutes via NIBSS/NIP rails). Repository separation provides zero visible impact to end users or evaluators during soft launch.

2. Prevention of Unnecessary Deployment Downtime
Splitting the repository right now requires re-architecting build pipelines in render.yaml, provisioning new SSL certificates, synchronizing submodule references, and re-verifying automated integration suites.

3. Code Freeze Adherence
The workspace operates under a strict code freeze protocol across stable branches (airspexta and multichain). All structural refactoring is postponed until active grant submissions are complete.

---

## 3. Target Phase 3 Architecture

Once Phase 3 begins, the decoupled architecture will be structured as follows:

1. Standalone Frontend Repository: sivan-customer-app
- Dedicated Git repository with its own linting, testing, and dependency management.
- Built with modern client technologies (Vite, React, TypeScript).
- Hosted on global edge CDNs (such as Cloudflare Pages or Vercel) for sub-50ms static asset delivery worldwide.
- Custom domain: app.sivantech.online.

2. Headless Backend API: sivan-payment
- Operates purely as a high-performance, headless API and Developer Gateway.
- Serves endpoints over HTTPS at api.sivantech.online.
- Houses multi-chain adapters (Stellar, Celo, Solana, Base, BNB), smart account orchestration, Service Agreement state machines, and payment rail webhooks.
- No longer responsible for compiling, bundling, or serving static client bundles.

3. Communication Layer
- REST APIs: Standardized JSON payloads via /api/v1/*.
- Real-Time Updates: WebSockets / Server-Sent Events (SSE) for instant deposit confirmations and Service Agreement countdown timers.
- Cross-Origin Security: Explicit CORS whitelisting on api.sivantech.online restricted to authorized origins (https://app.sivantech.online, https://admin.sivantech.online, and verified local development origins).
- Authentication: Secure HTTP-only session cookies with sameSite=none and partitioned attributes across *.sivantech.online subdomains, backed by WebAuthn Passkeys.

---

## 4. Step-by-Step Phase 3 Decoupling Roadmap

### Step 1: Git Repository Extraction
- Use git subtree split to extract sivan-payment/frontend into a fresh repository (sivan-customer-app) while preserving commit history.
- Initialize dedicated package.json, tsconfig.json, and CI/CD workflow files (.github/workflows/deploy.yml).

### Step 2: Environment Variable Sourcing
- Ensure the new standalone frontend uses dynamic environment variables for all backend API connections:
  - VITE_PAYMENT_API_URL=https://api.sivantech.online
  - VITE_TELEGRAM_BOT_URL=https://t.me/Sivan_Ai
  - VITE_EXPLORER_BASE_URL (dynamic multi-chain network resolver)
- Confirm zero hardcoded backend or explorer URLs exist in client components.

### Step 3: Headless Backend Streamlining
- In sivan-payment:
  - Remove fastify-static or static HTML file serving plugins.
  - Remove frontend build scripts from package.json root commands.
  - Update render.yaml to define sivan-payment strictly as a web service running node dist/server.js.
  - Update CORS middleware to accept requests from https://app.sivantech.online with credentials enabled.

### Step 4: White-Label and Embeddable Widget Extraction
- Extract the core Service Agreement checkout component into an embeddable SDK (@sivantech/react-widget).
- Allow third-party partner platforms to embed Sivan Service Agreement payments directly into their own websites with custom branding and their own developer API keys.

---

## 5. Pre-Requisites Before Commencing Decoupling

Before this specification is executed, the following milestones must be achieved:
1. Stellar SCF and external grant applications submitted and reviewed.
2. Demo video recorded, verified, and published.
3. User soft launch successfully active on staging/production with stable multi-chain deposits (5 USDC to 50 USDC volume).
4. Automated integration test suites passing with zero failures.

---

## 6. Document Metadata and Change Log

- Date Created: September 2026
- Version: 1.0.0
- Status: Approved Future Plan
- Target Trigger: Phase 3 Kickoff
