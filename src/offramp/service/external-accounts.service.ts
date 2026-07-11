import { z } from 'zod';
import { db } from '../../database/json-database.js';
import type { Currency, ExternalAccountStatus } from '../../database/types.js';
import { getOfframpProvider } from '../../providers/provider-registry.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { id, idempotencyKey, nowIso } from '../../shared/id.js';
import { addressSchema } from '../../shared/validation.js';
import { getCustomerByUserId } from '../../customers/customers.service.js';

const baseAccountSchema = z.object({
  userId: z.string().min(1),
  currency: z.enum(['usd', 'gbp']),
  bankName: z.string().min(1),
  accountName: z.string().min(1).optional(),
  accountOwnerName: z.string().min(2),
  accountOwnerType: z.enum(['individual', 'business']).default('individual'),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  businessName: z.string().optional(),
  address: addressSchema
});

export const createExternalAccountSchema = z.discriminatedUnion('accountType', [
  baseAccountSchema.extend({
    accountType: z.literal('us'),
    currency: z.literal('usd'),
    paymentRail: z.enum(['ach', 'wire']).default('ach'),
    account: z.object({
      routing_number: z.string().length(9),
      account_number: z.string().min(4),
      checking_or_savings: z.enum(['checking', 'savings']).default('checking')
    })
  }),
  baseAccountSchema.extend({
    accountType: z.literal('gb'),
    currency: z.literal('gbp'),
    paymentRail: z.literal('faster_payments').default('faster_payments'),
    account: z.object({
      account_number: z.string().length(8),
      sort_code: z.string().length(6)
    })
  })
]);

export async function createExternalAccount(input: z.infer<typeof createExternalAccountSchema>) {
  const customer = await getCustomerByUserId(input.userId);
  if (customer.kycStatus !== 'kyc_approved') {
    throw badRequest('KYC must be approved before adding a withdrawal bank account');
  }

  const provider = getOfframpProvider(customer.provider);
  const payload: Record<string, unknown> = {
    currency: input.currency,
    account_type: input.accountType,
    bank_name: input.bankName,
    account_name: input.accountName,
    account_owner_name: input.accountOwnerName,
    account_owner_type: input.accountOwnerType,
    first_name: input.firstName,
    last_name: input.lastName,
    business_name: input.businessName,
    address: input.address,
    account: input.account
  };

  const providerAccount = await provider.createExternalAccount({
    customerId: customer.providerCustomerId,
    payload,
    idempotencyKey: idempotencyKey('ea')
  });

  const now = nowIso();
  return db.mutate((data) => {
    const record = {
      id: id('ea'),
      userId: input.userId,
      customerId: customer.id,
      provider: customer.provider,
      providerExternalAccountId: providerAccount.id,
      currency: providerAccount.currency as Currency,
      accountType: input.accountType,
      bankName: providerAccount.bankName,
      accountName: providerAccount.accountName,
      accountOwnerName: providerAccount.accountOwnerName,
      accountLast4: providerAccount.last4,
      paymentRail: input.paymentRail,
      status: mapExternalAccountStatus(input.accountType, providerAccount.verificationStatus, providerAccount.active),
      raw: providerAccount.raw,
      createdAt: now,
      updatedAt: now
    };
    data.externalAccounts.push(record);
    return record;
  });
}

export async function listExternalAccounts(userId: string) {
  const data = await db.read();
  return data.externalAccounts.filter((ea) => ea.userId === userId);
}

export async function getExternalAccount(id: string) {
  const data = await db.read();
  const record = data.externalAccounts.find((ea) => ea.id === id);
  if (!record) throw notFound('External account');
  return record;
}

export async function verifyExternalAccount(id: string) {
  const account = await getExternalAccount(id);
  if (!['gb', 'iban'].includes(account.accountType)) {
    throw badRequest('Bridge external-account name verification is supported for gb and iban account types only');
  }
  const data = await db.read();
  const customer = data.customers.find((c) => c.id === account.customerId);
  if (!customer) throw notFound('Customer');
  const provider = getOfframpProvider(account.provider);
  const result = await provider.verifyExternalAccount(customer.providerCustomerId, account.providerExternalAccountId);
  return db.mutate((mutable) => {
    const record = mutable.externalAccounts.find((ea) => ea.id === id)!;
    record.status = 'verification_pending';
    record.raw = { previous: record.raw, verification: result };
    record.updatedAt = nowIso();
    return record;
  });
}

function mapExternalAccountStatus(accountType: string, verificationStatus?: string, active?: boolean): ExternalAccountStatus {
  if (verificationStatus) return 'verification_pending';
  if (active) return accountType === 'us' ? 'verified' : 'active';
  return 'created';
}
