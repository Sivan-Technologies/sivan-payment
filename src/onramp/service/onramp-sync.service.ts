import { db } from '../../database/json-database.js';
import type { BridgeOnrampTransfer } from '../bridge/bridge-onramp.types.js';
import { getOfframpProvider } from '../../providers/provider-registry.js';
import { notFound } from '../../shared/errors.js';
import { nowIso } from '../../shared/id.js';
import { mapBridgeTransferState } from './onramp-mapping.js';
import { getOnrampOrder } from './onramp-orders.service.js';

export async function syncOnrampOrder(id: string) {
  const existing = await getOnrampOrder(id);
  if (!existing.providerTransferId) return existing;
  const provider = getOfframpProvider(existing.provider) as any;
  if (!provider.getTransfer) return existing;
  const transfer = await provider.getTransfer(existing.providerTransferId);
  return applyTransferToOnrampOrder(transfer as BridgeOnrampTransfer);
}

export async function applyTransferToOnrampOrder(transfer: BridgeOnrampTransfer) {
  const transferId = transfer?.id;
  if (!transferId) return null;
  return db.mutate((mutable) => {
    const order = (mutable.onrampOrders ?? []).find((item) => item.providerTransferId === transferId || item.id === transfer.client_reference_id);
    if (!order) return null;
    const status = mapBridgeTransferState(transfer.state ?? transfer.status);
    order.providerTransferId = transfer.id ?? order.providerTransferId;
    order.status = status;
    order.statusReason = transfer.state ?? transfer.status ?? order.statusReason;
    order.providerReference = transfer.source_deposit_instructions?.reference ?? transfer.deposit_instructions?.reference ?? order.providerReference;
    order.sourceDepositInstructions = transfer.source_deposit_instructions ?? transfer.deposit_instructions ?? order.sourceDepositInstructions;
    order.destinationTxHash = transfer.receipt?.destination_tx_hash ?? order.destinationTxHash;
    order.receipt = transfer.receipt ?? order.receipt;
    order.raw = transfer;
    order.updatedAt = nowIso();
    if (status === 'completed' && !order.completedAt) order.completedAt = nowIso();
    return order;
  });
}

export async function requireOnrampOrder(id: string) {
  const data = await db.read();
  const order = (data.onrampOrders ?? []).find((item) => item.id === id);
  if (!order) throw notFound('On-ramp order');
  return order;
}
