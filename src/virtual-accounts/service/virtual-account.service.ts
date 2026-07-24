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
import { getVirtualAccountProviderSettings } from './virtual-account-provider-settings.service.js';

export function virtualAccountsEnabled() {
  return env.VIRTUAL_ACCOUNTS_ENABLED;
}

export function virtualAccountRequestsEnabled() {
  return env.VIRTUAL_ACCOUNT_REQUESTS_ENABLED;
}

async function activeVirtualAccountProviderName() {
  const settings = await getVirtualAccountProviderSettings({ includeSecrets: true });
  return settings.enabled ? settings.provider : env.VIRTUAL_ACCOUNT_PROVIDER;
}

export async function listUserVirtualAccounts(userId: string) {
  const [requests, accounts] = await Promise.all([db.listVirtualAccountRequests(), db.listVirtualAccounts()]);
  const activeProvider = await activeVirtualAccountProviderName();
  const hideLegacyMockAccounts = activeProvider === 'bridge';
  return {
    requests: requests.filter((item) => item.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    accounts: accounts
      .filter((item) => item.userId === userId)
      .filter((item) => item.status !== 'closed')
      .filter((item) => !hideLegacyMockAccounts || item.provider !== 'mock')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
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
  const activeProvider = await activeVirtualAccountProviderName();
  const record: VirtualAccountRequestRecord = {
    id: id('vareq'),
    userId: input.userId,
    customerId: eligibility.customerId,
    currency: input.currency,
    country: input.country ?? currencyConfig.country,
    useCase: input.useCase,
    status: 'requested',
    metadata: { accountType: currencyConfig.accountType, rails: currencyConfig.rails, requestedProvider: activeProvider },
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
  // Runtime Admin Controls are the source of truth for enabling/disabling
  // USD/GBP/EUR virtual account requests and approvals. Do not require a Render
  // redeploy just to turn a currency on/off. Provider-specific safety remains in
  // the provider adapter (for example BRIDGE_VIRTUAL_ACCOUNTS_ENABLED must still
  // be true before the Bridge adapter can create a real provider account).
  const providerName = await activeVirtualAccountProviderName();
  const provider = getVirtualAccountProvider(providerName);
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
  if (!customer?.providerCustomerId) throw badRequest('Cannot provision without a provider customer ID. Complete Bridge KYC first.');
  if (env.VIRTUAL_ACCOUNT_PROVIDER === 'bridge' && customer.provider !== 'bridge') {
    throw badRequest('This request belongs to a legacy/mock customer. Import or complete a real Bridge customer before approving virtual account provisioning.');
  }
  const providerAccount = await provisionVirtualAccount({ requestId, userId: request.userId, customerId: request.customerId, providerCustomerId: customer.providerCustomerId, email: user.email, fullName: user.fullName, currency: request.currency, country: request.country, useCase: request.useCase, metadata: request.metadata });
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

export async function reprovisionVirtualAccountRequest(requestId: string, reviewer: string) {
  const requests = await db.listVirtualAccountRequests();
  const request = requests.find((item) => item.id === requestId);
  if (!request) throw notFound('Virtual account request');
  if (request.status !== 'approved') throw badRequest('Only approved virtual account requests can be reprovisioned.');

  const data = await db.read();
  const user = data.users.find((item) => item.id === request.userId);
  if (!user) throw notFound('User');
  const customer = data.customers.find((item) => item.id === request.customerId || item.userId === request.userId);
  if (!customer?.providerCustomerId) throw badRequest('Cannot reprovision without a provider customer ID. Complete Bridge KYC first.');
  const activeProvider = await activeVirtualAccountProviderName();
  if (activeProvider === 'bridge' && customer.provider !== 'bridge') {
    throw badRequest('This approved request belongs to a mock sandbox customer. Create/request a virtual account from a real Bridge-KYC customer, or re-run KYC with Bridge before reprovisioning.');
  }

  const runtimeControls = await listPaymentControls();
  const virtualAccountControl = runtimeControls.virtualAccounts.find((control) => control.currency === request.currency);
  if (!virtualAccountControl?.enabled) throw forbidden(`${request.currency.toUpperCase()} virtual account provisioning is disabled.`);

  const now = nowIso();
  const existingAccounts = await db.listVirtualAccounts();
  for (const account of existingAccounts.filter((item) => item.requestId === requestId && item.status === 'active')) {
    await db.upsertVirtualAccountRecord({ ...account, status: 'closed', updatedAt: now, rawProviderPayload: { previous: account.rawProviderPayload, closedByReprovision: { reviewer, at: now, provider: activeProvider } } });
  }

  const providerAccount = await provisionVirtualAccount({
    requestId,
    userId: request.userId,
    customerId: request.customerId,
    providerCustomerId: customer.providerCustomerId,
    email: user.email,
    fullName: user.fullName,
    currency: request.currency,
    country: request.country,
    useCase: request.useCase,
    metadata: request.metadata
  });

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
  await createAuditLog({ actorType: 'admin', actorId: reviewer, action: 'virtual_account.reprovisioned', resourceType: 'virtual_account_request', resourceId: requestId, metadata: { accountId: account.id, provider: account.provider, currency: account.currency } });
  return { request, account };
}


export async function cleanupLegacyMockVirtualAccountData(input: { dryRun?: boolean; canceledBy?: string; reason?: string } = {}) {
  const now = nowIso();
  const dryRun = input.dryRun !== false;
  const canceledBy = input.canceledBy || 'admin_api_key';
  const reason = input.reason || 'Archive legacy mock virtual account data before Bridge-only provisioning';
  const [accounts, requests, data] = await Promise.all([db.listVirtualAccounts(), db.listVirtualAccountRequests(), db.read()]);
  const mockCustomerIds = new Set((data.customers ?? []).filter((customer: any) => customer.provider === 'mock').map((customer: any) => customer.id));
  const mockAccounts = accounts.filter((account) => account.provider === 'mock' || mockCustomerIds.has(account.customerId || ''));
  const openMockAccounts = mockAccounts.filter((account) => account.status !== 'closed');
  const mockRequestIds = new Set(mockAccounts.map((account) => account.requestId).filter(Boolean) as string[]);
  const mockRequests = requests.filter((request) => {
    const metadata: any = request.metadata || {};
    return mockRequestIds.has(request.id) || metadata.requestedProvider === 'mock' || mockCustomerIds.has(request.customerId || '');
  });
  const cancelableMockRequests = mockRequests.filter((request) => !['rejected', 'canceled'].includes(request.status));

  if (!dryRun) {
    for (const account of openMockAccounts) {
      await db.upsertVirtualAccountRecord({
        ...account,
        status: 'closed',
        updatedAt: now,
        rawProviderPayload: {
          previous: account.rawProviderPayload,
          legacyMockCleanup: { closedAt: now, closedBy: canceledBy, reason }
        }
      });
    }
    for (const request of cancelableMockRequests) {
      await db.upsertVirtualAccountRequestRecord({
        ...request,
        status: 'canceled',
        reviewedBy: canceledBy,
        reviewedAt: now,
        rejectionReason: reason,
        updatedAt: now,
        metadata: { ...(request.metadata as any || {}), legacyMockCleanup: { canceledAt: now, canceledBy, reason } }
      });
    }
    await createAuditLog({
      actorType: 'admin',
      actorId: canceledBy,
      action: 'virtual_account.legacy_mock_cleanup',
      resourceType: 'virtual_account',
      resourceId: 'legacy_mock_data',
      severity: 'warning',
      metadata: {
        reason,
        closedAccountIds: openMockAccounts.map((account) => account.id),
        canceledRequestIds: cancelableMockRequests.map((request) => request.id),
        mockCustomerIds: Array.from(mockCustomerIds)
      }
    });
  }

  return {
    dryRun,
    reason,
    mockCustomers: Array.from(mockCustomerIds),
    mockAccountsFound: mockAccounts.length,
    openMockAccountsFound: openMockAccounts.length,
    mockRequestsFound: mockRequests.length,
    cancelableMockRequestsFound: cancelableMockRequests.length,
    closedAccountIds: openMockAccounts.map((account) => account.id),
    canceledRequestIds: cancelableMockRequests.map((request) => request.id),
  };
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
