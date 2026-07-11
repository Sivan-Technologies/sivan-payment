import { db } from '../database/json-database.js';
import { getOnboardingCostSummary } from '../metrics/onboarding-costs.service.js';
import { providerCapabilities } from '../providers/provider-routing.js';

export async function getAdminOverview() {
  const data = await db.read();
  const metrics = await getOnboardingCostSummary();

  const withdrawalsByStatus = data.withdrawals.reduce<Record<string, number>>((acc, withdrawal) => {
    acc[withdrawal.status] = (acc[withdrawal.status] ?? 0) + 1;
    return acc;
  }, {});

  const webhookEventsByType = data.webhookEvents.reduce<Record<string, number>>((acc, event) => {
    const key = event.eventCategory || event.eventType || 'unknown';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  return {
    counts: {
      users: data.users.length,
      customers: data.customers.length,
      externalAccounts: data.externalAccounts.length,
      liquidationAddresses: data.liquidationAddresses.length,
      withdrawals: data.withdrawals.length,
      webhookEvents: data.webhookEvents.length,
      providers: providerCapabilities.length
    },
    withdrawalsByStatus,
    webhookEventsByType,
    metrics,
    recent: {
      users: data.users.slice(-10).reverse(),
      customers: data.customers.slice(-10).reverse(),
      withdrawals: data.withdrawals.slice(-10).reverse(),
      webhookEvents: data.webhookEvents.slice(-10).reverse()
    }
  };
}

export async function listAdminUsers() {
  const data = await db.read();
  return data.users.map((user) => ({
    ...user,
    customer: data.customers.find((customer) => customer.userId === user.id) ?? null,
    externalAccountCount: data.externalAccounts.filter((account) => account.userId === user.id).length,
    withdrawalCount: data.withdrawals.filter((withdrawal) => withdrawal.userId === user.id).length
  }));
}

export async function listAdminWithdrawals() {
  const data = await db.read();
  return data.withdrawals
    .map((withdrawal) => ({
      ...withdrawal,
      user: data.users.find((user) => user.id === withdrawal.userId) ?? null,
      externalAccount: data.externalAccounts.find((account) => account.id === withdrawal.externalAccountId) ?? null,
      liquidationAddress: data.liquidationAddresses.find((address) => address.id === withdrawal.liquidationAddressId) ?? null
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listAdminWebhookEvents() {
  const data = await db.read();
  return data.webhookEvents.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}


export async function listAdminAuditLogs() {
  const data = await db.read();
  return (data.auditLogs ?? []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listAdminReconciliationRuns() {
  const data = await db.read();
  return (data.reconciliationRuns ?? [])
    .slice()
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((run) => ({
      ...run,
      findings: (data.reconciliationFindings ?? []).filter((finding) => finding.runId === run.id)
    }));
}
