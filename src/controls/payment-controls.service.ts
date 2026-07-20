import { z } from 'zod';
import { db } from '../database/json-database.js';
import type { AssetControlRecord, Chain, Currency, CustomerTypeControlRecord, NetworkControlRecord, PaymentControlRecord, SourceCurrency, VirtualAccountControlRecord } from '../database/types.js';
import { badRequest } from '../shared/errors.js';
import { nowIso } from '../shared/id.js';
import { createAuditLog } from '../audit/audit.service.js';

export const DEFAULT_CUSTOMER_TYPE_CONTROLS: CustomerTypeControlRecord[] = [
  { customerType: 'individual', enabled: true, label: 'Individual', updatedBy: 'system', updatedAt: nowIso() },
  { customerType: 'business', enabled: false, label: 'Business', updatedBy: 'system', updatedAt: nowIso() }
];

export const DEFAULT_PAYMENT_CONTROLS: PaymentControlRecord[] = [
  { currency: 'usd', enabled: true, label: 'USD — US bank account', accountType: 'us', defaultPaymentRail: 'ach', updatedBy: 'system', updatedAt: nowIso() },
  { currency: 'gbp', enabled: true, label: 'GBP — UK bank account', accountType: 'gb', defaultPaymentRail: 'faster_payments', updatedBy: 'system', updatedAt: nowIso() },
  { currency: 'eur', enabled: true, label: 'EUR — SEPA / IBAN', accountType: 'iban', defaultPaymentRail: 'sepa', updatedBy: 'system', updatedAt: nowIso() }
];


export const DEFAULT_VIRTUAL_ACCOUNT_CONTROLS: VirtualAccountControlRecord[] = [
  { currency: 'usd', enabled: false, label: 'USD virtual account', provider: 'bridge', accountType: 'us', paymentRails: ['ach_push', 'wire'], updatedBy: 'system', updatedAt: nowIso() },
  { currency: 'gbp', enabled: false, label: 'GBP virtual account', provider: 'bridge', accountType: 'gb', paymentRails: ['faster_payments'], updatedBy: 'system', updatedAt: nowIso() },
  { currency: 'eur', enabled: false, label: 'EUR virtual account', provider: 'bridge', accountType: 'iban', paymentRails: ['sepa'], updatedBy: 'system', updatedAt: nowIso() }
];

export const DEFAULT_ASSET_CONTROLS: AssetControlRecord[] = [
  { asset: 'usdc', enabled: true, label: 'USDC', updatedBy: 'system', updatedAt: nowIso() },
  { asset: 'usdt', enabled: false, label: 'USDT', updatedBy: 'system', updatedAt: nowIso() }
];

export const DEFAULT_NETWORK_CONTROLS: NetworkControlRecord[] = [
  { network: 'base', enabled: false, label: 'Base', sortOrder: 10, updatedBy: 'system', updatedAt: nowIso() },
  { network: 'polygon', enabled: false, label: 'Polygon', sortOrder: 20, updatedBy: 'system', updatedAt: nowIso() },
  { network: 'ethereum', enabled: false, label: 'Ethereum', sortOrder: 30, updatedBy: 'system', updatedAt: nowIso() },
  { network: 'solana', enabled: false, label: 'Solana', sortOrder: 40, updatedBy: 'system', updatedAt: nowIso() },
  { network: 'arbitrum', enabled: false, label: 'Arbitrum', sortOrder: 50, updatedBy: 'system', updatedAt: nowIso() },
  { network: 'avalanche_c_chain', enabled: true, label: 'Avalanche C-Chain', sortOrder: 60, updatedBy: 'system', updatedAt: nowIso() }
];

export const updatePaymentControlsSchema = z.object({
  customerTypes: z.array(z.object({
    customerType: z.enum(['individual', 'business']),
    enabled: z.boolean()
  })).optional(),
  payoutCurrencies: z.array(z.object({
    currency: z.enum(['usd', 'gbp', 'eur']),
    enabled: z.boolean()
  })).optional(),
  virtualAccounts: z.array(z.object({
    currency: z.enum(['usd', 'gbp', 'eur']),
    enabled: z.boolean()
  })).optional(),
  sourceAssets: z.array(z.object({
    asset: z.enum(['usdc', 'usdt']),
    enabled: z.boolean()
  })).optional(),
  sourceNetworks: z.array(z.object({
    network: z.enum(['ethereum', 'polygon', 'base', 'solana', 'arbitrum', 'avalanche_c_chain']),
    enabled: z.boolean()
  })).optional(),
  // Legacy support for older admin frontend payloads.
  controls: z.array(z.object({
    currency: z.enum(['usd', 'gbp', 'eur']),
    enabled: z.boolean()
  })).optional()
});

export interface OfframpControlsResponse {
  customerTypes: CustomerTypeControlRecord[];
  payoutCurrencies: PaymentControlRecord[];
  virtualAccounts: VirtualAccountControlRecord[];
  sourceAssets: AssetControlRecord[];
  sourceNetworks: NetworkControlRecord[];
}

