import { createAuditLog } from '../../audit/audit.service.js';
import { env } from '../../config/env.js';
import { listPaymentControls } from '../../controls/payment-controls.service.js';
import { db } from '../../database/json-database.js';
import { BridgeClient } from '../../providers/bridge/bridge.client.js';
import { badRequest, forbidden, notFound } from '../../shared/errors.js';
import { id, nowIso } from '../../shared/id.js';
import { getVirtualAccountCurrencyConfig } from '../config/currency-config.js';
import { mapBridgeVirtualAccount } from '../provider/bridge-virtual-account.provider.js';
import { getVirtualAccountProvider } from '../provider/provider-registry.js';
import type { CreateVirtualAccountInput, ProviderVirtualAccount, VirtualAccountCurrency, VirtualAccountCustomerAction, VirtualAccountRecord, VirtualAccountRequestRecord } from '../types/virtual-account.types.js';
import { checkVirtualAccountEligibility } from './virtual-account-eligibility.service.js';
import { getVirtualAccountProviderSettings } from './virtual-account-provider-settings.service.js';

export function virtualAccountsEnabled() {
  return env.VIRTUAL_ACCOUNTS_ENABLED;
}

export function virtualAccountRequestsEnabled() {
  return env.VIRTUAL_ACCOUNT_REQUESTS_ENABLED;
}

const ENDORSEMENT_BY_CURRENCY: Partial<Record<VirtualAccountCurrency, string>> = {
  gbp: 'faster_payments',
  eur: 'sepa',
};

const VIRTUAL_ACCOUNT_RAIL_LABEL_BY_CURRENCY: Partial<Record<VirtualAccountCurrency, string>> = {
  gbp: 'GBP Faster Payments',
  eur: 'EUR SEPA',
};

function firstCorsOrigin() {
  return env.CORS_ORIGIN.split(',').map((item) => item.trim()).find((item) => item && item !== '*');
}

function flattenRequirementStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(flattenRequirementStrings);
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(flattenRequirementStrings);
  return [];
}

function uniqueStrings(items: unknown[]): string[] {
  return [...new Set(items.flatMap(flattenRequirementStrings))];
}

function bridgeRequirementsDue(bridgeCustomer: any, endorsement?: string) {
  const direct = uniqueStrings([
    bridgeCustomer?.requirements_due,
    bridgeCustomer?.requirements?.due,
    bridgeCustomer?.requirements?.missing,
  ]);
  const endorsements = Array.isArray(bridgeCustomer?.endorsements) ? bridgeCustomer.endorsements : [];
  const scoped = endorsements.filter((item: any) => !endorsement || item?.name === endorsement);
  const endorsementRequirements = uniqueStrings(scoped.flatMap((item: any) => [
    item?.requirements_due,
    item?.requirements?.due,
    item?.requirements?.missing,
    item?.requirements?.currently_due,
  ]));
  return uniqueStrings([...direct, ...endorsementRequirements]);
}

function bridgeEndorsementRequirements(bridgeCustomer: any, endorsement?: string) {
  if (!endorsement) return undefined;
  const endorsements = Array.isArray(bridgeCustomer?.endorsements) ? bridgeCustomer.endorsements : [];
  return endorsements.find((item: any) => item?.name === endorsement)?.requirements;
}

function bridgeEndorsementStatus(bridgeCustomer: any, endorsement?: string) {
  if (!endorsement) return undefined;
  const endorsements = Array.isArray(bridgeCustomer?.endorsements) ? bridgeCustomer.endorsements : [];
  return endorsements.find((item: any) => item?.name === endorsement)?.status;
}

