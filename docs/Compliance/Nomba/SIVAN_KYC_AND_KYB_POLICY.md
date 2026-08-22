# Sivan Technologies — Customer Due Diligence, KYC and KYB Policy

Document Reference: SIV-POL-KYC-2026-V1  
Entity: Sivan Technologies  
CAC Registration Number (BN): 9585790  
Tax Identification Number (TIN): 2623798940018  
Registered Address: No. 3 Olayinka Street, Byazhin Across, Kubwa, Federal Capital Territory, Nigeria  
Operational Address: No. 1 Ebenezer Street, Byazhin Across, Kubwa, Bwari, Federal Capital Territory, Nigeria  
Date of Incorporation / Registration: 2 June 2026  
Effective Date: 9 June 2026  
Last Reviewed: August 2026  
Classification: Formal Compliance & Regulatory Documentation  

---

## 1. Executive Summary and Policy Objective

Sivan Technologies operates Sivan Payment AI, an agentic transaction coordination infrastructure and payment gateway facilitating multi-currency settlement, Service Agreements, and payment checkouts.

This Know Your Customer (KYC) and Know Your Business (KYB) Policy establishes mandatory customer identification, verification, and ongoing monitoring procedures in compliance with:
- Central Bank of Nigeria (CBN) Anti-Money Laundering and Combating the Financing of Terrorism Regulations.
- Money Laundering (Prevention and Prohibition) Act, 2022.
- Terrorism (Prevention and Prohibition) Act, 2022.
- Financial Action Task Force (FATF) Recommendations on Virtual Asset Service Providers (VASPs) and Financial Gateways.

---

## 2. Risk-Based Tiered KYC Framework (Individual Users)

Sivan Payment AI enforces a four-tier risk-weighted KYC architecture for all individual accounts transacting in Nigerian Naira (NGN), USD Coin (USDC), and foreign currencies:

### Tier 0: Unverified / Basic Exploration
- Requirements: Valid Phone Number or Telegram ID with OTP verification.
- Transaction Limit: NGN 0 / USDC 0 (Read-only access, exploration of Service Agreement templates).
- Daily Limit: NGN 0.
- Monthly Cumulative Limit: NGN 0.

### Tier 1: Basic Identity Verification (Low-Risk Micro Transactions)
- Requirements:
  1. Full Legal Name (as registered with official identity databases).
  2. Verified Phone Number.
  3. Bank Verification Number (BVN) or National Identity Number (NIN) verified via automated governmental database lookup.
  4. Date of Birth and residential address matching BVN records.
- Transaction Limits:
  - Single Transaction Limit: NGN 50,000 / $50 USDC.
  - Daily Cumulative Limit: NGN 300,000 / $300 USDC.
  - Maximum Cumulative Balance: NGN 500,000.

### Tier 2: Standard Due Diligence (Medium-Risk Retail & Freelancers)
- Requirements:
  1. All Tier 1 requirements.
  2. Government-issued Photo Identification (Digital National Identity Slip / Card NIN, International Passport, Driver's License, or Voter's Card) with automated biometric liveness and optical character recognition (OCR) match.
  3. Verified Residential Address via recent utility bill (electricity, water, waste) or official bank statement dated within the last 3 months.
- Transaction Limits:
  - Single Transaction Limit: NGN 5,000,000 / $5,000 USDC.
  - Daily Cumulative Limit: NGN 10,000,000 / $10,000 USDC.
  - Monthly Cumulative Limit: NGN 25,000,000 / $25,000 USDC.

### Tier 3: Enhanced Due Diligence (High-Volume Merchants & High Net Worth Individuals)
- Requirements:
  1. All Tier 2 requirements.
  2. In-person or live video verification call with Sivan Compliance Officer.
  3. Documented Source of Wealth and Source of Funds declaration.
  4. 6 months commercial bank statements verifying operational transaction history.
  5. Enhanced PEP (Politically Exposed Persons) and sanctions screening.
- Transaction Limits:
  - Custom elevated transactional ceilings approved by Compliance Committee (e.g., NGN 25,000,000+ single transaction limit).

---

## 3. Know Your Business (KYB) Framework (Corporate & Merchant Accounts)

For corporate clients, agencies, and e-commerce merchants integrating Sivan Payment AI API Checkout, the following verification process is mandatory before API live keys are generated:

### 3.1 Required Corporate Documentation
1. Certificate of Incorporation / Business Name Registration from the Corporate Affairs Commission (CAC) or relevant jurisdictional corporate registry.
2. Status Report / Certified Extract / Registration Form showing business details, principal place of business, and proprietor/director records.
3. Tax Identification Number (TIN) and Tax Clearance Certificate where applicable.
4. Corporate Bank Account Statement: 3 to 6 months of corporate bank statements issued by a licensed commercial bank.
5. Proof of Physical Principal Place of Business: Commercial lease agreement, recent utility bill in the business name, or physical site inspection report.
6. Corporate Resolution / Owner Authority Letter authorising the opening of the Sivan merchant account and designating authorized signatories.

### 3.2 Ultimate Beneficial Ownership (UBO) Verification
- Identification of all natural persons who ultimately own or control 5% or more of the company's equity or voting rights.
- Collection of Tier 2 KYC documentation for all Ultimate Beneficial Owners, Directors, and Key Executives (Managing Director, Compliance Officer).

---

## 4. PEP (Politically Exposed Persons) and Sanctions Screening

1. Automated Sanctions Screening: Every customer, director, and UBO is screened against global sanctions databases, including:
   - OFAC (Office of Foreign Assets Control)
   - United Nations Security Council Consolidated List
   - European Union External Action Sanctions List
   - Nigerian Financial Intelligence Unit (NFIU) Watchlists
2. PEP Handling: Politically Exposed Persons (domestic and international) and their immediate family members/close associates are automatically classified as High Risk and subject to Enhanced Due Diligence (EDD), requiring Senior Management approval prior to account activation.
3. Adverse Media Monitoring: Continuous automated checks for negative news relating to financial crime, fraud, money laundering, or narcotics trafficking.

---

## 5. Ongoing Monitoring and Transaction Surveillance

1. Velocity Monitoring: Automated rule engines track transaction frequency, sudden volume surges, structuring (smurfing) patterns, and rapid account balance depletion.
2. Periodic Record Refresh:
   - Low-risk accounts: Refreshed every 24 months.
   - Medium-risk accounts: Refreshed every 12 months.
   - High-risk / Corporate accounts: Refreshed every 6 months.
3. Record Retention: All KYC/KYB documents, transaction logs, and customer communication records are securely retained for a minimum of 5 years following account termination in accordance with statutory requirements.

---

## 6. Governance and Compliance Officer Sign-Off

Compliance Officer: Head of Risk and Compliance, Sivan Technologies  
Email: compliance@sivantech.online  
Escalations: risk@sivantech.online  
Approval Date: 9 June 2026  
Status: Approved & Enforced