export async function listPaymentControls(): Promise<OfframpControlsResponse> {
  const data = await db.read();
  const existingCustomerTypes = data.customerTypeControls ?? [];
  const existingPayouts = data.paymentControls ?? [];
  const existingAssets = data.assetControls ?? [];
  const existingVirtualAccounts = data.virtualAccountControls ?? [];
  const existingNetworks = data.networkControls ?? [];

  return {
    customerTypes: DEFAULT_CUSTOMER_TYPE_CONTROLS.map((defaultControl) => ({
      ...defaultControl,
      ...(existingCustomerTypes.find((item) => item.customerType === defaultControl.customerType) ?? {})
    })),
    payoutCurrencies: DEFAULT_PAYMENT_CONTROLS.map((defaultControl) => ({
      ...defaultControl,
      ...(existingPayouts.find((item) => item.currency === defaultControl.currency) ?? {})
    })),
    virtualAccounts: DEFAULT_VIRTUAL_ACCOUNT_CONTROLS.map((defaultControl) => ({
      ...defaultControl,
      ...(existingVirtualAccounts.find((item) => item.currency === defaultControl.currency) ?? {})
    })),
    sourceAssets: DEFAULT_ASSET_CONTROLS.map((defaultControl) => ({
      ...defaultControl,
      ...(existingAssets.find((item) => item.asset === defaultControl.asset) ?? {})
    })),
    sourceNetworks: DEFAULT_NETWORK_CONTROLS.map((defaultControl) => ({
      ...defaultControl,
      ...(existingNetworks.find((item) => item.network === defaultControl.network) ?? {})
    })).sort((a, b) => a.sortOrder - b.sortOrder)
  };
}

export async function getEnabledPaymentControls() {
  return (await listPaymentControls()).payoutCurrencies.filter((control) => control.enabled);
}

export async function requireCustomerTypeEnabled(customerType: 'individual' | 'business') {
  const controls = await listPaymentControls();
  const control = controls.customerTypes.find((item) => item.customerType === customerType);
  if (!control?.enabled) {
    throw badRequest(`${control?.label ?? customerType} verification is currently unavailable`);
  }
  return control;
}

export async function requireCurrencyEnabled(currency: Currency) {
  const controls = await listPaymentControls();
  const control = controls.payoutCurrencies.find((item) => item.currency === currency);
  if (!control?.enabled) {
    throw badRequest(`${currency.toUpperCase()} withdrawals are currently unavailable`);
  }
  return control;
}

export async function requireSourceAssetEnabled(asset: SourceCurrency) {
  const controls = await listPaymentControls();
  const control = controls.sourceAssets.find((item) => item.asset === asset);
  if (!control?.enabled) {
    throw badRequest(`${asset.toUpperCase()} deposits are currently unavailable`);
  }
  return control;
}

export async function requireSourceNetworkEnabled(network: Chain) {
  const controls = await listPaymentControls();
  const control = controls.sourceNetworks.find((item) => item.network === network);
  if (!control?.enabled) {
    throw badRequest(`${control?.label ?? network} network deposits are currently unavailable`);
  }
  return control;
}

export async function updatePaymentControls(input: z.infer<typeof updatePaymentControlsSchema>, actorId = 'admin_api_key') {
  const now = nowIso();
  const current = await listPaymentControls();

  const customerTypePatch = input.customerTypes ?? [];
  const payoutPatch = input.payoutCurrencies ?? input.controls ?? [];
  const assetPatch = input.sourceAssets ?? [];
  const virtualAccountPatch = input.virtualAccounts ?? [];
  const networkPatch = input.sourceNetworks ?? [];

  const customerTypes = current.customerTypes.map((control) => {
    const patch = customerTypePatch.find((item) => item.customerType === control.customerType);
    return patch ? { ...control, enabled: patch.enabled, updatedBy: actorId, updatedAt: now } : control;
  });
  const payoutCurrencies = current.payoutCurrencies.map((control) => {
    const patch = payoutPatch.find((item) => item.currency === control.currency);
    return patch ? { ...control, enabled: patch.enabled, updatedBy: actorId, updatedAt: now } : control;
  });
  const virtualAccounts = current.virtualAccounts.map((control) => {
    const patch = virtualAccountPatch.find((item) => item.currency === control.currency);
    return patch ? { ...control, enabled: patch.enabled, updatedBy: actorId, updatedAt: now } : control;
  });
  const sourceAssets = current.sourceAssets.map((control) => {
    const patch = assetPatch.find((item) => item.asset === control.asset);
    return patch ? { ...control, enabled: patch.enabled, updatedBy: actorId, updatedAt: now } : control;
  });
  const sourceNetworks = current.sourceNetworks.map((control) => {
    const patch = networkPatch.find((item) => item.network === control.network);
    return patch ? { ...control, enabled: patch.enabled, updatedBy: actorId, updatedAt: now } : control;
  });

  if (!customerTypes.some((control) => control.enabled)) {
    throw badRequest('At least one customer type must remain enabled');
  }
  if (!payoutCurrencies.some((control) => control.enabled)) {
    throw badRequest('At least one payout currency must remain enabled');
  }
  if (!sourceAssets.some((control) => control.enabled)) {
    throw badRequest('At least one deposit asset must remain enabled');
  }
  if (!sourceNetworks.some((control) => control.enabled)) {
    throw badRequest('At least one deposit network must remain enabled');
  }

  await db.updatePaymentControlsSnapshot({ customerTypes, payoutCurrencies, virtualAccounts, sourceAssets, sourceNetworks });

  await createAuditLog({
    actorType: 'admin',
    actorId,
    action: 'payment_controls.updated',
    resourceType: 'payments_control_settings',
    severity: 'warning',
    metadata: {
      customerTypes: customerTypes.map(({ customerType, enabled }) => ({ customerType, enabled })),
      payoutCurrencies: payoutCurrencies.map(({ currency, enabled }) => ({ currency, enabled })),
      virtualAccounts: virtualAccounts.map(({ currency, enabled }) => ({ currency, enabled })),
      sourceAssets: sourceAssets.map(({ asset, enabled }) => ({ asset, enabled })),
      sourceNetworks: sourceNetworks.map(({ network, enabled }) => ({ network, enabled }))
    }
  });

  return { customerTypes, payoutCurrencies, virtualAccounts, sourceAssets, sourceNetworks };
}
