import { z } from 'zod';
import { db } from '../database/json-database.js';
import type { Currency, PaymentControlRecord } from '../database/types.js';
import { badRequest } from '../shared/errors.js';
import { nowIso } from '../shared/id.js';
import { createAuditLog } from '../audit/audit.service.js';

export const DEFAULT_PAYMENT_CONTROLS: PaymentControlRecord[] = [
  { currency: 'usd', enabled: true, label: 'USD — US bank account', accountType: 'us', defaultPaymentRail: 'ach', updatedBy: 'system', updatedAt: nowIso() },
  { currency: 'gbp', enabled: true, label: 'GBP — UK bank account', accountType: 'gb', defaultPaymentRail: 'faster_payments', updatedBy: 'system', updatedAt: nowIso() },
  { currency: 'eur', enabled: true, label: 'EUR — SEPA / IBAN', accountType: 'iban', defaultPaymentRail: 'sepa', updatedBy: 'system', updatedAt: nowIso() }
];

export const updatePaymentControlsSchema = z.object({
  controls: z.array(z.object({
    currency: z.enum(['usd', 'gbp', 'eur']),
    enabled: z.boolean()
  })).min(1)
});

export async function listPaymentControls() {
  const data = await db.read();
  const existing = data.paymentControls ?? [];
  return DEFAULT_PAYMENT_CONTROLS.map((defaultControl) => ({
    ...defaultControl,
    ...(existing.find((item) => item.currency === defaultControl.currency) ?? {})
  }));
}

export async function getEnabledPaymentControls() {
  return (await listPaymentControls()).filter((control) => control.enabled);
}

export async function requireCurrencyEnabled(currency: Currency) {
  const controls = await listPaymentControls();
  const control = controls.find((item) => item.currency === currency);
  if (!control?.enabled) {
    throw badRequest(`${currency.toUpperCase()} withdrawals are currently unavailable`);
  }
  return control;
}

export async function updatePaymentControls(input: z.infer<typeof updatePaymentControlsSchema>, actorId = 'admin_api_key') {
  const now = nowIso();
  const defaults = await listPaymentControls();
  const updated = defaults.map((control) => {
    const patch = input.controls.find((item) => item.currency === control.currency);
    return patch ? { ...control, enabled: patch.enabled, updatedBy: actorId, updatedAt: now } : control;
  });

  // Keep at least one rail/currency enabled so users are not fully blocked by mistake.
  if (!updated.some((control) => control.enabled)) {
    throw badRequest('At least one payout currency must remain enabled');
  }

  await db.mutate((data) => {
    data.paymentControls = updated;
    return updated;
  });

  await createAuditLog({
    actorType: 'admin',
    actorId,
    action: 'payment_controls.updated',
    resourceType: 'payments_control_settings',
    severity: 'warning',
    metadata: { controls: updated.map(({ currency, enabled }) => ({ currency, enabled })) }
  });

  return updated;
}
