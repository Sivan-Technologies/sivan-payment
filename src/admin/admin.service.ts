import { db } from '../database/json-database.js';
import { getOnboardingCostSummary } from '../metrics/onboarding-costs.service.js';
import { providerCapabilities } from '../providers/provider-routing.js';

export async function getAdminOverview() {
  const overview = await db.getAdminOverviewView();
  const data = await db.read();
  const ngnTransfers: any[] = (data as any).ngnTransfers ?? [];
  const ngnTransfersByStatus = ngnTransfers.reduce((acc: Record<string, number>, item: any) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});
  const metrics = await getOnboardingCostSummary();
  return {
    ...overview,
    counts: {
      ...overview.counts,
      providers: providerCapabilities.length,
      ngnTransfers: ngnTransfers.length,
      completedNgnTransfers: ngnTransfers.filter((item: any) => item.status === 'completed').length,
      pendingNgnTransfers: ngnTransfers.filter((item: any) => ['created', 'quote_created', 'quote_accepted', 'awaiting_deposit', 'awaiting_crypto_deposit', 'deposit_received', 'blockchain_confirmed', 'processing', 'settlement_processing', 'bank_processing', 'crypto_sent', 'requires_review'].includes(item.status)).length,
    },
    ngnTransfersByStatus,
    recent: {
      ...overview.recent,
      ngnTransfers: ngnTransfers.slice().sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 20),
    },
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
