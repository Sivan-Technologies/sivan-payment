import { db } from '../../database/json-database.js';
import type { Chain, Currency, OnrampOrderRecord, SourceCurrency } from '../../database/types.js';
import { createAuditLog } from '../../audit/audit.service.js';
import { getOfframpProvider } from '../../providers/provider-registry.js';
import { notFound } from '../../shared/errors.js';
import { id, idempotencyKey, nowIso } from '../../shared/id.js';
import { mapBridgeTransferState } from './onramp-mapping.js';
import { calculateOnrampQuote } from './onramp-fees.service.js';
import { defaultOnrampRail, bridgeRailForChain } from './onramp-rails.service.js';
import { validateOnrampOrderInput } from './onramp-validation.service.js';
import type { CreateOnrampOrderInput } from '../types/onramp.schemas.js';
import type { BridgeOnrampTransfer } from '../bridge/bridge-onramp.types.js';

export async function createOnrampOrder(input: CreateOnrampOrderInput) {
  const { customer } = await validateOnrampOrderInput(input);
  const quote = await calculateOnrampQuote(input.amount);
  const orderId = id('or');
  const now = nowIso();
  const sourcePaymentRail = input.sourcePaymentRail || defaultOnrampRail(input.sourceCurrency as Currency);
  const provider = getOfframpProvider(customer.provider || 'bridge') as any;

  let transfer: BridgeOnrampTransfer | null = null;
  if (provider.createOnrampTransfer) {
    transfer = await provider.createOnrampTransfer({
      amount: quote.amount,
      developerFee: quote.feeAmount,
      customerId: customer.providerCustomerId,
      sourceCurrency: input.sourceCurrency as Currency,
      sourcePaymentRail,
      destinationCurrency: input.destinationCurrency as SourceCurrency,
      destinationChain: bridgeRailForChain(input.destinationChain as Chain),
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
    amount: quote.amount,
    feePercent: quote.feePercent,
    feeAmount: quote.feeAmount,
    netAmount: quote.netAmount,
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

  await db.insertOnrampOrderRecord(record);

  await createAuditLog({
    actorType: 'user',
    actorId: input.userId,
    action: 'onramp.order_created',
    resourceType: 'payments_onramp_order',
    resourceId: record.id,
    severity: 'info',
    metadata: { provider: record.provider, sourceCurrency: record.sourceCurrency, destinationCurrency: record.destinationCurrency, destinationChain: record.destinationChain, feePercent: record.feePercent }
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
