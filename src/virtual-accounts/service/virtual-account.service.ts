import { createAuditLog } from '../../audit/audit.service.js';
import { env } from '../../config/env.js';
import { listPaymentControls } from '../../controls/payment-controls.service.js';
import { db } from '../../database/json-database.js';
import { badRequest, forbidden, notFound } from '../../shared/errors.js';
import { id, nowIso } from '../../shared/id.js';
import { getVirtualAccountCurrencyConfig } from '../config/currency-config.js';
import { getVirtualAccountProvider } from '../provider/provider-registry.js';
import type { CreateVirtualAccountInput, ProviderVirtualAccount, VirtualAccountCurrency, VirtualAccountRecord, VirtualAccountRequestRecord } from '../types/virtual-account.types.js';
import { checkVirtualAccountEligibility } from './virtual-account-eligibility.service.js';

export function virtualAccountsEnabled() {
  return env.VIRTUAL_ACCOUNTS_ENABLED;
}

export function virtualAccountRequestsEnabled() {
  return env.VIRTUAL_ACCOUNT_REQUESTS_ENABLED;
}

export async function listUserVirtualAccounts(userId: string) {
  const [requests, accounts] = await Promise.all([db.listVirtualAccountRequests(), db.listVirtualAccounts()]);
  return {
    requests: requests.filter((item) => item.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    accounts: accounts.filter((item) => item.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}

export async function requestVirtualAccount(input: { userId: string; currency: VirtualAccountCurrency; useCase?: string; country?: string }, context: { ipAddress?: string; userAgent?: string } = {}) {
  const currencyConfig = getVirtualAccountCurrencyConfig(input.currency);
  if (!currencyConfig) throw badRequest('Unsupported virtual account currency.');
  const runtimeControls = await listPaymentControls();
  const virtualAccountControl = runtimeControls.virtualAccounts.find((control) => control.currency === input.currency);
  if (!virtualAccountControl?.enabled) throw forbidden(`${input.currency.toUpperCase()} virtual account requests are disabled.`);

  const eligibility = await checkVirtualAccountEligibility(input.userId, input.currency);
  if (!eligibility.eligible) throw forbidden('Virtual account request is not eligible yet.', { reasons: eligibility.reasons });

  const now = nowIso();
  const record: VirtualAccountRequestRecord = {
    id: id('vareq'),
    userId: input.userId,
    customerId: eligibility.customerId,
    currency: input.currency,
    country: input.country ?? currencyConfig.country,
    useCase: input.useCase,
    status: 'requested',
    metadata: { accountType: currencyConfig.accountType, rails: currencyConfig.rails, requestedProvider: env.VIRTUAL_ACCOUNT_PROVIDER },
    createdAt: now,
    updatedAt: now,
  };

  await db.upsertVirtualAccountRequestRecord(record);
  await createAuditLog({ actorType: 'user', actorId: input.userId, action: 'virtual_account.requested', resourceType: 'virtual_account_request', resourceId: record.id, ipAddress: context.ipAddress, userAgent: context.userAgent, metadata: { currency: input.currency } });
  return record;
}

export async function listVirtualAccountRequests() {
  return (await db.listVirtualAccountRequests()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listVirtualAccounts() {
  return (await db.listVirtualAccounts()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listVirtualAccountEvents() {
  return (await db.listVirtualAccountEvents()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listVirtualAccountTransactions() {
  return (await db.listVirtualAccountTransactions()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function provisionVirtualAccount(input: CreateVirtualAccountInput): Promise<ProviderVirtualAccount> {
  if (!virtualAccountsEnabled()) {
    throw new Error('Virtual accounts are disabled. Enable VIRTUAL_ACCOUNTS_ENABLED only after provider/compliance approval.');
  }
  const provider = getVirtualAccountProvider(env.VIRTUAL_ACCOUNT_PROVIDER);
  return provider.createVirtualAccount(input);
}

export async function approveVirtualAccountRequest(requestId: string, reviewer: string) {
  const requests = await db.listVirtualAccountRequests();
  const request = requests.find((item) => item.id === requestId);
  if (!request) throw notFound('Virtual account request');
  if (!['requested', 'under_review'].includes(request.status)) throw badRequest('Virtual account request is not pending review.');
  const runtimeControls = await listPaymentControls();
  const virtualAccountControl = runtimeControls.virtualAccounts.find((control) => control.currency === request.currency);
  if (!virtualAccountControl?.enabled) throw forbidden(`${request.currency.toUpperCase()} virtual account provisioning is disabled.`);

  const data = await db.read();
  const user = data.users.find((item) => item.id === request.userId);
  if (!user) throw notFound('User');
  const now = nowIso();

  const approved: VirtualAccountRequestRecord = { ...request, status: 'approved', reviewedBy: reviewer, reviewedAt: now, updatedAt: now };
  await db.upsertVirtualAccountRequestRecord(approved);

  const customer = data.customers.find((item) => item.id === request.customerId || item.userId === request.userId);
  const providerAccount = await provisionVirtualAccount({ requestId, userId: request.userId, customerId: request.customerId, providerCustomerId: customer?.providerCustomerId, email: user.email, fullName: user.fullName, currency: request.currency, country: request.country, useCase: request.useCase, metadata: request.metadata });
  const account: VirtualAccountRecord = {
    id: id('va'),
    requestId,
    userId: request.userId,
    customerId: request.customerId,
    provider: providerAccount.provider,
    providerAccountId: providerAccount.providerAccountId,
    currency: providerAccount.currency,
    country: providerAccount.country,
    bankName: providerAccount.bankName,
    accountName: providerAccount.accountName,
    accountNumberMasked: providerAccount.accountNumberMasked,
    routingNumberMasked: providerAccount.routingNumberMasked,
    ibanMasked: providerAccount.ibanMasked,
    status: providerAccount.status,
    rawProviderPayload: providerAccount.rawProviderPayload,
    createdAt: now,
    updatedAt: now,
  };
  await db.upsertVirtualAccountRecord(account);
  await createAuditLog({ actorType: 'admin', actorId: reviewer, action: 'virtual_account.approved', resourceType: 'virtual_account_request', resourceId: requestId, metadata: { accountId: account.id, provider: account.provider, currency: account.currency } });
  return { request: approved, account };
}

export async function rejectVirtualAccountRequest(requestId: string, reviewer: string, reason: string) {
  const requests = await db.listVirtualAccountRequests();
  const request = requests.find((item) => item.id === requestId);
  if (!request) throw notFound('Virtual account request');
  const now = nowIso();
  const rejected: VirtualAccountRequestRecord = { ...request, status: 'rejected', reviewedBy: reviewer, reviewedAt: now, rejectionReason: reason, updatedAt: now };
  await db.upsertVirtualAccountRequestRecord(rejected);
  await createAuditLog({ actorType: 'admin', actorId: reviewer, action: 'virtual_account.rejected', resourceType: 'virtual_account_request', resourceId: requestId, severity: 'warning', metadata: { reason, currency: request.currency } });
  return rejected;
}
