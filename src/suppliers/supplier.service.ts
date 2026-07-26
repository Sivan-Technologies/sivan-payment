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
  if (customer.kycStatus !== 'kyc_approved' || customer.tosStatus !== 'approved') throw badRequest('KYC and Terms approval are required before adding a supplier.');

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

export async function createSupplierPayment(input: z.infer<typeof createSupplierPaymentSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const controls = await getSupplierPaymentControls();
  if (!controls.supplierPaymentsEnabled) throw forbidden('Supplier payments are currently disabled.');
  const { data, user, customer } = await customerForUser(input.userId);
  const supplier = (data.suppliers ?? []).find((item) => item.id === input.supplierId && item.userId === input.userId);
  if (!supplier) throw notFound('Supplier');
  if (input.destinationCurrency !== supplier.currency) throw badRequest(`Supplier receives ${supplier.currency.toUpperCase()}, not ${input.destinationCurrency.toUpperCase()}.`);
  if (!supplier.providerExternalAccountId && !supplier.bridgeExternalAccountId) throw badRequest('Supplier bank account is not provider-ready yet. Ask admin to review/provider-check this supplier.');

  const available = (await getUserBalance(input.userId)).balances.find((item) => item.asset === input.sourceAsset)?.available ?? '0';
  if (amount(available) < input.amount) throw badRequest('Insufficient settled USDC balance for supplier payment.');

  const risk = evaluateSupplierRisk({ user, customer, supplier, amount: input.amount, paymentPurpose: input.paymentPurpose, invoiceUrl: input.invoiceUrl, controls, existingPayments: data.supplierPayments ?? [] });
  const route = routeSupplierPayout({ currency: supplier.currency, country: supplier.supplierCountry, accountType: supplier.accountType });
  const now = nowIso();
  const status = risk.decision === 'block' ? 'rejected' : risk.decision === 'auto_approve' ? 'approved' : 'pending_review';
  const payment: SupplierPaymentRecord = {
    id: id('spp'),
    userId: input.userId,
    supplierId: supplier.id,
    amount: money(input.amount),
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
    await createBalanceLedgerEntry({ userId: input.userId, customerId: customer.id, asset: input.sourceAsset, amount: payment.amount, kind: 'hold', status: 'held', sourceType: 'supplier_payment', sourceId: payment.id, description: `Hold settled USDC for supplier payout to ${supplier.supplierName}`, transferId: payment.id }, { actorType: 'user', actorId: input.userId });
  }
  await createAuditLog({ actorType: 'user', actorId: input.userId, action: 'supplier_payment.created', resourceType: 'supplier_payment', resourceId: payment.id, severity: risk.decision === 'block' ? 'error' : 'warning', ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { payment, supplier, risk, aceRiskReview: payment.aceRiskReview } });
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
  const settings = await getVirtualAccountProviderSettings({ includeSecrets: true }) as any;
  if (!settings.bridgeWalletId) throw badRequest('Bridge wallet ID is required before releasing supplier payouts. Configure it in Admin Hub virtual account settlement settings.');
  const provider = getOfframpProvider('bridge');
  if (!provider.createSupplierPayout) throw badRequest('Current provider adapter does not support supplier payout execution.');

  const providerTransfer = await provider.createSupplierPayout({
    customerId: customer.providerCustomerId,
    bridgeWalletId: settings.bridgeWalletId,
    amount: payment.amount,
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
