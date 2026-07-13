import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../database/json-database.js';
import type { Chain, Currency, OnrampOrderRecord, SourceCurrency } from '../../database/types.js';
import { createAuditLog } from '../../audit/audit.service.js';
import { getOfframpProvider } from '../../providers/provider-registry.js';
import { requireCurrencyEnabled, requireSourceAssetEnabled, requireSourceNetworkEnabled } from '../../controls/payment-controls.service.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { id, idempotencyKey, nowIso } from '../../shared/id.js';
import { mapBridgeTransferState } from './onramp-mapping.js';

export const createOnrampOrderSchema = z.object({
  userId: z.string().min(1),
  sourceCurrency: z.enum(['usd', 'gbp', 'eur']).default('usd'),
  sourcePaymentRail: z.string().optional(),
  destinationCurrency: z.enum(['usdc', 'usdt']).default('usdc'),
  destinationChain: z.enum(['ethereum', 'polygon', 'base', 'solana', 'arbitrum', 'avalanche_c_chain']).default('base'),
  destinationAddress: z.string().min(8),
  amount: z.coerce.number().positive()
});

function money(value: number, decimals = 2) {
  return value.toFixed(decimals);
}

export function getOnrampFeePercent(): string {
  const configured = env.SIVAN_ONRAMP_FEE_PERCENT || env.SIVAN_OFFRAMP_FEE_PERCENT || 0;
  return configured.toFixed(2).replace(/\.00$/, '');
}

function defaultOnrampRail(currency: Currency) {
  if (currency === 'eur') return 'sepa';
  if (currency === 'gbp') return 'faster_payments';
  return 'ach_push';
}

function bridgeRailForChain(chain: Chain) {
  return chain === 'avalanche_c_chain' ? 'avalanche_c_chain' : chain;
}

export async function createOnrampOrder(input: z.infer<typeof createOnrampOrderSchema>) {
  await requireCurrencyEnabled(input.sourceCurrency);
  await requireSourceAssetEnabled(input.destinationCurrency);
  await requireSourceNetworkEnabled(input.destinationChain as Chain);

  const data = await db.read();
  const user = data.users.find((item) => item.id === input.userId);
  if (!user) throw notFound('User');
  const customer = data.customers.find((item) => item.userId === input.userId);
  if (!customer) throw badRequest('Complete verification before buying stablecoins');
  if (customer.kycStatus !== 'kyc_approved') throw badRequest('KYC must be approved before buying stablecoins');

  const feePercent = getOnrampFeePercent();
  const feeAmount = input.amount * Number(feePercent) / 100;
  const netAmount = Math.max(0, input.amount - feeAmount);
  const orderId = id('or');
  const now = nowIso();
  const sourcePaymentRail = input.sourcePaymentRail || defaultOnrampRail(input.sourceCurrency as Currency);

  const provider = getOfframpProvider(customer.provider || 'bridge') as any;
  let transfer: any = null;
  if (provider.createOnrampTransfer) {
    transfer = await provider.createOnrampTransfer({
      amount: money(input.amount),
      developerFee: money(feeAmount),
      customerId: customer.providerCustomerId,
      sourceCurrency: input.sourceCurrency as Currency,
      sourcePaymentRail,
      destinationCurrency: input.destinationCurrency as SourceCurrency,
      destinationChain: input.destinationChain as Chain,
      destinationAddress: input.destinationAddress,
      clientReferenceId: orderId,
      idempotencyKey: idempotencyKey('onramp')
    });
  }

  const status = mapBridgeTransferState(transfer?.state ?? transfer?.status ?? 'awaiting_payment');
  const record: OnrampOrderRecord = {
    id: orderId,
    userId: input.userId,
    customerId: customer.id,
    provider: provider.name ?? customer.provider,
    providerTransferId: transfer?.id,
    sourceCurrency: input.sourceCurrency as Currency,
    sourcePaymentRail,
    destinationCurrency: input.destinationCurrency as SourceCurrency,
    destinationChain: input.destinationChain as Chain,
    destinationAddress: input.destinationAddress,
    amount: money(input.amount),
    feePercent,
    feeAmount: money(feeAmount),
    netAmount: money(netAmount, 6),
    providerReference: transfer?.source_deposit_instructions?.reference ?? transfer?.deposit_instructions?.reference ?? transfer?.client_reference_id ?? orderId,
    sourceDepositInstructions: transfer?.source_deposit_instructions ?? transfer?.deposit_instructions ?? transfer?.source,
    destinationTxHash: transfer?.receipt?.destination_tx_hash,
    status,
    statusReason: transfer?.state ?? transfer?.status,
    receipt: transfer?.receipt,
    raw: transfer,
    createdAt: now,
    updatedAt: now,
    completedAt: status === 'completed' ? now : undefined
  };

  await db.mutate((mutable) => {
    mutable.onrampOrders = mutable.onrampOrders ?? [];
    mutable.onrampOrders.push(record);
    return record;
  });

  await createAuditLog({
    actorType: 'user',
    actorId: input.userId,
    action: 'onramp.order_created',
    resourceType: 'payments_onramp_order',
    resourceId: record.id,
    severity: 'info',
    metadata: { provider: record.provider, sourceCurrency: record.sourceCurrency, destinationCurrency: record.destinationCurrency, destinationChain: record.destinationChain, feePercent }
  });

  return record;
}

export async function listOnrampOrders(userId: string) {
  const data = await db.read();
  return (data.onrampOrders ?? []).filter((order) => order.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getOnrampOrder(id: string) {
  const data = await db.read();
  const order = (data.onrampOrders ?? []).find((item) => item.id === id);
  if (!order) throw notFound('On-ramp order');
  return order;
}

export async function syncOnrampOrder(id: string) {
  const existing = await getOnrampOrder(id);
  if (!existing.providerTransferId) return existing;
  const provider = getOfframpProvider(existing.provider) as any;
  if (!provider.getTransfer) return existing;
  const transfer = await provider.getTransfer(existing.providerTransferId);
  return applyTransferToOnrampOrder(transfer);
}

export async function applyTransferToOnrampOrder(transfer: any) {
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

export async function runOnrampReconciliation(input: { dryRun?: boolean; provider?: string; userId?: string } = {}) {
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
