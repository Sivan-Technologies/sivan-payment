import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../database/json-database.js';
import { getOfframpProvider } from '../providers/provider-registry.js';
import { BridgeClient } from '../providers/bridge/bridge.client.js';
import { badRequest, forbidden, notFound } from '../shared/errors.js';
import { id, idempotencyKey, nowIso } from '../shared/id.js';
import { requireUser } from '../users/users.service.js';
import { mapBridgeKycStatus } from './customer-mapping.js';
import { requireCustomerTypeEnabled } from '../controls/payment-controls.service.js';

const optionalUrl = z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().url().optional());

export const startKycSchema = z.object({
  userId: z.string().min(1),
  type: z.enum(['individual', 'business']).default('individual'),
  redirectUri: optionalUrl,
  endorsements: z.array(z.string()).optional()
});


export const createBridgeCustomerSchema = z.object({
  userId: z.string().min(1),
  payload: z.record(z.string(), z.unknown())
});

export async function startKyc(input: z.infer<typeof startKycSchema>) {
  await requireCustomerTypeEnabled(input.type);
  const user = await requireUser(input.userId);
  const provider = getOfframpProvider();
  const existing = await getCustomerByUserId(input.userId).catch(() => null);

  if (existing?.provider === 'mock' && provider.name === 'bridge') {
    throw badRequest('This account has a legacy mock verification record. Start a fresh Bridge sandbox KYC/TOS verification before enabling real payment or virtual-account features.');
  }

  if (existing?.providerCustomerId) {
    // If we already have a hosted KYC/TOS link, return it immediately. Bridge can
    // reject re-generating a hosted link for an existing sandbox customer with a
    // 400, which left users stuck at "Not started" after account creation.
    if (existing.kycLink) return { ...existing, hostedKycLink: existing.kycLink };
    try {
      const hosted = await provider.getHostedKycLink(existing.providerCustomerId, input.redirectUri);
      return { ...existing, hostedKycLink: hosted.url };
    } catch (error) {
      if (existing.kycLink) return { ...existing, hostedKycLink: existing.kycLink };
      throw error;
    }
  }

  const kyc = await provider.createKycLink({
    email: user.email,
    fullName: user.fullName,
    type: input.type,
    redirectUri: input.redirectUri,
    endorsements: input.endorsements,
    idempotencyKey: idempotencyKey('kyc')
  });

  const now = nowIso();
  const customer = {
    id: id('cus'),
    userId: user.id,
    provider: provider.name,
    providerCustomerId: kyc.customerId,
    customerType: input.type,
    kycLinkId: kyc.id,
    kycLink: kyc.kycLink,
    tosLink: kyc.tosLink,
    kycStatus: mapBridgeKycStatus(kyc.kycStatus),
    tosStatus: kyc.tosStatus === 'approved' ? 'approved' as const : 'pending' as const,
    onboardingCostUsd: input.type === 'business' ? toMoney(env.BRIDGE_KYB_COST_USD) : toMoney(env.BRIDGE_KYC_COST_USD),
    onboardingCostType: input.type === 'business' ? 'kyb' as const : 'kyc' as const,
    onboardingCostRecordedAt: now,
    raw: kyc.raw,
    createdAt: now,
    updatedAt: now
  };
  return db.insertCustomerRecord(customer);
}

export async function createBridgeCustomer(input: z.infer<typeof createBridgeCustomerSchema>) {
  const requestedType = input.payload.type === 'business' ? 'business' : 'individual';
  await requireCustomerTypeEnabled(requestedType);
  const user = await requireUser(input.userId);
  const provider = getOfframpProvider();
  const existing = await getCustomerByUserId(input.userId).catch(() => null);
  if (existing) throw badRequest('User already has a provider customer');

  const payload = { client_reference_id: user.id, email: user.email, ...input.payload };
  const providerCustomer = await provider.createCustomer({ payload, idempotencyKey: idempotencyKey('customer') });
  const now = nowIso();
  const customer = {
    id: id('cus'),
    userId: user.id,
    provider: provider.name,
    providerCustomerId: providerCustomer.id,
    customerType: input.payload.type === 'business' ? 'business' as const : 'individual' as const,
    kycStatus: mapBridgeKycStatus(providerCustomer.status),
    onboardingCostUsd: input.payload.type === 'business' ? toMoney(env.BRIDGE_KYB_COST_USD) : toMoney(env.BRIDGE_KYC_COST_USD),
    onboardingCostType: input.payload.type === 'business' ? 'kyb' as const : 'kyc' as const,
    onboardingCostRecordedAt: now,
    raw: providerCustomer.raw,
    createdAt: now,
    updatedAt: now
  };
  return db.insertCustomerRecord(customer);
}

