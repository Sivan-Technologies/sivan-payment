# Sivan Technologies — Anti-Money Laundering and Counter-Terrorist Financing (AML/CFT) Framework

Document Reference: SIV-POL-AML-2026-V1  
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

## 1. Policy Statement and Purpose

Sivan Technologies (operators of Sivan Payment AI) is committed to preventing the use of its payment infrastructure, API checkout rails, Service Agreements, and digital asset settlement facilities for money laundering, terrorism financing, proliferation financing, fraud, or other financial crimes.

This framework defines the internal systems, operational controls, suspicious activity reporting mechanisms, and employee obligations established to comply with:
- Money Laundering (Prevention and Prohibition) Act, 2022 (Nigeria).
- Terrorism (Prevention and Prohibition) Act, 2022 (Nigeria).
- Central Bank of Nigeria (CBN) AML/CFT/CPF Administrative Sanctions Regulations.
- Special Control Unit against Money Laundering (SCUML) Guidelines.
- Financial Action Task Force (FATF) Standards on Virtual Assets and Wire Transfers.

---

## 2. Institutional Risk Assessment (Risk-Based Approach)

Sivan Technologies applies a Risk-Based Approach (RBA) to identify, assess, and understand its money laundering and terrorist financing risks across:
1. Customer Risk: Individual consumers, freelance creators, corporate merchants, and autonomous software agents.
2. Geographic Risk: High-risk jurisdictions identified by FATF, non-cooperative tax regimes, and sanctioned territories.
3. Product & Channel Risk: Multi-channel conversational commerce (Telegram, WhatsApp), API checkouts, stablecoin on/off-ramps, and Service Agreement state machines.
4. Delivery Channel Risk: Non-face-to-face onboarding mitigated via verified biometric liveness and BVN/NIN API validations.

---

## 3. Core Operational Controls

### 3.1 Prohibited Customers and Activities
Sivan Technologies strictly prohibits onboarding or facilitating transactions for:
- Anonymous accounts, shell companies, or shell banks.
- Individuals or corporate entities listed on OFAC, UN, EU, or NFIU sanctions watchlists.
- Businesses involved in illegal gambling, unregistered binary options, adult entertainment, darknet marketplaces, unlicensed weapons, or unregistered remitters.
- Bearer share companies or entities with opaque ownership structures.

### 3.2 Customer Due Diligence (CDD) and Enhanced Due Diligence (EDD)
- Mandatory verification of all counterparties prior to funding or releasing any Service Agreement or processing API checkout volume.
- EDD applied to all Politically Exposed Persons (PEPs), high-volume merchants, non-resident customers, and transactions involving higher-risk jurisdictions.

### 3.3 Transaction Monitoring and Threshold Alerts
The Sivan Payment AI platform operates an automated transaction surveillance engine that analyzes incoming and outgoing transfers against dynamic risk heuristics:
- Structuring / Smurfing: Detection of multiple transactions just below statutory reporting thresholds within 24 to 72 hour windows.
- Velocity Spikes: Sudden tenfold surges in transaction volume compared to established historical baselines.
- Rapid Fund Movement: Immediate pass-through of funds deposited via fiat and instantly off-ramped to external wallets with zero platform commercial service activity.
- Sanctions Screening on Wallets: Real-time blockchain intelligence screening of recipient Solana/USDC wallet addresses against illicit entity clusters.

---

## 4. Suspicious Activity Reporting (SAR / STR) Protocols

### 4.1 Internal Escalation Flow
1. Automated alerts or front-line staff detections are logged in the Compliance Audit Trail.
2. The Principal Compliance Officer reviews the alert, freezes associated accounts where necessary, and conducts formal investigation within 24 hours.
3. If suspicion of money laundering, terrorist financing, or economic crime is substantiated, the Compliance Officer files a formal Suspicious Transaction Report (STR).

### 4.2 Regulatory Reporting
- Formal filing of STRs and Currency Transaction Reports (CTRs) with the Nigerian Financial Intelligence Unit (NFIU) in accordance with statutory reporting timelines.
- Immediate notification to partner settlement and banking institutions where joint fraud or money laundering risks are identified.
- Strict adherence to Tipping-Off prohibitions: No customer or third party is ever alerted that a report or investigation is underway.

---

## 5. Record Keeping and Audit Trail

- Comprehensive transaction logs, including sender/receiver identity, IP address, device fingerprints, transaction amounts, timestamps, and Solscan blockchain hashes, are preserved for a minimum of 5 years.
- Immutable database audit logging guarantees non-repudiation and tamper-evident records available upon formal request by regulatory authorities.

---

## 6. Staff Training, Governance, and Independent Audit

- Annual AML/CFT Training: Mandatory compliance training for all developers, customer support personnel, and executive leadership.
- Designated Compliance Officer: Sivan Technologies maintains a designated Head of Compliance with direct reporting authority to the Board of Directors and independent operational oversight.
- Independent Audit: Annual external compliance and security audits conducted by qualified third-party regulatory advisors.

---

## 7. Compliance Contact Information

Compliance Department  
Sivan Technologies  
Email: compliance@sivantech.online  
Escalations: risk@sivantech.online  
Website: https://sivantech.online
