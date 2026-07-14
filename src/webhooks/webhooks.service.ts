import { db } from '../database/json-database.js';
import type { WebhookEventRecord, WithdrawalRecord } from '../database/types.js';
import { getOfframpProvider } from '../providers/provider-registry.js';
import { badRequest, conflict } from '../shared/errors.js';
import { id, nowIso } from '../shared/id.js';
import { mapBridgeKycStatus } from '../customers/customer-mapping.js';
import { mapBridgeDrainState } from '../offramp/service/withdrawal-mapping.js';
import { mapBridgeTransferState } from '../onramp/service/onramp-mapping.js';

export interface BridgeWebhookPayload {
  event_id?: string;
  event_category?: string;
  event_type?: string;
  event_object_id?: string;
  event_object_status?: string;
  event_object?: any;
  event_created_at?: string;
  [key: string]: unknown;
}

export async function processBridgeWebhook(payload: BridgeWebhookPayload, rawBody: Buffer, signatureHeader?: string) {
  const provider = getOfframpProvider('bridge');
  if (!provider.verifyWebhookSignature(rawBody, signatureHeader)) {
    throw badRequest('Invalid Bridge webhook signature');
  }

  const eventId = payload.event_id;
  if (!eventId) throw badRequest('Webhook payload is missing event_id');

  const now = nowIso();

  const data = await db.read();
  const existing = data.webhookEvents.find((event) => event.provider === 'bridge' && event.providerEventId === eventId);
  if (existing?.processedAt) {
    return { duplicate: true, event: existing };
  }
  if (existing) {
    throw conflict('Webhook event is already being processed');
  }

  const event: WebhookEventRecord = {
    id: id('wh'),
    provider: 'bridge',
    providerEventId: eventId,
    eventCategory: payload.event_category,
    eventType: payload.event_type,
    eventObjectId: payload.event_object_id,
    payload,
    createdAt: now
  };
  await db.insertWebhookEventRecord(event);

  const eventCategory = normalizeEventCategory(payload.event_category);
  if (eventCategory === 'liquidation_address_drain') {
    const withdrawal = applyLiquidationDrainEvent(data, payload);
    if (withdrawal) await db.updateWithdrawalRecord(withdrawal);
  }
  if (eventCategory === 'customer') {
    const customer = applyCustomerEvent(data, payload);
    if (customer) await db.updateCustomerRecord(customer);
  }
  if (eventCategory === 'kyc_link') {
    const customer = applyKycLinkEvent(data, payload);
    if (customer) await db.updateCustomerRecord(customer);
  }
  if (eventCategory === 'external_account' || eventCategory === 'external_acccount') {
    const account = applyExternalAccountEvent(data, payload);
    if (account) await db.updateExternalAccountRecord(account);
  }
  if (eventCategory === 'transfer' || eventCategory === 'transfers') {
    const order = applyTransferEvent(data, payload);
    if (order) await db.updateOnrampOrderRecord(order);
  }

  event.processedAt = nowIso();
  await db.updateWebhookEventRecord(event);
  return { duplicate: false, event };
}


