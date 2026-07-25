import { z } from 'zod';
import type { CustomerRecord, SupplierControlsRecord, SupplierPaymentRecord, SupplierRecord, UserRecord } from '../database/types.js';
import { nowIso } from '../shared/id.js';

export const supplierControlsSchema = z.object({
  supplierPaymentsEnabled: z.boolean().default(true),
  thirdPartySupplierPayoutsEnabled: z.boolean().default(true),
  autoApproveApprovedSuppliers: z.boolean().default(false),
  requireInvoiceForSupplierPayouts: z.boolean().default(true),
  manualReviewThreshold: z.coerce.number().positive().default(1000),
  newSupplierFirstPaymentReview: z.boolean().default(true),
  newCustomerReviewWindowDays: z.coerce.number().int().nonnegative().default(7),
  newCustomerReviewThreshold: z.coerce.number().positive().default(250),
  highRiskCountries: z.array(z.string().min(2).max(3)).default(['RU', 'BY', 'VE', 'NG']).transform((items) => items.map((item) => item.toUpperCase())),
  blockedCountries: z.array(z.string().min(2).max(3)).default(['IR', 'KP', 'SY', 'CU']).transform((items) => items.map((item) => item.toUpperCase())),
  dailySupplierPayoutLimit: z.coerce.number().positive().default(5000),
  monthlySupplierPayoutLimit: z.coerce.number().positive().default(25000),
  updatedBy: z.string().min(2).default('admin_api_key'),
  reason: z.string().max(1000).default('Update supplier payout risk controls')
});

export type SupplierRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type SupplierRiskDecision = 'auto_approve' | 'manual_review' | 'block';

export type SupplierRiskReview = {
  riskLevel: SupplierRiskLevel;
  riskScore: number;
  decision: SupplierRiskDecision;
  reviewReason: string;
  redFlags: string[];
  missingEvidence: string[];
  checklist: string[];
  recommendedAction: string;
  complianceNote: string;
  suggestedQuestions: string[];
  auditSummary: string;
};

export const defaultSupplierControls = (): SupplierControlsRecord => ({
  id: 'global',
  supplierPaymentsEnabled: true,
  thirdPartySupplierPayoutsEnabled: true,
  autoApproveApprovedSuppliers: false,
  requireInvoiceForSupplierPayouts: true,
  manualReviewThreshold: 1000,
  newSupplierFirstPaymentReview: true,
  newCustomerReviewWindowDays: 7,
  newCustomerReviewThreshold: 250,
  highRiskCountries: ['RU', 'BY', 'VE', 'NG'],
  blockedCountries: ['IR', 'KP', 'SY', 'CU'],
  dailySupplierPayoutLimit: 5000,
  monthlySupplierPayoutLimit: 25000,
  updatedBy: 'system_default',
  reason: 'Default beta supplier payout controls. Admin can update dynamically.',
  updatedAt: nowIso()
});

function daysBetween(fromIso?: string) {
  if (!fromIso) return 0;
  const ms = Date.now() - new Date(fromIso).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86_400_000)) : 0;
}

