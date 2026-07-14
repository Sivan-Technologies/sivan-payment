import { db } from '../database/json-database.js';
import { getOnboardingCostSummary } from '../metrics/onboarding-costs.service.js';
import { providerCapabilities } from '../providers/provider-routing.js';

export async function getAdminOverview() {
  const overview = await db.getAdminOverviewView();
  const metrics = await getOnboardingCostSummary();
  return {
    ...overview,
    counts: { ...overview.counts, providers: providerCapabilities.length },
    metrics
  };
}


export async function listAdminUsers(options: { limit?: number; offset?: number } = {}) {
  return db.listAdminUsersView(options);
}

export async function listAdminWithdrawals(options: { limit?: number; offset?: number; status?: string } = {}) {
  return db.listAdminWithdrawalsView(options);
}

export async function listAdminWebhookEvents(options: { limit?: number; offset?: number } = {}) {
  return db.listWebhookEventsView(options);
}


export async function listAdminAuditLogs(options: { limit?: number; offset?: number } = {}) {
  return db.listAuditLogsView(options);
}

export async function listAdminReconciliationRuns(options: { limit?: number; offset?: number } = {}) {
  return db.listReconciliationRunsView(options);
}


export async function listAdminOnrampOrders(options: { limit?: number; offset?: number; status?: string } = {}) {
  return db.listAdminOnrampOrdersView(options);
}