function bridgeCustomerForVirtualAccountRequest(customers: Awaited<ReturnType<typeof db.listCustomers>>, request: VirtualAccountRequestRecord) {
  const exact = request.customerId
    ? customers.find((item) => item.id === request.customerId && item.provider === 'bridge' && item.providerCustomerId)
    : undefined;
  if (exact) return exact;

  return customers
    .filter((item) => item.userId === request.userId && item.provider === 'bridge' && item.providerCustomerId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

async function buildBridgeVirtualAccountAction(input: {
  providerCustomerId?: string;
  currency: VirtualAccountCurrency;
  bridgeCustomer?: any;
}): Promise<VirtualAccountCustomerAction | undefined> {
  const endorsement = ENDORSEMENT_BY_CURRENCY[input.currency];
  if (!input.providerCustomerId || !endorsement) return undefined;
  const railLabel = VIRTUAL_ACCOUNT_RAIL_LABEL_BY_CURRENCY[input.currency] || `${input.currency.toUpperCase()} virtual account`;

  const bridgeClient = new BridgeClient();
  let bridgeCustomer = input.bridgeCustomer;
  try {
    bridgeCustomer = bridgeCustomer ?? await bridgeClient.request<any>(`/customers/${input.providerCustomerId}`);
  } catch (error: any) {
    return {
      level: 'review',
      title: 'Provider review status unavailable',
      message: 'Sivan could not refresh the provider review status. Please refresh again later or contact support.',
      providerCustomerId: input.providerCustomerId,
      endorsement,
      providerStatus: error?.statusCode ? `bridge_error_${error.statusCode}` : 'bridge_error',
    };
  }

  const providerStatus = bridgeCustomer?.status;
  const endorsementStatus = bridgeEndorsementStatus(bridgeCustomer, endorsement);
  const endorsementRequirements = bridgeEndorsementRequirements(bridgeCustomer, endorsement);
  const requirements = bridgeRequirementsDue(bridgeCustomer, endorsement);
  const pendingRequirements = uniqueStrings([endorsementRequirements?.pending, bridgeCustomer?.requirements?.pending]);
  const missingRequirements = uniqueStrings([endorsementRequirements?.missing, bridgeCustomer?.requirements?.missing]);
  const endorsementMissingRequirements = uniqueStrings([endorsementRequirements?.missing]);
  const hasManualReviewPending = pendingRequirements.some((item) => /manual.*review|review/i.test(item));
  const hasMissingUserRequirements = requirements.length > 0 || missingRequirements.length > 0;
  const providerInReview =
    providerStatus === 'under_review' ||
    endorsementStatus === 'under_review' ||
    (hasManualReviewPending && endorsementMissingRequirements.length === 0);
  const actionRequired =
    !providerInReview &&
    (
      providerStatus === 'incomplete' ||
      providerStatus === 'requires_action' ||
      endorsementStatus === 'incomplete' ||
      endorsementStatus === 'requires_action' ||
      requirements.length > 0
    );
  const needsAction = providerInReview || actionRequired;

  if (!needsAction) return undefined;

  let kycUrl: string | undefined;
  if (actionRequired) {
    try {
      const raw: any = await bridgeClient.request(`/customers/${input.providerCustomerId}/kyc_link`, {
        query: { endorsement, redirect_uri: firstCorsOrigin() },
      });
      kycUrl = raw?.url || raw?.kyc_link;
    } catch {
      // Keep the state visible even if Bridge temporarily refuses to issue a
      // fresh hosted link. The link is convenience; the requirements are the
      // source of truth.
    }
  }

  return {
    level: actionRequired ? 'action_required' : 'review',
    title: actionRequired ? 'Additional information required' : 'Review in progress',
    message: actionRequired
      ? `Sivan needs one more verification step before this ${railLabel} account can be issued.`
      : `Sivan has received your ${input.currency.toUpperCase()} verification details. No action is needed right now.`,
    requirements: actionRequired ? requirements : [],
    kycUrl,
    providerCustomerId: input.providerCustomerId,
    endorsement,
    providerStatus,
  };
}

async function activeVirtualAccountProviderName() {
  const settings = await getVirtualAccountProviderSettings({ includeSecrets: true });
  return settings.enabled ? settings.provider : env.VIRTUAL_ACCOUNT_PROVIDER;
}

export async function listUserVirtualAccounts(userId: string) {
  const [requests, accounts, events, transactions, customers] = await Promise.all([db.listVirtualAccountRequests(), db.listVirtualAccounts(), db.listVirtualAccountEvents(), db.listVirtualAccountTransactions(), db.listCustomers()]);
  const activeProvider = await activeVirtualAccountProviderName();
  const hideLegacyMockAccounts = activeProvider === 'bridge';
  const userAccounts = accounts
    .filter((item) => item.userId === userId)
    .filter((item) => item.status !== 'closed')
    .filter((item) => !hideLegacyMockAccounts || item.provider !== 'mock')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const providerIds = new Set(userAccounts.map((account) => account.providerAccountId));
  const accountIds = new Set(userAccounts.map((account) => account.id));
  const userRequests = requests.filter((item) => item.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const enrichedRequests = await Promise.all(userRequests.map(async (request) => {
    const customer = bridgeCustomerForVirtualAccountRequest(customers, request);
    const action = await buildBridgeVirtualAccountAction({
      providerCustomerId: customer?.providerCustomerId,
      currency: request.currency,
    });
    return action ? { ...request, customerAction: action } : request;
  }));
  return {
    requests: enrichedRequests,
    accounts: userAccounts,
    events: events.filter((item) => item.virtualAccountId && accountIds.has(item.virtualAccountId) || item.providerAccountId && providerIds.has(item.providerAccountId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    transactions: transactions.filter((item) => item.userId === userId || item.virtualAccountId && accountIds.has(item.virtualAccountId) || item.providerAccountId && providerIds.has(item.providerAccountId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
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

export async function checkVirtualAccountProviderByEmail(email: string) {
  const targetEmail = email.trim().toLowerCase();
  if (!targetEmail || !targetEmail.includes('@')) throw badRequest('A valid customer email is required.');

  const user = await db.findUserByEmail(targetEmail);
  if (!user) {
    return {
      email: targetEmail,
      userFound: false,
      summary: 'No Sivan payment user exists for this email.',
      sivan: { user: null, customers: [], requests: [], accounts: [] },
      bridge: { checked: false, customers: [] },
    };
  }

  const [customers, requests, accounts] = await Promise.all([
    db.listCustomers(),
    db.listVirtualAccountRequests(),
    db.listVirtualAccounts(),
  ]);

  const userCustomers = customers.filter((customer) => customer.userId === user.id);
  const customerIds = new Set(userCustomers.map((customer) => customer.id));
  const userRequests = requests.filter((request) => request.userId === user.id || Boolean(request.customerId && customerIds.has(request.customerId)));
  const requestIds = new Set(userRequests.map((request) => request.id));
  const userAccounts = accounts.filter((account) =>
    account.userId === user.id ||
    Boolean(account.customerId && customerIds.has(account.customerId)) ||
    Boolean(account.requestId && requestIds.has(account.requestId))
  );

  const bridgeCustomers = [];
  const bridgeClient = new BridgeClient();

  for (const customer of userCustomers.filter((item) => item.provider === 'bridge' && item.providerCustomerId)) {
    const providerCustomerId = customer.providerCustomerId;
    try {
      const [bridgeCustomer, bridgeAccountsResponse] = await Promise.all([
        bridgeClient.request<any>(`/customers/${providerCustomerId}`),
        bridgeClient.request<any>(`/customers/${providerCustomerId}/virtual_accounts`),
      ]);
      const providerActions = await Promise.all((['gbp', 'eur'] as VirtualAccountCurrency[]).map((currency) =>
        buildBridgeVirtualAccountAction({ providerCustomerId, currency, bridgeCustomer })
      ));
      const customerActions = providerActions.filter(Boolean) as VirtualAccountCustomerAction[];
      const bridgeAccounts = Array.isArray(bridgeAccountsResponse?.data) ? bridgeAccountsResponse.data : [];
      const mappedAccounts = bridgeAccounts.map((account: any) =>
        mapBridgeVirtualAccount(account, (account?.source_deposit_instructions?.currency || 'usd') as VirtualAccountCurrency)
      );
      const localProviderIds = new Set(userAccounts.map((account) => account.providerAccountId).filter(Boolean));

      bridgeCustomers.push({
        providerCustomerId,
        email: bridgeCustomer?.email,
        status: bridgeCustomer?.status,
        capabilities: bridgeCustomer?.capabilities,
        endorsements: (bridgeCustomer?.endorsements || []).map((endorsement: any) => ({
          name: endorsement.name,
          status: endorsement.status,
          missing: endorsement.requirements?.missing ?? null,
        })),
        requirementsDue: bridgeRequirementsDue(bridgeCustomer),
        customerActions,
        virtualAccounts: mappedAccounts.map((account: ProviderVirtualAccount) => ({
          providerAccountId: account.providerAccountId,
          currency: account.currency,
          country: account.country,
          bankName: account.bankName,
          accountName: account.accountName,
          accountNumberMasked: account.accountNumberMasked,
          routingNumberMasked: account.routingNumberMasked,
          ibanMasked: account.ibanMasked,
          status: account.status,
          existsInSivan: localProviderIds.has(account.providerAccountId),
        })),
      });
    } catch (error: any) {
      bridgeCustomers.push({
        providerCustomerId,
        error: error?.message || String(error),
        details: error?.details,
        virtualAccounts: [],
      });
    }
  }

  const bridgeAccountCount = bridgeCustomers.reduce((sum, customer: any) => sum + (customer.virtualAccounts?.length || 0), 0);
  const localAccountCount = userAccounts.length;
  const approvedWithoutLocalAccount = userRequests.filter((request) =>
    request.status === 'approved' && !userAccounts.some((account) => account.requestId === request.id)
  );

  return {
    email: targetEmail,
    checkedAt: nowIso(),
    userFound: true,
    summary:
      bridgeAccountCount > 0
        ? `Bridge reports ${bridgeAccountCount} virtual account(s) for this customer.`
        : localAccountCount > 0
          ? 'Sivan has local virtual account row(s), but Bridge returned no provider account for this customer.'
          : approvedWithoutLocalAccount.length
            ? 'Sivan has approved request(s), but no local or Bridge virtual account was found.'
            : 'No provisioned virtual account was found in Sivan or Bridge.',
    sivan: {
      user: { id: user.id, email: user.email, emailVerifiedAt: user.emailVerifiedAt },
      customers: userCustomers.map((customer) => ({
        id: customer.id,
        provider: customer.provider,
        providerCustomerId: customer.providerCustomerId,
        kycStatus: customer.kycStatus,
        tosStatus: customer.tosStatus,
        createdAt: customer.createdAt,
        updatedAt: customer.updatedAt,
      })),
      requests: userRequests,
      accounts: userAccounts,
      approvedWithoutLocalAccount,
    },
    bridge: {
      checked: true,
      customers: bridgeCustomers,
      totalVirtualAccounts: bridgeAccountCount,
    },
  };
}

export async function importExistingBridgeVirtualAccountsByEmail(email: string, importedBy = 'admin_api_key') {
  const targetEmail = email.trim().toLowerCase();
  if (!targetEmail || !targetEmail.includes('@')) throw badRequest('A valid customer email is required.');

  const user = await db.findUserByEmail(targetEmail);
  if (!user) throw notFound('No Sivan payment user exists for this email.');

  const [customers, existingAccounts] = await Promise.all([
    db.listCustomers(),
    db.listVirtualAccounts(),
  ]);
  const userCustomers = customers.filter((customer) => customer.userId === user.id && customer.provider === 'bridge' && customer.providerCustomerId);
  if (!userCustomers.length) throw notFound('No Bridge customer is linked to this Sivan user.');

  const bridgeClient = new BridgeClient();
  const importedAccounts: VirtualAccountRecord[] = [];

  for (const customer of userCustomers) {
    const providerCustomerId = customer.providerCustomerId;
    if (!providerCustomerId) continue;

    const bridgeAccountsResponse = await bridgeClient.request<any>(`/customers/${providerCustomerId}/virtual_accounts`);
    const bridgeAccounts = Array.isArray(bridgeAccountsResponse?.data) ? bridgeAccountsResponse.data : [];

    for (const rawAccount of bridgeAccounts) {
      const mapped = mapBridgeVirtualAccount(rawAccount, (rawAccount?.source_deposit_instructions?.currency || 'usd') as VirtualAccountCurrency);
      const existing = existingAccounts.find((account) =>
        account.provider === 'bridge' &&
        account.providerAccountId === mapped.providerAccountId
      );
      const now = nowIso();
      const record: VirtualAccountRecord = {
        id: existing?.id ?? id('va'),
        requestId: existing?.requestId,
        userId: user.id,
        customerId: customer.id,
        provider: 'bridge',
        providerAccountId: mapped.providerAccountId,
        currency: mapped.currency,
        country: mapped.country,
        bankName: mapped.bankName,
        accountName: mapped.accountName,
        accountNumberMasked: mapped.accountNumberMasked,
        routingNumberMasked: mapped.routingNumberMasked,
        ibanMasked: mapped.ibanMasked,
        status: mapped.status,
        rawProviderPayload: mapped.rawProviderPayload,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      await db.upsertVirtualAccountRecord(record);
      importedAccounts.push(record);
    }
  }

  await createAuditLog({
    actorType: 'admin',
    actorId: importedBy,
    action: 'virtual_account.provider_imported',
    resourceType: 'virtual_account',
    resourceId: user.id,
    metadata: {
      email: targetEmail,
      provider: 'bridge',
      importedAccountIds: importedAccounts.map((account) => account.id),
      providerAccountIds: importedAccounts.map((account) => account.providerAccountId),
    },
  });

  return {
    email: targetEmail,
    imported: importedAccounts.length,
    accounts: importedAccounts,
    providerCreation: false,
    message: importedAccounts.length
      ? `Imported ${importedAccounts.length} existing Bridge virtual account(s) into Sivan.`
      : 'Bridge returned no virtual accounts to import.',
  };
}

export async function provisionVirtualAccount(input: CreateVirtualAccountInput): Promise<ProviderVirtualAccount> {
  // Runtime Admin Controls are the source of truth for enabling/disabling
  // USD/GBP/EUR virtual account requests and approvals. Do not require a Render
  // redeploy just to turn a currency on/off. Provider-specific safety remains in
  // the provider adapter (for example BRIDGE_VIRTUAL_ACCOUNTS_ENABLED must still
  // be true before the Bridge adapter can create a real provider account).
  const settings = await getVirtualAccountProviderSettings({ includeSecrets: true });
  const providerName = settings.enabled ? settings.provider : env.VIRTUAL_ACCOUNT_PROVIDER;
  if (!settings.enabled && providerName !== 'mock') {
    throw forbidden('Virtual account provider provisioning is disabled in settlement settings.');
  }
  const provider = getVirtualAccountProvider(providerName || env.VIRTUAL_ACCOUNT_PROVIDER);
  return provider.createVirtualAccount(input);
}

async function provisionVirtualAccountOrExplain(input: CreateVirtualAccountInput, context: { requestId: string; reviewer: string; activeProvider: string }) {
  try {
    return await provisionVirtualAccount(input);
  } catch (error: any) {
    await createAuditLog({
      actorType: 'admin',
      actorId: context.reviewer,
      action: 'virtual_account.provision_failed',
      resourceType: 'virtual_account_request',
      resourceId: context.requestId,
      severity: 'error',
      metadata: {
        provider: context.activeProvider,
        message: error?.message || String(error),
        code: error?.code,
        statusCode: error?.statusCode,
        details: error?.details,
      }
    });
    throw badRequest('Bridge virtual account provisioning failed. Check provider eligibility, destination wallet settings, and Bridge virtual-account approval for this customer.', {
      provider: context.activeProvider,
      message: error?.message || String(error),
      code: error?.code,
      statusCode: error?.statusCode,
      details: error?.details,
    });
  }
}

export async function approveVirtualAccountRequest(requestId: string, reviewer: string) {
  const requests = await db.listVirtualAccountRequests();
  const request = requests.find((item) => item.id === requestId);
  if (!request) throw notFound('Virtual account request');
  if (!['requested', 'under_review', 'approved'].includes(request.status)) throw badRequest('Virtual account request is not pending review.');
  const runtimeControls = await listPaymentControls();
  const virtualAccountControl = runtimeControls.virtualAccounts.find((control) => control.currency === request.currency);
  if (!virtualAccountControl?.enabled) throw forbidden(`${request.currency.toUpperCase()} virtual account provisioning is disabled.`);

  const data = await db.read();
  const user = data.users.find((item) => item.id === request.userId);
  if (!user) throw notFound('User');
  const now = nowIso();
  const activeProvider = await activeVirtualAccountProviderName();

  const existingAccounts = await db.listVirtualAccounts();
  const existingLiveAccount = existingAccounts.find((item) => item.requestId === requestId && item.provider !== 'mock' && item.status !== 'closed');
  if (request.status === 'approved' && existingLiveAccount) throw badRequest('Virtual account request is already approved and has a live provider account.');

  const approved: VirtualAccountRequestRecord = { ...request, status: 'approved', reviewedBy: reviewer, reviewedAt: request.reviewedAt || now, updatedAt: now };
  await db.upsertVirtualAccountRequestRecord(approved);

  const customer = data.customers.find((item) => item.id === request.customerId || item.userId === request.userId);
  if (!customer?.providerCustomerId) throw badRequest('Cannot provision without a provider customer ID. Complete Bridge KYC first.');
  if (activeProvider === 'bridge' && customer.provider !== 'bridge') {
    throw badRequest('This request belongs to a legacy/mock customer. Import or complete a real Bridge customer before approving virtual account provisioning.');
  }
  const providerAccount = await provisionVirtualAccountOrExplain({ requestId, userId: request.userId, customerId: request.customerId, providerCustomerId: customer.providerCustomerId, email: user.email, fullName: user.fullName, currency: request.currency, country: request.country, useCase: request.useCase, metadata: request.metadata }, { requestId, reviewer, activeProvider });
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

/**
 * Raise a maker-checker approval for a reprovision. Does NOT reprovision.
 *
 * Reprovisioning is not a refresh. It provisions a brand new virtual account at
 * the provider, with a new bank account number, and the previous account keeps
 * accepting deposits because Bridge is never told to deactivate it. Each USD
 * virtual account also bills $2/month.
 *
 * On 2026-07-29 a single approved request accumulated 16 live Bridge accounts
 * for one user, partly because the admin hub retried a failed POST. Making this
 * a two-admin action means a stray click, a retry, or a double submit can no
 * longer mint a real bank account.
 *
 * The actual work lives in executeVirtualAccountReprovision, which is only
 * reachable through the approval flow.
 */
export async function requestVirtualAccountReprovision(
  requestId: string,
  requestedBy: string,
  reason?: string
) {
  const requests = await db.listVirtualAccountRequests();
  const request = requests.find((item) => item.id === requestId);
  if (!request) throw notFound('Virtual account request');
  if (request.status !== 'approved') {
    throw badRequest('Only approved virtual account requests can be reprovisioned.');
  }

  // Surface the cost of the action in the approval itself, so the checker sees
  // what they are agreeing to rather than a bare resource id.
  const existingAccounts = await db.listVirtualAccounts();
  const forThisRequest = existingAccounts.filter((item) => item.requestId === requestId);
  const stillOpenAtProvider = forThisRequest.filter((item) => item.provider !== 'mock').length;

  const { createApprovalRequest } = await import('../../admin/admin-ops.service.js');

  return createApprovalRequest({
    action: 'virtual_account.reprovision',
    resourceType: 'virtual_account_request',
    resourceId: requestId,
    reason:
      reason ||
      `Reprovision virtual account for request ${requestId}. This creates a NEW account at the provider with a new account number.`,
    requestedBy,
    requestedChange: {
      requestId,
      userId: request.userId,
      currency: request.currency,
      existingAccountsForThisRequest: forThisRequest.length,
      accountsStillOpenAtProvider: stillOpenAtProvider,
      warning:
        'Creates a new provider virtual account with a new bank account number. Previous accounts are marked closed in Sivan but are NOT deactivated at Bridge, so they continue to accept deposits. Each USD virtual account bills $2/month.',
    },
    riskLevel: 'high',
  });
}

/**
 * Perform the reprovision. Only called by the approval flow after a second
 * admin has approved; it is deliberately not exposed on a route.
 */
export async function executeVirtualAccountReprovision(requestId: string, reviewer: string) {
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

  const providerAccount = await provisionVirtualAccountOrExplain({
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
  }, { requestId, reviewer, activeProvider });

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
  const requestIdsWithLiveBridgeAccounts = new Set(
    accounts
      .filter((account) => account.provider !== 'mock' && account.status !== 'closed')
      .map((account) => account.requestId)
      .filter(Boolean) as string[]
  );
  const mockRequests = requests.filter((request) => {
    const metadata: any = request.metadata || {};
    return mockRequestIds.has(request.id) || metadata.requestedProvider === 'mock' || mockCustomerIds.has(request.customerId || '');
  });
  const cancelableMockRequests = mockRequests.filter((request) =>
    !['rejected', 'canceled'].includes(request.status) && !requestIdsWithLiveBridgeAccounts.has(request.id)
  );

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
    preservedRequestIdsWithBridgeAccounts: Array.from(requestIdsWithLiveBridgeAccounts),
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
