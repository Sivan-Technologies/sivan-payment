import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../database/json-database.js';
import { getOfframpProvider } from '../providers/provider-registry.js';
import { badRequest, notFound } from '../shared/errors.js';
import { id, idempotencyKey, nowIso } from '../shared/id.js';
import { requireUser } from '../users/users.service.js';
import { mapBridgeKycStatus } from './customer-mapping.js';
import { requireCustomerTypeEnabled } from '../controls/payment-controls.service.js';

export const startKycSchema = z.object({
  userId: z.string().min(1),
  type: z.enum(['individual', 'business']).default('individual'),
  redirectUri: z.string().url().optional(),
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

  if (existing?.providerCustomerId) {
    const hosted = await provider.getHostedKycLink(existing.providerCustomerId, input.redirectUri);
    return { ...existing, hostedKycLink: hosted.url };
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
  return db.mutate((data) => {
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
    data.customers.push(customer);
    return customer;
  });
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
  return db.mutate((data) => {
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
    data.customers.push(customer);
    return customer;
  });
}

export async function getCustomerByUserId(userId: string) {
  const data = await db.read();
  const customer = data.customers.find((c) => c.userId === userId);
  if (!customer) throw notFound('Customer');
  return customer;
}

export async function refreshKycStatus(userId: string) {
  const customer = await getCustomerByUserId(userId);
  if (!customer.kycLinkId) return customer;
  const provider = getOfframpProvider(customer.provider);
  const kyc = await provider.getKycLink(customer.kycLinkId);
  return db.mutate((data) => {
    const record = data.customers.find((c) => c.id === customer.id)!;
    record.kycStatus = mapBridgeKycStatus(kyc.kycStatus);
    record.tosStatus = kyc.tosStatus === 'approved' ? 'approved' : 'pending';
    record.raw = kyc.raw;
    record.updatedAt = nowIso();
    return record;
  });
}

function toMoney(value: number): string {
  return value.toFixed(2);
}

export async function simulateSandboxKycApproval(userId: string) {
  const customer = await getCustomerByUserId(userId);
  const provider = getOfframpProvider(customer.provider);
  if (!provider.simulateSandboxKycApproval) {
    throw badRequest('Current provider does not support sandbox KYC simulation');
  }
  const result: any = await provider.simulateSandboxKycApproval(customer.providerCustomerId, idempotencyKey('simulate-kyc'));
  return db.mutate((data) => {
    const record = data.customers.find((c) => c.id === customer.id)!;
    record.kycStatus = mapBridgeKycStatus(result?.kyc_status ?? 'approved');
    record.raw = { previous: record.raw, sandboxSimulation: result };
    record.updatedAt = nowIso();
    return record;
  });
}
