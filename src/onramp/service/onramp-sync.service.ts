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
  const data = await db.read();
  const existing = (data.onrampOrders ?? []).find((item) => item.providerTransferId === transferId || item.id === transfer.client_reference_id);
  if (!existing) return null;
  const status = mapBridgeTransferState(transfer.state ?? transfer.status);
  const order = {
    ...existing,
    providerTransferId: transfer.id ?? existing.providerTransferId,
    status,
    statusReason: transfer.state ?? transfer.status ?? existing.statusReason,
    providerReference: transfer.source_deposit_instructions?.reference ?? transfer.deposit_instructions?.reference ?? existing.providerReference,
    sourceDepositInstructions: transfer.source_deposit_instructions ?? transfer.deposit_instructions ?? existing.sourceDepositInstructions,
    destinationTxHash: transfer.receipt?.destination_tx_hash ?? existing.destinationTxHash,
    receipt: transfer.receipt ?? existing.receipt,
    raw: transfer,
    updatedAt: nowIso(),
    completedAt: status === 'completed' ? (existing.completedAt ?? nowIso()) : existing.completedAt
  };
  return db.updateOnrampOrderRecord(order);
}

export async function requireOnrampOrder(id: string) {
  const data = await db.read();
  const order = (data.onrampOrders ?? []).find((item) => item.id === id);
  if (!order) throw notFound('On-ramp order');
  return order;
}