export async function getCustomerByUserId(userId: string) {
  const data = await db.read();
  const customer = data.customers.find((c) => c.userId === userId);
  if (!customer) throw notFound('Customer');
  return customer;
}

export async function refreshKycStatus(userId: string) {
  const customer = await getCustomerByUserId(userId);
  if (!customer.kycLinkId) return enrichCustomerKycAction(customer);
  const provider = getOfframpProvider(customer.provider);
  const kyc = await provider.getKycLink(customer.kycLinkId);
  const record = { ...customer, kycStatus: mapBridgeKycStatus(kyc.kycStatus), tosStatus: kyc.tosStatus === 'approved' ? 'approved' as const : 'pending' as const, raw: kyc.raw, updatedAt: nowIso() };
  const saved = await db.updateCustomerRecord(record);
  return enrichCustomerKycAction(saved);
}

function toMoney(value: number): string {
  return value.toFixed(2);
}


async function enrichCustomerKycAction<T extends { provider: string; providerCustomerId?: string; kycStatus?: string; tosStatus?: string }>(customer: T): Promise<T & { customerAction: ReturnType<typeof buildCustomerKycAction> }> {
  if (customer.provider !== 'bridge' || !customer.providerCustomerId || customer.kycStatus === 'kyc_approved') {
    return { ...customer, customerAction: buildCustomerKycAction(customer.kycStatus, customer.tosStatus) };
  }
  try {
    const bridgeCustomer: any = await new BridgeClient().request(`/customers/${customer.providerCustomerId}`);
    const missingRequirements = unique((bridgeCustomer.endorsements || []).flatMap((endorsement: any) => flattenRequirements(endorsement?.requirements?.missing)));
    const pendingRequirements = unique((bridgeCustomer.endorsements || []).flatMap((endorsement: any) => flattenRequirements(endorsement?.requirements?.pending)));
    const issueRequirements = unique((bridgeCustomer.endorsements || []).flatMap((endorsement: any) => flattenRequirements(endorsement?.requirements?.issues)));
    return { ...customer, customerAction: buildCustomerKycAction(customer.kycStatus, customer.tosStatus, { missingRequirements, pendingRequirements, issueRequirements }) };
  } catch {
    return { ...customer, customerAction: buildCustomerKycAction(customer.kycStatus, customer.tosStatus) };
  }
}

function buildCustomerKycAction(status?: string, tosStatus?: string, diagnostics: { missingRequirements?: string[]; pendingRequirements?: string[]; issueRequirements?: string[] } = {}) {
  const missing = unique(diagnostics.missingRequirements || []);
  const pending = unique(diagnostics.pendingRequirements || []);
  const issues = unique(diagnostics.issueRequirements || []);
  const actionable = missing.filter((item) => !providerOnlyRequirement(item));
  const providerOnly = missing.filter(providerOnlyRequirement);
  const friendly = actionable.map(humanRequirement);

  if (status === 'kyc_approved') {
    return { level: 'success', title: 'Verification successful', message: 'Your identity has been verified. You can now use Sivan Payment features that require KYC.', requirements: [], canContinue: false };
  }
  if (status === 'kyc_under_review') {
    return { level: 'review', title: 'Verification under review', message: 'Your verification has been submitted and is being reviewed by our provider. This page will update automatically.', requirements: [], canContinue: false };
  }
  if (['kyc_rejected', 'failed', 'cancelled'].includes(status || '')) {
    return { level: 'failed', title: 'Verification could not be completed', message: 'Your secure verification was not approved. Please retry verification or contact support if you need help.', requirements: friendly, canContinue: true };
  }
  if (status === 'kyc_incomplete') {
    if (friendly.length) {
      const list = formatHumanList(friendly);
      const processing = providerOnly.length ? ' If you already submitted this, our provider may still be processing your verification.' : '';
      return { level: 'action_required', title: 'Verification needs one more step', message: `Please complete your ${list} in the secure verification page.${processing}`, requirements: friendly, canContinue: true };
    }
    if (providerOnly.length || pending.length) {
      return { level: 'processing', title: 'Verification is still processing', message: 'Your verification is still being processed by our provider. Please refresh again in a few minutes.', requirements: providerOnly.map(humanRequirement), canContinue: false };
    }
    if (issues.length) {
      return { level: 'action_required', title: 'Verification needs attention', message: `Please review ${formatHumanList(issues.map(humanRequirement))} in the secure verification page.`, requirements: issues.map(humanRequirement), canContinue: true };
    }
    return { level: 'action_required', title: 'Verification needs one more step', message: 'Please continue the secure verification flow to finish your identity check.', requirements: [], canContinue: true };
  }
  if (tosStatus !== 'approved') {
    return { level: 'action_required', title: 'Provider terms required', message: 'Please accept the provider terms in the secure verification page.', requirements: ['provider terms'], canContinue: true };
  }
  return { level: 'neutral', title: 'Verification not started', message: 'Complete identity verification to unlock payments, higher limits, and account features.', requirements: [], canContinue: true };
}

