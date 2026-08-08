import { z } from 'zod';
import { db } from '../database/json-database.js';
import type { SupplierControlsRecord, SupplierPaymentRecord, SupplierPayoutCurrency, SupplierRecord, SupplierStatus } from '../database/types.js';
import { getOfframpProvider } from '../providers/provider-registry.js';
import { createAuditLog } from '../audit/audit.service.js';
import { badRequest, forbidden, notFound } from '../shared/errors.js';
import { id, idempotencyKey, nowIso } from '../shared/id.js';
import { createBalanceLedgerEntry, getUserBalance } from '../balances/balance.service.js';
import { buildSupplierAceReview, defaultSupplierControls, evaluateSupplierRisk, supplierControlsSchema } from '../risk/supplier-risk.service.js';
import { routeSupplierPayout } from './supplier-provider-routing.service.js';
import { getVirtualAccountProviderSettings } from '../virtual-accounts/service/virtual-account-provider-settings.service.js';
import { resolveSettlementWalletId } from '../wallets/user-wallet.service.js';
import { requireCustomerTerms } from '../customers/customer-terms.js';
import { getAdminFeeSettings } from '../admin/admin-fees.service.js';
import {
  DEFAULT_SUPPLIER_FEE,
  SUPPLIER_VOLUME_COUNTING_STATUSES,
  SUPPLIER_VOLUME_WINDOW_DAYS,
  quoteSupplierFee,
  type SupplierFeeConfig,
} from './supplier-fee-policy.js';

const currencySchema = z.enum(['usd', 'gbp', 'eur', 'mxn', 'brl']);
const addressSchema = z.object({
  street_line_1: z.string().min(2),
  country: z.string().min(2).max(3),
  city: z.string().min(2),
  state: z.string().optional(),
  postal_code: z.string().min(2)
});

const baseSupplierSchema = z.object({
  userId: z.string().min(1),
  supplierName: z.string().min(2).max(160),
  supplierType: z.enum(['individual', 'business']).default('business'),
  supplierCountry: z.string().min(2).max(3).transform((value) => value.toUpperCase()),
  bankName: z.string().min(2).max(160),
  accountOwnerName: z.string().min(2).max(160),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  businessName: z.string().optional(),
  address: addressSchema
});

export const createSupplierSchema = z.discriminatedUnion('accountType', [
  baseSupplierSchema.extend({
    accountType: z.literal('us'),
    currency: z.literal('usd'),
    paymentRail: z.enum(['ach', 'wire']).default('ach'),
    account: z.object({ routing_number: z.string().length(9), account_number: z.string().min(4), checking_or_savings: z.enum(['checking', 'savings']).default('checking') })
  }),
  baseSupplierSchema.extend({
    accountType: z.literal('gb'),
    currency: z.literal('gbp'),
    paymentRail: z.literal('faster_payments').default('faster_payments'),
    account: z.object({ sort_code: z.string().length(6), account_number: z.string().length(8) })
  }),
  baseSupplierSchema.extend({
    accountType: z.literal('iban'),
    currency: z.literal('eur'),
    paymentRail: z.enum(['sepa', 'sepa_instant']).default('sepa'),
    iban: z.object({ account_number: z.string().min(10), bic: z.string().min(8).max(11).optional(), country: z.string().length(3) })
  }),
  baseSupplierSchema.extend({
    accountType: z.literal('clabe'),
    currency: z.literal('mxn'),
    paymentRail: z.literal('spei').default('spei'),
    clabe: z.object({ account_number: z.string().length(18) })
  }),
  baseSupplierSchema.extend({
    accountType: z.literal('pix'),
    currency: z.literal('brl'),
    paymentRail: z.literal('pix').default('pix'),
    pix: z.object({ key: z.string().min(5).max(120) })
  })
]);

export const createSupplierPaymentSchema = z.object({
  userId: z.string().min(1),
  supplierId: z.string().min(1),
  amount: z.coerce.number().positive(),
  sourceAsset: z.literal('usdc').default('usdc'),
  destinationCurrency: currencySchema,
  paymentPurpose: z.string().min(5).max(500),
  invoiceUrl: z.string().url().optional()
});

export const reviewSupplierSchema = z.object({
  decision: z.enum(['approve', 'reject', 'disable']),
  reviewedBy: z.string().min(2).default('admin_api_key'),
  reason: z.string().min(3).max(1000)
});

export const reviewSupplierPaymentSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reviewedBy: z.string().min(2).default('admin_api_key'),
  reason: z.string().min(3).max(1000)
});

