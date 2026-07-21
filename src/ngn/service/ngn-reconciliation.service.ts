import { listNgnTransfers } from './ngn-transfers.service.js';
import { listNgnWebhooks } from './ngn-webhooks.service.js';

export async function getNgnReconciliationSummary() {
  const [transfers, webhooks] = await Promise.all([listNgnTransfers(), listNgnWebhooks()]);
  return {
    generatedAt: new Date().toISOString(),
    transferCount: transfers.length,
    failedSettlements: transfers.filter((item) => item.status === 'failed' || item.status === 'requires_review').length,
    pendingSettlement: transfers.filter((item) => ['settlement_processing', 'bank_processing', 'processing'].includes(item.status)).length,
    webhookCount: webhooks.length,
  };
}
