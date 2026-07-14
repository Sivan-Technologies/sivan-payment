import { db } from '../../database/json-database.js';
import { getOfframpProvider } from '../../providers/provider-registry.js';
import { mapBridgeTransferState } from './onramp-mapping.js';
import { applyTransferToOnrampOrder } from './onramp-sync.service.js';

export interface OnrampReconciliationInput {
  dryRun?: boolean;
  provider?: string;
  userId?: string;
}

export async function runOnrampReconciliation(input: OnrampReconciliationInput = {}) {
  const dryRun = input.dryRun ?? true;
  const data = await db.read();
  const orders = (data.onrampOrders ?? []).filter((order) => {
    if (input.provider && order.provider !== input.provider) return false;
    if (input.userId && order.userId !== input.userId) return false;
    return Boolean(order.providerTransferId);
  });

  const findings: any[] = [];
  let providerErrors = 0;
  let updatedOrders = 0;

  for (const order of orders) {
    try {
      const provider = getOfframpProvider(order.provider) as any;
      if (!provider.getTransfer) continue;
      const transfer: any = await provider.getTransfer(order.providerTransferId!);
      const nextStatus = mapBridgeTransferState(transfer.state ?? transfer.status);
      const needsUpdate = order.status !== nextStatus || order.destinationTxHash !== transfer.receipt?.destination_tx_hash;

      findings.push({
        type: needsUpdate ? (dryRun ? 'would_update_onramp_order' : 'updated_onramp_order') : 'matched_onramp_order',
        severity: 'info',
        message: `${dryRun ? 'Checked' : 'Synced'} on-ramp order ${order.id}`,
        orderId: order.id,
        previousStatus: order.status,
        nextStatus,
        providerTransferId: order.providerTransferId
      });

      if (needsUpdate && !dryRun) {
        await applyTransferToOnrampOrder(transfer);
        updatedOrders += 1;
      }
    } catch (error) {
      providerErrors += 1;
      findings.push({ type: 'provider_error', severity: 'error', orderId: order.id, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return { dryRun, summary: { checkedOrders: orders.length, updatedOrders, providerErrors }, findings };
}
