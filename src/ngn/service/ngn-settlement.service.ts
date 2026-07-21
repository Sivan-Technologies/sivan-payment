import { listNgnTransfers } from './ngn-transfers.service.js';

export async function listNgnSettlementQueue() {
  const transfers = await listNgnTransfers();
  return transfers.filter((item) => ['settlement_processing', 'bank_processing', 'requires_review', 'failed'].includes(item.status));
}