function normalizeEventCategory(category?: string): string {
  return (category ?? '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[\s.\-]+/g, '_');
}

function applyLiquidationDrainEvent(data: any, payload: BridgeWebhookPayload): WithdrawalRecord | undefined {
  const drain = payload.event_object ?? {};
  const providerLiquidationAddressId = drain.liquidation_address_id;
  if (!providerLiquidationAddressId) return undefined;

  const la = data.liquidationAddresses.find((item: any) => item.providerLiquidationAddressId === providerLiquidationAddressId);
  if (!la) return undefined;

  let withdrawal: WithdrawalRecord | undefined = data.withdrawals.find(
    (w: WithdrawalRecord) => w.providerDrainId === drain.id
  );

  if (!withdrawal) {
    withdrawal = data.withdrawals
      .filter((w: WithdrawalRecord) => w.liquidationAddressId === la.id && ['pending_deposit', 'deposit_received', 'payout_processing'].includes(w.status))
      .sort((a: WithdrawalRecord, b: WithdrawalRecord) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  if (!withdrawal) return undefined;

  const status = mapBridgeDrainState(drain.state ?? payload.event_object_status);
  withdrawal.providerDrainId = drain.id ?? withdrawal.providerDrainId;
  withdrawal.sourceAmount = drain.source_amount ?? withdrawal.sourceAmount;
  withdrawal.destinationAmount = drain.amount ?? withdrawal.destinationAmount;
  withdrawal.feeAmount = drain.developer_fee ?? drain.receipt?.developer_fee ?? withdrawal.feeAmount;
  withdrawal.destinationCurrency = drain.currency ?? withdrawal.destinationCurrency;
  withdrawal.depositTxHash = drain.deposit_tx_hash ?? withdrawal.depositTxHash;
  withdrawal.destinationTxHash = drain.destination_tx_hash ?? withdrawal.destinationTxHash;
  withdrawal.status = status;
  withdrawal.statusReason = drain.state ?? payload.event_object_status;
  withdrawal.raw = drain;
  withdrawal.updatedAt = nowIso();
  if (status === 'completed' && !withdrawal.completedAt) withdrawal.completedAt = nowIso();
  return withdrawal;
}

function applyCustomerEvent(data: any, payload: BridgeWebhookPayload): any | undefined {
  const customerObject = payload.event_object ?? {};
  const customer = data.customers.find((c: any) => c.providerCustomerId === customerObject.id);
  if (!customer) return undefined;
  customer.kycStatus = mapBridgeKycStatus(customerObject.kyc_status ?? customerObject.status ?? payload.event_object_status);
  customer.raw = customerObject;
  customer.updatedAt = nowIso();
  return customer;
}

function applyKycLinkEvent(data: any, payload: BridgeWebhookPayload): any | undefined {
  const kyc = payload.event_object ?? {};
  const customer = data.customers.find((c: any) => c.kycLinkId === kyc.id || c.providerCustomerId === kyc.customer_id);
  if (!customer) return undefined;
  customer.kycStatus = mapBridgeKycStatus(kyc.kyc_status ?? payload.event_object_status);
  customer.tosStatus = kyc.tos_status === 'approved' ? 'approved' : customer.tosStatus;
  customer.raw = kyc;
  customer.updatedAt = nowIso();
  return customer;
}


function applyTransferEvent(data: any, payload: BridgeWebhookPayload): any | undefined {
  const transfer = payload.event_object ?? {};
  const transferId = transfer.id ?? payload.event_object_id;
  if (!transferId) return undefined;
  const order = (data.onrampOrders ?? []).find((item: any) => item.providerTransferId === transferId || item.id === transfer.client_reference_id);
  if (!order) return undefined;
  const status = mapBridgeTransferState(transfer.state ?? transfer.status ?? payload.event_object_status);
  order.providerTransferId = transferId;
  order.status = status;
  order.statusReason = transfer.state ?? transfer.status ?? payload.event_object_status;
  order.providerReference = transfer.source_deposit_instructions?.reference ?? transfer.deposit_instructions?.reference ?? order.providerReference;
  order.sourceDepositInstructions = transfer.source_deposit_instructions ?? transfer.deposit_instructions ?? order.sourceDepositInstructions;
  order.destinationTxHash = transfer.receipt?.destination_tx_hash ?? order.destinationTxHash;
  order.receipt = transfer.receipt ?? order.receipt;
  order.raw = transfer;
  order.updatedAt = nowIso();
  if (status === 'completed' && !order.completedAt) order.completedAt = nowIso();
  return order;
}

function applyExternalAccountEvent(data: any, payload: BridgeWebhookPayload): any | undefined {
  const external = payload.event_object ?? {};
  const account = data.externalAccounts.find((ea: any) => ea.providerExternalAccountId === external.id);
  if (!account) return undefined;
  account.status = external.active === false ? 'deactivated' : account.status;
  account.raw = external;
  account.updatedAt = nowIso();
  return account;
}