function amount(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function money(value: number) {
  return value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function normalizeCountry(country?: string) {
  return String(country || '').trim().toUpperCase();
}

function severity(score: number, blocked: boolean): SupplierRiskLevel {
  if (blocked || score >= 90) return 'critical';
  if (score >= 65) return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}

export function evaluateSupplierRisk(input: {
  user?: UserRecord | null;
  customer?: CustomerRecord | null;
  supplier?: SupplierRecord | null;
  amount?: number | string;
  paymentPurpose?: string;
  invoiceUrl?: string;
  controls: SupplierControlsRecord;
  existingPayments?: SupplierPaymentRecord[];
  sanctionsHit?: boolean;
}): SupplierRiskReview {
  const redFlags: string[] = [];
  const missingEvidence: string[] = [];
  const checklist: string[] = [];
  const suggestedQuestions: string[] = [];
  let score = 0;
  let blocked = false;
  const controls = input.controls;
  const customer = input.customer;
  const supplier = input.supplier;
  const payoutAmount = amount(input.amount);
  const supplierCountry = normalizeCountry(supplier?.supplierCountry);
  const accountAgeDays = daysBetween(input.user?.createdAt);
  const existingPayments = input.existingPayments ?? [];
  const isFirstPayment = !existingPayments.some((payment) => payment.supplierId === supplier?.id && ['approved', 'processing', 'completed'].includes(payment.status));

  if (!controls.supplierPaymentsEnabled) { blocked = true; redFlags.push('Supplier payments are disabled by admin controls.'); }
  else checklist.push('Supplier payments enabled by admin controls');

  if (!controls.thirdPartySupplierPayoutsEnabled) { blocked = true; redFlags.push('Third-party supplier payouts are disabled.'); }
  else checklist.push('Third-party supplier payouts enabled');

  if (!customer) { blocked = true; redFlags.push('No Bridge customer record found.'); }
  else {
    if (customer.kycStatus !== 'kyc_approved') { blocked = true; redFlags.push('Customer KYC is not approved.'); }
    else checklist.push('Customer KYC approved');
    if (customer.tosStatus !== 'approved') { blocked = true; redFlags.push('Customer Terms of Service is not approved.'); }
    else checklist.push('TOS approved');
  }

  if (!supplier) { blocked = true; redFlags.push('Supplier record is missing.'); }
  else {
    checklist.push('Supplier record exists');
    if (supplier.status !== 'approved') {
      score += 25;
      redFlags.push(`Supplier is ${supplier.status.replaceAll('_', ' ')}.`);
    } else checklist.push('Supplier already approved');

    if (controls.blockedCountries.includes(supplierCountry)) { blocked = true; redFlags.push(`Supplier country ${supplierCountry} is blocked.`); }
    else checklist.push('Supplier country is not blocked');

    if (controls.highRiskCountries.includes(supplierCountry)) { score += 35; redFlags.push(`Supplier country ${supplierCountry} is high risk.`); }
    else checklist.push('Supplier country is not high risk');

    if (supplier.accountOwnerName && supplier.supplierName && !supplier.accountOwnerName.toLowerCase().includes(supplier.supplierName.toLowerCase().slice(0, Math.min(6, supplier.supplierName.length)))) {
      score += 15;
      redFlags.push('Supplier name and bank account owner name may not match.');
      suggestedQuestions.push('Ask the customer to confirm why the bank account owner differs from the supplier name.');
    }
  }

  if (input.sanctionsHit) { blocked = true; redFlags.push('Sanctions screening placeholder returned a potential hit.'); }
  else checklist.push('Sanctions screening placeholder clear');

  if (controls.requireInvoiceForSupplierPayouts && !input.invoiceUrl) {
    score += 20;
    missingEvidence.push('Invoice or supporting document');
    suggestedQuestions.push('Request invoice, purchase order, or contract for the supplier payment.');
  } else if (input.invoiceUrl) checklist.push('Invoice/supporting document provided');

  if (!input.paymentPurpose || input.paymentPurpose.trim().length < 12) {
    score += 15;
    missingEvidence.push('Clear payment purpose');
    suggestedQuestions.push('Ask for a clearer business purpose and relationship to the supplier.');
  } else checklist.push('Payment purpose provided');

  if (controls.newSupplierFirstPaymentReview && isFirstPayment) {
    score += 25;
    redFlags.push('First payout to this supplier.');
  }

  if (payoutAmount >= controls.manualReviewThreshold) {
    score += 25;
    redFlags.push(`Amount ${money(payoutAmount)} USDC is at/above manual review threshold ${money(controls.manualReviewThreshold)}.`);
  } else if (payoutAmount > 0) checklist.push('Amount below manual review threshold');

  if (accountAgeDays < controls.newCustomerReviewWindowDays && payoutAmount >= controls.newCustomerReviewThreshold) {
    score += 20;
    redFlags.push(`Customer account is ${accountAgeDays} days old and amount exceeds new-customer threshold.`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);
  const dailyVolume = existingPayments.filter((p) => p.createdAt.slice(0, 10) === today && !['rejected', 'failed'].includes(p.status)).reduce((sum, p) => sum + amount(p.amount), 0) + payoutAmount;
  const monthlyVolume = existingPayments.filter((p) => p.createdAt.slice(0, 7) === month && !['rejected', 'failed'].includes(p.status)).reduce((sum, p) => sum + amount(p.amount), 0) + payoutAmount;
  if (dailyVolume > controls.dailySupplierPayoutLimit) { score += 35; redFlags.push(`Daily supplier payout limit would be exceeded (${money(dailyVolume)} USDC).`); }
  if (monthlyVolume > controls.monthlySupplierPayoutLimit) { score += 45; redFlags.push(`Monthly supplier payout limit would be exceeded (${money(monthlyVolume)} USDC).`); }

  // Bridge rail eligibility placeholder. Specific rails are validated by provider at execution time.
  if (supplier && !['usd', 'gbp', 'eur', 'mxn', 'brl'].includes(supplier.currency)) { blocked = true; redFlags.push('Destination currency is not supported for supplier payouts.'); }
  else checklist.push('Destination currency is supported by Sivan policy');

  const riskLevel = severity(score, blocked);
  const decision: SupplierRiskDecision = blocked
    ? 'block'
    : riskLevel === 'low' && controls.autoApproveApprovedSuppliers && supplier?.status === 'approved'
      ? 'auto_approve'
      : 'manual_review';

  const reviewReason = blocked
    ? redFlags[0] || 'Supplier payout blocked by risk controls.'
    : decision === 'auto_approve'
      ? 'Low-risk repeat supplier payment is eligible for backend auto-approval.'
      : redFlags[0] || 'Supplier payout requires manual review under beta controls.';

  return {
    riskLevel,
    riskScore: Math.min(100, Math.max(0, score)),
    decision,
    reviewReason,
    redFlags,
    missingEvidence,
    checklist,
    recommendedAction: decision === 'block' ? 'Reject or request enhanced compliance review before any payout.' : decision === 'auto_approve' ? 'Eligible for backend auto-approval. AI does not release funds.' : 'Hold for admin review before Bridge transfer execution.',
    complianceNote: 'AI/Ace may summarize this case for admins, but backend controls and authorized admins own the release decision. Sivan is holding settled stablecoin, not live fiat.',
    suggestedQuestions,
    auditSummary: `${riskLevel.toUpperCase()} supplier payout risk: ${reviewReason}`
  };
}

export function buildSupplierAceReview(review: SupplierRiskReview) {
  return {
    title: 'Ace Risk Review',
    riskLevel: review.riskLevel,
    riskScore: review.riskScore,
    recommendation: review.decision,
    summary: review.reviewReason,
    redFlags: review.redFlags,
    missingEvidence: review.missingEvidence,
    adminChecklist: review.checklist,
    suggestedQuestions: review.suggestedQuestions,
    complianceNote: review.complianceNote,
    auditReadyExplanation: review.auditSummary,
    aiPolicy: 'AI can recommend. Backend rules can auto-approve low-risk cases. Admin approves medium/high-risk cases. AI never releases funds.'
  };
}