function flattenRequirements(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenRequirements);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(flattenRequirements);
  return [String(value)];
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function providerOnlyRequirement(value: string) {
  return ['post_processing', 'kyc_approval', 'kyc_with_proof_of_address'].includes(value);
}

function humanRequirement(value: string) {
  const labels: Record<string, string> = {
    date_of_birth: 'date of birth',
    min_age_18: 'age confirmation',
    proof_of_address: 'proof of address',
    address_of_residence: 'residential address',
    selfie_verification: 'selfie verification',
    source_of_funds_questionnaire: 'source-of-funds questions',
    tax_identification_number: 'required identity details',
    terms_of_service_v1: 'provider terms',
    terms_of_service_v2: 'provider terms',
    post_processing: 'provider processing',
    kyc_approval: 'provider approval',
    kyc_with_proof_of_address: 'proof-of-address review'
  };
  return labels[value] || value.replaceAll('_', ' ');
}

function formatHumanList(values: string[]) {
  const uniqueValues = unique(values);
  if (uniqueValues.length <= 1) return uniqueValues[0] || 'remaining verification steps';
  if (uniqueValues.length === 2) return `${uniqueValues[0]} and ${uniqueValues[1]}`;
  return `${uniqueValues.slice(0, -1).join(', ')}, and ${uniqueValues[uniqueValues.length - 1]}`;
}

export async function simulateSandboxKycApproval(userId: string) {
  const customer = await getCustomerByUserId(userId);
  const provider = getOfframpProvider(customer.provider);
  if (!provider.simulateSandboxKycApproval) {
    throw badRequest('Current provider does not support sandbox KYC simulation');
  }
  const result: any = await provider.simulateSandboxKycApproval(customer.providerCustomerId, idempotencyKey('simulate-kyc'));
  const record = { ...customer, kycStatus: mapBridgeKycStatus(result?.kyc_status ?? 'approved'), raw: { previous: customer.raw, sandboxSimulation: result }, updatedAt: nowIso() };
  return db.updateCustomerRecord(record);
}

export async function forceSandboxKycApproval(userId: string, actorId = 'admin_api_key') {
  if (env.APP_ENV === 'production' || !env.BRIDGE_MOCK_MODE) {
    throw forbidden('Manual sandbox KYC force approval is disabled for Bridge verification. Use the Bridge sandbox hosted KYC/TOS flow for new users.');
  }
  const customer = await getCustomerByUserId(userId);
  if (customer.provider !== 'mock') {
    throw forbidden('Manual sandbox KYC force approval is only available for explicitly mock-mode customers. Bridge customers must be verified by Bridge sandbox.');
  }
  const now = nowIso();
  const record = {
    ...customer,
    kycStatus: 'kyc_approved' as const,
    tosStatus: 'approved' as const,
    raw: { previous: customer.raw, sandboxForceApproval: { actorId, approvedAt: now } },
    updatedAt: now
  };
  return db.updateCustomerRecord(record);
}