function amount(value: unknown) { const n = Number(value ?? 0); return Number.isFinite(n) ? n : 0; }
function money(value: number) { return value.toFixed(6).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1'); }
function last4FromInput(input: z.infer<typeof createSupplierSchema>) {
  if ('account' in input) return input.account.account_number.slice(-4);
  if ('iban' in input) return input.iban.account_number.slice(-4);
  if ('clabe' in input) return input.clabe.account_number.slice(-4);
  if ('pix' in input) return input.pix.key.slice(-4);
  return undefined;
}

function paymentRailForSupplier(supplier: SupplierRecord) {
  if (supplier.currency === 'usd') return 'ach';
  if (supplier.currency === 'gbp') return 'faster_payments';
  if (supplier.currency === 'eur') return 'sepa';
  if (supplier.currency === 'mxn') return 'spei';
  if (supplier.currency === 'brl') return 'pix';
  return 'unknown';
}

function providerPayload(input: z.infer<typeof createSupplierSchema>) {
  const payload: Record<string, unknown> = {
    currency: input.currency,
    account_type: input.accountType,
    bank_name: input.bankName,
    account_name: `${input.accountOwnerName} supplier account`,
    account_owner_name: input.accountOwnerName,
    account_owner_type: input.supplierType,
    first_name: input.firstName,
    last_name: input.lastName,
    business_name: input.businessName || (input.supplierType === 'business' ? input.supplierName : undefined),
    address: input.address
  };
  if ('account' in input) payload.account = input.account;
  if ('iban' in input) payload.iban = input.iban;
  if ('clabe' in input) payload.clabe = input.clabe;
  if ('pix' in input) payload.pix = input.pix;
  return payload;
}

async function customerForUser(userId: string) {
  const data = await db.read();
  const user = data.users.find((item) => item.id === userId);
  if (!user) throw notFound('User');
  const customer = data.customers.find((item) => item.userId === userId);
  if (!customer) throw badRequest('Complete Bridge KYC before adding suppliers.');
  return { data, user, customer };
}

export async function getSupplierPaymentControls() {
  const data = await db.read();
  return data.supplierControls?.find((item) => item.id === 'global') ?? defaultSupplierControls();
}

export async function updateSupplierPaymentControls(input: z.infer<typeof supplierControlsSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const current = await getSupplierPaymentControls();
  const parsed = supplierControlsSchema.parse(input);
  const next: SupplierControlsRecord = { ...current, ...parsed, id: 'global', updatedAt: nowIso() };
  await db.upsertSupplierControlsRecord(next);
  await createAuditLog({ actorType: 'admin', actorId: parsed.updatedBy, action: 'supplier.controls.updated', resourceType: 'supplier_controls', resourceId: 'global', severity: 'warning', ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { previous: current, settings: next, reason: parsed.reason } });
  return next;
}

export async function createSupplier(input: z.infer<typeof createSupplierSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const controls = await getSupplierPaymentControls();
  if (!controls.supplierPaymentsEnabled) throw forbidden('Supplier payments are currently disabled.');
  if (!controls.thirdPartySupplierPayoutsEnabled) throw forbidden('Third-party supplier payouts are currently disabled.');
  const { data, user, customer } = await customerForUser(input.userId);
  if (customer.kycStatus !== 'kyc_approved') throw badRequest('KYC and Terms approval are required before adding a supplier.');
  // Was an inline `tosStatus !== 'approved'` with the message above. Routed
  // through the shared gate so this site says the same actionable thing as
  // every other one, and cannot drift from the rule.
  requireCustomerTerms(customer);

  const route = routeSupplierPayout({ currency: input.currency as SupplierPayoutCurrency, country: input.supplierCountry, accountType: input.accountType });
  const provider = getOfframpProvider(route.provider === 'bridge' ? customer.provider : route.provider);
  let providerAccount: any | undefined;
  try {
    providerAccount = await provider.createExternalAccount({ customerId: customer.providerCustomerId, payload: providerPayload(input), idempotencyKey: idempotencyKey('supplier_ea') });
  } catch (error) {
    // Store the supplier for compliance review even if provider setup fails, but keep it pending.
    providerAccount = { error: error instanceof Error ? error.message : String(error) };
  }

  const now = nowIso();
  const pendingSupplier: SupplierRecord = {
    id: id('sup'),
    userId: input.userId,
    customerId: customer.id,
    supplierName: input.supplierName,
    supplierType: input.supplierType,
    supplierCountry: input.supplierCountry,
    currency: input.currency as SupplierPayoutCurrency,
    bankName: providerAccount.bankName || input.bankName,
    accountOwnerName: providerAccount.accountOwnerName || input.accountOwnerName,
    accountType: input.accountType,
    accountLast4: providerAccount.last4 || last4FromInput(input),
    provider: route.provider,
    providerExternalAccountId: providerAccount.id,
    providerRail: route.rail,
    bridgeExternalAccountId: route.provider === 'bridge' ? providerAccount.id : undefined,
    status: 'pending_review',
    riskLevel: 'medium',
    riskScore: 35,
    reviewReason: 'New third-party supplier requires admin review before first payout.',
    raw: { providerRoute: route, provider: providerAccount.raw ? { id: providerAccount.id, active: providerAccount.active, currency: providerAccount.currency, account_type: providerAccount.accountType } : providerAccount, paymentRail: route.rail },
    createdAt: now,
    updatedAt: now
  };

  const risk = evaluateSupplierRisk({ user, customer, supplier: pendingSupplier, controls, existingPayments: data.supplierPayments ?? [] });
  const record = { ...pendingSupplier, riskLevel: risk.riskLevel, riskScore: risk.riskScore, reviewReason: risk.reviewReason };
  await db.insertSupplierRecord(record);
  await createAuditLog({ actorType: 'user', actorId: input.userId, action: 'supplier.created', resourceType: 'supplier', resourceId: record.id, severity: 'warning', ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { supplier: record, risk, aceRiskReview: buildSupplierAceReview(risk) } });
  return { ...record, aceRiskReview: buildSupplierAceReview(risk) };
}

export async function listUserSuppliers(userId: string) {
  const data = await db.read();
  return (data.suppliers ?? []).filter((item) => item.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listAdminSuppliers() {
  const data = await db.read();
  return (data.suppliers ?? []).map((supplier) => ({ ...supplier, user: data.users.find((user) => user.id === supplier.userId) ?? null, customer: data.customers.find((customer) => customer.id === supplier.customerId) ?? null })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getSupplier(supplierId: string) {
  const data = await db.read();
  const supplier = (data.suppliers ?? []).find((item) => item.id === supplierId);
  if (!supplier) throw notFound('Supplier');
  return supplier;
}


/**
 * The user's settled supplier volume over the rolling window.
 *
 * Counts the NET paid to suppliers, not the gross. Charging fees on fees to
 * decide a discount would inflate a user toward the next tier using Sivan's
 * own margin - the discount is meant to reward what they actually send.
 *
 * Falls back to `amount` for records written before the split existed; for
 * those gross and net were the same thing.
 */
export async function getSupplierVolumeUsd(userId: string, preloaded?: any): Promise<number> {
  const data = preloaded ?? await db.read();
  const cutoff = Date.now() - SUPPLIER_VOLUME_WINDOW_DAYS * 86_400_000;
  const withinWindow = (iso?: string) => {
    const at = Date.parse(iso ?? '');
    return Number.isFinite(at) && at >= cutoff;
  };

  const counting = new Set<string>(SUPPLIER_VOLUME_COUNTING_STATUSES);
  const supplierVolume = (data.supplierPayments ?? [])
    .filter((item: SupplierPaymentRecord) => item.userId === userId)
    .filter((item: SupplierPaymentRecord) => counting.has(item.status))
    .filter((item: SupplierPaymentRecord) => withinWindow(item.createdAt))
    .reduce((total: number, item: SupplierPaymentRecord) => total + amount(item.netAmount ?? item.amount), 0);

  /**
   * ALL SIVAN VOLUME COUNTS, NOT JUST SUPPLIER PAYMENTS.
   *
   * The discount originally measured supplier payments alone, which punished
   * the customer it was designed to reward: a business off-ramping $80k a
   * month and paying two suppliers $3k was treated as a $3k customer. They are
   * a large customer of Sivan, and the loyalty tier should say so.
   *
   * It also created a perverse incentive - to reach a supplier discount you
   * had to route MORE through the single most compliance-expensive flow,
   * rather than through the cheap ones.
   *
   * Off-ramp withdrawals are included because they are the same wallet, the
   * same KYC and the same balance sheet. What Sivan CANNOT see is volume the
   * user settles through another provider entirely, and no amount of internal
   * accounting fixes that - see the manual override below, which is the
   * honest answer to it.
   */
  const withdrawals = await db.listWithdrawalsByUserSince(userId, new Date(cutoff).toISOString()).catch(() => []);
  const withdrawalVolume = withdrawals.reduce(
    (total: number, item: any) => total + amount(item.sourceAmount ?? item.destinationAmount ?? 0),
    0
  );

  const earned = supplierVolume + withdrawalVolume;

  /**
   * AN ADMIN-GRANTED FLOOR, for volume Sivan genuinely cannot observe.
   *
   * A user who settles half their invoices through another provider is a
   * bigger customer than Sivan's own records show, and there is no technical
   * way to discover that - inferring it would be inventing data. So the
   * product answer is a deliberate human one: sales agrees a tier, an admin
   * records it with a reason and an expiry, and it is applied as a FLOOR.
   *
   * A floor, not a replacement: if the user's real Sivan volume grows past
   * the granted figure, the higher one wins and the grant quietly stops
   * mattering. Directly modelled on the per-user limit overrides in
   * user-limits.service.ts, which solve the same "the rule is right but this
   * customer is an exception" problem.
   */
  const granted = await getGrantedVolumeFloorUsd(userId, data);
  return Math.max(earned, granted);
}

/**
 * An admin-granted volume floor for one user, or 0.
 *
 * Expiry is enforced here rather than by a cleanup job: a grant that outlives
 * its review date should stop applying on its own, because the failure mode of
 * a forgotten discount is one that never ends.
 */
export async function getGrantedVolumeFloorUsd(userId: string, preloaded?: any): Promise<number> {
  const data = preloaded ?? await db.read();
  const now = Date.now();
  return (data.supplierVolumeGrants ?? [])
    .filter((row: any) => row.userId === userId)
    .filter((row: any) => !row.expiresAt || Date.parse(row.expiresAt) > now)
    .reduce((highest: number, row: any) => Math.max(highest, amount(row.volumeUsd)), 0);
}

/**
 * The active fee curve.
 *
 * Reads the admin fee settings so a pricing change takes effect with no
 * deploy, and falls back to the shipped default when the fee tab has never
 * been saved. Kept in one place so the quote endpoint and the payment path
 * cannot disagree about what a payment costs.
 */
export async function getSupplierFeeConfig(): Promise<SupplierFeeConfig> {
  try {
    const settings: any = await getAdminFeeSettings();
    if (!settings) return DEFAULT_SUPPLIER_FEE;
    return {
      tiers: settings.supplierFeeTiers?.length ? settings.supplierFeeTiers : DEFAULT_SUPPLIER_FEE.tiers,
      volumeDiscounts: settings.supplierVolumeDiscounts?.length ? settings.supplierVolumeDiscounts : DEFAULT_SUPPLIER_FEE.volumeDiscounts,
      minimumUsd: settings.supplierFeeMinimumUsd ?? DEFAULT_SUPPLIER_FEE.minimumUsd,
      maximumUsd: settings.supplierFeeMaximumUsd ?? DEFAULT_SUPPLIER_FEE.maximumUsd,
      newSupplierUsd: settings.supplierNewSupplierFeeUsd ?? DEFAULT_SUPPLIER_FEE.newSupplierUsd,
      newSupplierMaxPercent: settings.supplierNewSupplierMaxPercent ?? DEFAULT_SUPPLIER_FEE.newSupplierMaxPercent,
    };
  } catch {
    return DEFAULT_SUPPLIER_FEE;
  }
}

/**
 * Quote a supplier payment without creating one.
 *
 * The confirm dialog calls this. It must run the SAME code the payment path
 * runs - a UI that quotes a different fee from the one charged is a support
 * ticket that reads as theft.
 */
export async function quoteSupplierPayment(userId: string, netAmount: number, supplierId?: string) {
  const data = await db.read();
  const volumeUsd = await getSupplierVolumeUsd(userId, data);
  const config = await getSupplierFeeConfig();
  const isFirstPaymentToSupplier = supplierId ? isFirstPaymentTo(data, userId, supplierId) : false;
  return {
    ...quoteSupplierFee(netAmount, volumeUsd, config, { isFirstPaymentToSupplier }),
    windowDays: SUPPLIER_VOLUME_WINDOW_DAYS,
  };
}

/**
 * Has this user already paid this supplier?
 *
 * MIRRORS supplier-risk.service.ts EXACTLY - same statuses, same question - so
 * the payment that gets scored as "first payout to this supplier" is the same
 * one charged the setup fee. If these two ever disagree, a user is charged for
 * a review that did not happen or gets a free one that did.
 */
function isFirstPaymentTo(data: any, userId: string, supplierId: string): boolean {
  return !(data.supplierPayments ?? []).some((payment: SupplierPaymentRecord) =>
    payment.userId === userId
    && payment.supplierId === supplierId
    && ['approved', 'processing', 'completed'].includes(payment.status)
  );
}

/**
 * Record an admin-granted volume floor.
 *
 * The answer to volume Sivan cannot observe. Requires a reason and defaults to
 * expiring, because an unexplained permanent discount is how pricing quietly
 * stops meaning anything.
 */
export const grantSupplierVolumeSchema = z.object({
  userId: z.string().min(1),
  volumeUsd: z.coerce.number().min(0).max(100_000_000),
  reason: z.string().min(10).max(1000),
  grantedBy: z.string().min(2).default('admin_api_key'),
  /** Days until it lapses. 0 means no expiry, which must be chosen explicitly. */
  expiresInDays: z.coerce.number().int().min(0).max(3650).default(90),
});

export async function grantSupplierVolume(
  input: z.infer<typeof grantSupplierVolumeSchema>,
  context: { ipAddress?: string; userAgent?: string } = {}
) {
  /**
   * VALIDATED HERE, not only at the route.
   *
   * The route parses the body, so an HTTP caller could not skip the rules -
   * but any internal caller could, and this function hands out a discount on
   * Sivan's own margin. Caught by test: a grant with the reason "because"
   * was accepted, defeating the requirement that every grant carry an
   * auditable rationale.
   */
  input = grantSupplierVolumeSchema.parse(input);
  const now = nowIso();
  const record = {
    id: id('svg'),
    userId: input.userId,
    volumeUsd: money(input.volumeUsd),
    reason: input.reason,
    grantedBy: input.grantedBy,
    expiresAt: input.expiresInDays > 0
      ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString()
      : undefined,
    createdAt: now,
    updatedAt: now,
  };
  await db.mutate((d: any) => {
    d.supplierVolumeGrants = d.supplierVolumeGrants ?? [];
    d.supplierVolumeGrants.push(record);
    return 1;
  });
  /**
   * AUDITED AS A WARNING. This hands a customer a permanent discount on
   * Sivan's own margin without any transaction to justify it, which is
   * precisely the kind of decision that should be easy to find later.
   */
  await createAuditLog({
    actorType: 'admin',
    actorId: input.grantedBy,
    action: 'supplier.volume_grant_created',
    resourceType: 'supplier_volume_grant',
    resourceId: record.id,
    severity: 'warning',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { grant: record },
  });
  return record;
}

export async function createSupplierPayment(input: z.infer<typeof createSupplierPaymentSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const controls = await getSupplierPaymentControls();
  if (!controls.supplierPaymentsEnabled) throw forbidden('Supplier payments are currently disabled.');
  const { data, user, customer } = await customerForUser(input.userId);
  const supplier = (data.suppliers ?? []).find((item) => item.id === input.supplierId && item.userId === input.userId);
  if (!supplier) throw notFound('Supplier');
  if (input.destinationCurrency !== supplier.currency) throw badRequest(`Supplier receives ${supplier.currency.toUpperCase()}, not ${input.destinationCurrency.toUpperCase()}.`);
  if (!supplier.providerExternalAccountId && !supplier.bridgeExternalAccountId) throw badRequest('Supplier bank account is not provider-ready yet. Ask admin to review/provider-check this supplier.');

  /**
   * PRICE THE PAYMENT BEFORE CHECKING THE BALANCE.
   *
   * The fee is ADDED, not deducted - a supplier invoicing $1,000 receives
   * $1,000 - so the user must be able to cover amount + fee. Checking the
   * balance against the bare amount would accept a payment the user cannot
   * actually fund, and the shortfall would surface at release, after a
   * compliance review, as a failure on money already held.
   */
  const volumeUsd = await getSupplierVolumeUsd(input.userId, data);
  const feeConfig = await getSupplierFeeConfig();
  const quote = quoteSupplierFee(input.amount, volumeUsd, feeConfig, {
    // Same question the risk engine asks, from the same data, so the payment
    // charged for onboarding is the one that actually triggers the review.
    isFirstPaymentToSupplier: isFirstPaymentTo(data, input.userId, supplier.id),
  });
  const grossAmount = Number(quote.grossAmount);

  const available = (await getUserBalance(input.userId)).balances.find((item) => item.asset === input.sourceAsset)?.available ?? '0';
  if (amount(available) < grossAmount) {
    throw badRequest(
      `Insufficient settled USDC balance. This payment needs ${quote.grossAmount} USDC ` +
      `(${quote.netAmount} to your supplier plus a ${quote.fee} fee) and you have ${available}.`
    );
  }

  const risk = evaluateSupplierRisk({ user, customer, supplier, amount: input.amount, paymentPurpose: input.paymentPurpose, invoiceUrl: input.invoiceUrl, controls, existingPayments: data.supplierPayments ?? [] });
  const route = routeSupplierPayout({ currency: supplier.currency, country: supplier.supplierCountry, accountType: supplier.accountType });
  const now = nowIso();
  const status = risk.decision === 'block' ? 'rejected' : risk.decision === 'auto_approve' ? 'approved' : 'pending_review';
  const payment: SupplierPaymentRecord = {
    id: id('spp'),
    userId: input.userId,
    supplierId: supplier.id,
    // GROSS. Bridge deducts developer_fee from the transfer amount, so the
    // gross is what must be sent for the supplier to receive the net.
    amount: quote.grossAmount,
    netAmount: quote.netAmount,
    feeAmount: quote.fee,
    feeEffectivePercent: quote.effectivePercent,
    feeVolumeDiscountPercent: quote.volumeDiscountPercent,
    feeVolumeUsd: quote.volumeUsd,
    feeNewSupplierAmount: quote.newSupplierFee,
    sourceAsset: input.sourceAsset,
    destinationCurrency: input.destinationCurrency,
    paymentPurpose: input.paymentPurpose,
    invoiceUrl: input.invoiceUrl,
    status,
    provider: route.provider,
    providerRail: route.rail,
    executionMode: route.executionMode,
    riskLevel: risk.riskLevel,
    riskScore: risk.riskScore,
    reviewReason: risk.reviewReason,
    aceRiskReview: buildSupplierAceReview(risk),
    raw: { providerRoute: route, paymentRail: route.rail || paymentRailForSupplier(supplier), execution: 'provider_execution_pending_phase_e' },
    createdAt: now,
    updatedAt: now
  };
  await db.insertSupplierPaymentRecord(payment);
  if (status !== 'rejected') {
    await createBalanceLedgerEntry({ userId: input.userId, customerId: customer.id, asset: input.sourceAsset, amount: payment.amount, kind: 'hold', status: 'held', sourceType: 'supplier_payment', sourceId: payment.id, description: `Hold ${quote.grossAmount} USDC for supplier payout to ${supplier.supplierName} (${quote.netAmount} to supplier + ${quote.fee} fee)`, transferId: payment.id }, { actorType: 'user', actorId: input.userId });
  }
  await createAuditLog({ actorType: 'user', actorId: input.userId, action: 'supplier_payment.created', resourceType: 'supplier_payment', resourceId: payment.id, severity: risk.decision === 'block' ? 'error' : 'warning', ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { payment, supplier, risk, aceRiskReview: payment.aceRiskReview, feeQuote: quote } });
  return { ...payment, supplier };
}

export async function listUserSupplierPayments(userId: string) {
  const data = await db.read();
  return (data.supplierPayments ?? []).filter((item) => item.userId === userId).map((payment) => ({ ...payment, supplier: (data.suppliers ?? []).find((supplier) => supplier.id === payment.supplierId) ?? null })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listAdminSupplierPayments() {
  const data = await db.read();
  return (data.supplierPayments ?? []).map((payment) => ({ ...payment, supplier: (data.suppliers ?? []).find((supplier) => supplier.id === payment.supplierId) ?? null, user: data.users.find((user) => user.id === payment.userId) ?? null })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getSupplierPayment(paymentId: string) {
  const data = await db.read();
  const payment = (data.supplierPayments ?? []).find((item) => item.id === paymentId);
  if (!payment) throw notFound('Supplier payment');
  return { ...payment, supplier: (data.suppliers ?? []).find((item) => item.id === payment.supplierId) ?? null, user: data.users.find((item) => item.id === payment.userId) ?? null };
}

export async function reviewSupplier(supplierId: string, input: z.infer<typeof reviewSupplierSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const supplier = await getSupplier(supplierId);
  const nextStatus: SupplierStatus = input.decision === 'approve' ? 'approved' : input.decision === 'disable' ? 'disabled' : 'rejected';
  const updated = { ...supplier, status: nextStatus, reviewReason: input.reason, updatedAt: nowIso() };
  await db.updateSupplierRecord(updated);
  await createAuditLog({ actorType: 'admin', actorId: input.reviewedBy, action: 'supplier.reviewed', resourceType: 'supplier', resourceId: supplierId, severity: nextStatus === 'approved' ? 'info' : 'warning', ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { decision: input.decision, reason: input.reason, supplier: updated } });
  return updated;
}

export async function reviewSupplierPayment(paymentId: string, input: z.infer<typeof reviewSupplierPaymentSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const current = await getSupplierPayment(paymentId) as SupplierPaymentRecord & { supplier?: SupplierRecord | null };
  if (!['pending_review', 'approved'].includes(current.status)) throw badRequest('Supplier payment is not reviewable.');
  const now = nowIso();
  const status = input.decision === 'approve' ? 'approved' : 'rejected';
  const updated: SupplierPaymentRecord = { ...current, status, adminDecision: input.decision === 'approve' ? 'approved' : 'rejected', adminDecisionBy: input.reviewedBy, adminDecisionAt: now, reviewReason: input.reason, updatedAt: now };
  await db.updateSupplierPaymentRecord(updated);
  if (status === 'rejected') {
    await createBalanceLedgerEntry({ userId: updated.userId, asset: updated.sourceAsset, amount: updated.amount, kind: 'hold_release', status: 'available', sourceType: 'supplier_payment', sourceId: updated.id, description: `Release supplier payout hold after rejection`, transferId: updated.id }, { actorType: 'admin', actorId: input.reviewedBy });
  }
  await createAuditLog({ actorType: 'admin', actorId: input.reviewedBy, action: 'supplier_payment.reviewed', resourceType: 'supplier_payment', resourceId: paymentId, severity: status === 'approved' ? 'warning' : 'info', ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { decision: input.decision, reason: input.reason, payment: updated, supplier: current.supplier, execution: 'Bridge transfer execution remains disabled until Phase E provider execution is implemented.' } });
  return updated;
}

function mapProviderTransferStatus(rawStatus?: string): SupplierPaymentRecord['status'] {
  const status = String(rawStatus || '').toLowerCase();
  if (['completed', 'payment_processed', 'succeeded', 'success'].includes(status)) return 'completed';
  if (['failed', 'canceled', 'cancelled', 'rejected'].includes(status)) return 'failed';
  return 'processing';
}

function providerTransferStatus(raw: any): string | undefined {
  return raw?.state || raw?.status || raw?.transfer?.state || raw?.data?.state;
}

async function markSupplierPaymentCompleted(payment: SupplierPaymentRecord, raw: unknown) {
  const updated: SupplierPaymentRecord = { ...payment, status: 'completed', raw: { ...(payment.raw as any ?? {}), providerTransfer: raw }, updatedAt: nowIso() };
  await db.updateSupplierPaymentRecord(updated);
  await createBalanceLedgerEntry({ userId: payment.userId, asset: payment.sourceAsset, amount: payment.amount, kind: 'debit_transfer', status: 'completed', sourceType: 'supplier_payment', sourceId: payment.id, description: `Debit held USDC after supplier payout completion`, transferId: payment.id }, { actorType: 'provider', actorId: payment.provider || 'provider' });
  await createAuditLog({ actorType: 'provider', actorId: payment.provider || 'provider', action: 'supplier_payment.completed', resourceType: 'supplier_payment', resourceId: payment.id, severity: 'info', metadata: { payment: updated, providerTransfer: raw } });
  return updated;
}

export const releaseSupplierPaymentSchema = z.object({
  releasedBy: z.string().min(2).default('admin_api_key'),
  reason: z.string().min(3).max(1000).default('Release approved supplier payment to provider')
});

export async function releaseSupplierPaymentToProvider(paymentId: string, input: z.infer<typeof releaseSupplierPaymentSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const data = await db.read();
  const payment = (data.supplierPayments ?? []).find((item) => item.id === paymentId);
  if (!payment) throw notFound('Supplier payment');
  const supplier = (data.suppliers ?? []).find((item) => item.id === payment.supplierId);
  if (!supplier) throw notFound('Supplier');
  const customer = data.customers.find((item) => item.id === supplier.customerId);
  if (!customer) throw notFound('Customer');
  if (payment.status === 'completed') return payment;
  if (!['approved', 'processing'].includes(payment.status)) throw badRequest('Supplier payment must be admin-approved before provider release.');
  const providerName = payment.provider || supplier.provider || 'bridge';
  if (providerName !== 'bridge') throw badRequest(`Provider execution is not implemented for ${providerName}. Use manual treasury fallback.`);
  const externalAccountId = supplier.providerExternalAccountId || supplier.bridgeExternalAccountId;
  if (!externalAccountId) throw badRequest('Supplier has no provider external account id.');
  // Fund the payout from THIS customer's own Bridge wallet, never a pooled
  // Sivan wallet. Previously this used the global settlement wallet while
  // passing the user's customerId, so one user's supplier payment was drawn
  // from a treasury balance holding every user's funds. That is Sivan holding
  // and moving funds on behalf of users, which Bridge ToS 2.1(m) prohibits.
  const userWalletId = await resolveSettlementWalletId(payment.userId);
  const provider = getOfframpProvider('bridge');
  if (!provider.createSupplierPayout) throw badRequest('Current provider adapter does not support supplier payout execution.');

  /**
   * SEND THE FEE, OR SIVAN COLLECTS NOTHING.
   *
   * This call omitted developer_fee entirely, so even once the fee was priced,
   * held and shown to the user, Bridge would have paid the FULL gross to the
   * supplier and Sivan would have earned zero while the user was debited for
   * the fee. The fee is stored on the record at creation precisely so it
   * survives the review queue and arrives here.
   *
   * Undefined for records created before supplier pricing existed - those were
   * genuinely free, and sending "0.00" would be a different claim from sending
   * nothing.
   */
  const developerFee = payment.feeAmount && Number(payment.feeAmount) > 0 ? payment.feeAmount : undefined;

  const providerTransfer = await provider.createSupplierPayout({
    customerId: customer.providerCustomerId,
    bridgeWalletId: userWalletId,
    amount: payment.amount,
    developerFee,
    sourceCurrency: payment.sourceAsset,
    destinationCurrency: payment.destinationCurrency,
    destinationPaymentRail: payment.providerRail || supplier.providerRail || paymentRailForSupplier(supplier),
    externalAccountId,
    clientReferenceId: payment.id,
    idempotencyKey: idempotencyKey('supplier_payout')
  });
  const mappedStatus = mapProviderTransferStatus(providerTransfer.status);
  const updated: SupplierPaymentRecord = {
    ...payment,
    status: mappedStatus,
    provider: 'bridge',
    providerTransferId: providerTransfer.id,
    bridgeTransferId: providerTransfer.id,
    providerRail: payment.providerRail || supplier.providerRail || paymentRailForSupplier(supplier),
    executionMode: 'provider',
    raw: { ...(payment.raw as any ?? {}), releaseReason: input.reason, providerTransfer: providerTransfer.raw },
    updatedAt: nowIso()
  };
  await db.updateSupplierPaymentRecord(updated);
  await createAuditLog({ actorType: 'admin', actorId: input.releasedBy, action: 'supplier_payment.released_to_provider', resourceType: 'supplier_payment', resourceId: payment.id, severity: 'warning', ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { reason: input.reason, payment: updated, supplier, providerTransfer: providerTransfer.raw } });
  if (mappedStatus === 'completed') return markSupplierPaymentCompleted(updated, providerTransfer.raw);
  return updated;
}

export async function syncSupplierPaymentProviderStatus(paymentId: string) {
  const data = await db.read();
  const payment = (data.supplierPayments ?? []).find((item) => item.id === paymentId);
  if (!payment) throw notFound('Supplier payment');
  if (!payment.providerTransferId && !payment.bridgeTransferId) throw badRequest('Supplier payment has not been released to a provider yet.');
  const provider = getOfframpProvider(payment.provider || 'bridge');
  if (!provider.getTransfer) throw badRequest('Current provider adapter does not support transfer sync.');
  const raw: any = await provider.getTransfer(payment.providerTransferId || payment.bridgeTransferId!);
  const mappedStatus = mapProviderTransferStatus(providerTransferStatus(raw));
  if (mappedStatus === 'completed') return markSupplierPaymentCompleted(payment, raw);
  const updated: SupplierPaymentRecord = { ...payment, status: mappedStatus, raw: { ...(payment.raw as any ?? {}), providerTransfer: raw }, updatedAt: nowIso() };
  await db.updateSupplierPaymentRecord(updated);
  await createAuditLog({ actorType: 'provider', actorId: payment.provider || 'provider', action: 'supplier_payment.synced', resourceType: 'supplier_payment', resourceId: payment.id, severity: mappedStatus === 'failed' ? 'error' : 'info', metadata: { payment: updated, providerTransfer: raw } });
  return updated;
}

export async function listSupplierRiskCases() {
  const data = await db.read();
  const suppliers = data.suppliers ?? [];
  const payments = data.supplierPayments ?? [];
  const supplierCases = suppliers.filter((supplier) => ['pending_review', 'rejected'].includes(supplier.status)).map((supplier) => ({
    id: `supplier:${supplier.id}`,
    title: `Supplier review · ${supplier.supplierName}`,
    type: 'supplier_review',
    resourceType: 'supplier',
    resourceId: supplier.id,
    userId: supplier.userId,
    severity: supplier.riskLevel,
    status: supplier.status === 'pending_review' ? 'open' : 'closed',
    createdAt: supplier.createdAt,
    supplier,
    aceRiskReview: { title: 'Ace Risk Review', riskLevel: supplier.riskLevel, riskScore: supplier.riskScore, recommendation: supplier.status === 'pending_review' ? 'manual_review' : 'closed', summary: supplier.reviewReason, aiPolicy: 'AI can recommend only. Admin releases; AI never releases funds.' }
  }));
  const paymentCases = payments.filter((payment) => ['pending_review', 'rejected'].includes(payment.status)).map((payment) => ({
    id: `supplier_payment:${payment.id}`,
    title: `Supplier payment · ${payment.amount} ${payment.sourceAsset.toUpperCase()}`,
    type: 'supplier_payment_review',
    resourceType: 'supplier_payment',
    resourceId: payment.id,
    userId: payment.userId,
    severity: payment.riskLevel,
    status: payment.status === 'pending_review' ? 'open' : 'closed',
    createdAt: payment.createdAt,
    supplier: suppliers.find((supplier) => supplier.id === payment.supplierId) ?? null,
    payment,
    aceRiskReview: payment.aceRiskReview
  }));
  return [...supplierCases, ...paymentCases].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
