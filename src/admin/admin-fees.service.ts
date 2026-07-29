import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../database/json-database.js';
import { createAuditLog } from '../audit/audit.service.js';
import { nowIso } from '../shared/id.js';

export const feeTierSchema = z.object({
  tier: z.enum(['starter', 'verified', 'pro', 'vip']),
  label: z.string().min(1),
  tradingFeePercent: z.coerce.number().min(0).max(100),
  spreadPercent: z.coerce.number().min(0).max(100),
  minimumFeeUsd: z.coerce.number().min(0),
  description: z.string().max(200)
});

export const networkFeeSchema = z.object({
  network: z.string().min(1),
  estimatedFeeUsd: z.coerce.number().min(0),
  passedThrough: z.boolean().default(true)
});

export const promotionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().max(240),
  status: z.enum(['active', 'scheduled', 'paused']).default('active')
});

export const feeSettingsSchema = z.object({
  onrampFeePercent: z.coerce.number().min(0).max(100),
  offrampFeePercent: z.coerce.number().min(0).max(100),
  /**
   * Fee taken on fiat arriving through a virtual account, passed to Bridge as
   * developer_fee_percent when the account is created.
   *
   * This is a separate lever from the off-ramp fee because the underlying cost
   * differs: Bridge charges 0.50% VA orchestration versus 0.25% basic. It also
   * cannot be changed retroactively - Bridge fixes the fee at virtual account
   * creation - so getting it right before provisioning matters.
   */
  virtualAccountFeePercent: z.coerce.number().min(0).max(100),
  bridgeOfframpCostPercent: z.coerce.number().min(0).max(100),
  rateSources: z.array(z.object({ name: z.string().min(1), weightPercent: z.coerce.number().min(0).max(100), live: z.boolean().default(true) })).default([]),
  feeTiers: z.array(feeTierSchema).min(1),
  networkFees: z.array(networkFeeSchema).default([]),
  promotions: z.array(promotionSchema).default([]),
  updatedBy: z.string().min(2).default('admin_api_key'),
  reason: z.string().min(3).max(1000).default('Update fees and rates')
});

export type AdminFeeSettings = z.infer<typeof feeSettingsSchema> & { updatedAt: string };

function percent(value: number) { return Number(value.toFixed(6)).toString(); }

export function defaultAdminFeeSettings(): AdminFeeSettings {
  const offramp = env.SIVAN_OFFRAMP_FEE_PERCENT || 0;
  const onramp = env.SIVAN_ONRAMP_FEE_PERCENT || offramp;
  // Default the VA fee to the off-ramp fee rather than 0. The env var itself
  // defaults to the string '0.0', so a plain truthiness check would never fall
  // through - only treat it as configured when it parses to a positive number.
  // Previously every virtual account was provisioned at 0%, earning Sivan
  // nothing, and Bridge fixes the fee at creation so it could not be corrected.
  const configuredVaFee = Number(env.BRIDGE_VIRTUAL_ACCOUNT_DEVELOPER_FEE_PERCENT);
  const virtualAccount = Number.isFinite(configuredVaFee) && configuredVaFee > 0
    ? configuredVaFee
    : offramp;
  return {
    onrampFeePercent: Number(percent(onramp)),
    offrampFeePercent: Number(percent(offramp)),
    virtualAccountFeePercent: Number(percent(Number.isFinite(virtualAccount) ? virtualAccount : offramp)),
    bridgeOfframpCostPercent: Number(percent(env.BRIDGE_OFFRAMP_COST_PERCENT)),
    rateSources: [
      { name: 'Bridge', weightPercent: 40, live: true },
      { name: 'CoinGecko', weightPercent: 25, live: true },
      { name: 'Kraken', weightPercent: 20, live: true },
      { name: 'Chainlink', weightPercent: 15, live: true }
    ],
    feeTiers: [
      { tier: 'starter', label: 'Starter (T1)', tradingFeePercent: Number(percent(onramp)), spreadPercent: 0.8, minimumFeeUsd: 1, description: 'New users, KYC L1' },
      { tier: 'verified', label: 'Verified (T2)', tradingFeePercent: Number(percent(Math.max(onramp - 0.05, 0))), spreadPercent: 0.6, minimumFeeUsd: 1, description: 'KYC L2 verified' },
      { tier: 'pro', label: 'Pro (T3)', tradingFeePercent: Number(percent(Math.max(onramp - 0.15, 0))), spreadPercent: 0.4, minimumFeeUsd: 0.5, description: 'High-volume, manually approved' },
      { tier: 'vip', label: 'VIP / OTC', tradingFeePercent: Number(percent(Math.max(onramp - 0.25, 0))), spreadPercent: 0.2, minimumFeeUsd: 0, description: 'By invitation only' }
    ],
    networkFees: [
      { network: 'Avalanche C-Chain', estimatedFeeUsd: 0.03, passedThrough: true },
      { network: 'Base', estimatedFeeUsd: 0.02, passedThrough: true },
      { network: 'Ethereum', estimatedFeeUsd: 1.42, passedThrough: true },
      { network: 'Polygon', estimatedFeeUsd: 0.01, passedThrough: true },
      { network: 'Arbitrum', estimatedFeeUsd: 0.08, passedThrough: true },
      { network: 'Solana', estimatedFeeUsd: 0.01, passedThrough: true }
    ],
    promotions: [
      { id: 'first_trade_zero_fee', name: 'New user zero-fee', description: 'First sell up to $500 — fee 0%', status: 'active' },
      { id: 'volume_boost', name: 'Volume boost', description: 'Reduced fee on high-volume customers', status: 'scheduled' },
      { id: 'referral_bonus', name: 'Referral bonus', description: '$10 per verified referral', status: 'paused' }
    ],
    updatedBy: 'system',
    reason: 'Default fees from environment',
    updatedAt: nowIso()
  };
}

export async function getAdminFeeSettings(): Promise<AdminFeeSettings> {
  const data = await db.read();
  const latest = (data.auditLogs ?? []).filter((log) => log.action === 'admin.fees.updated').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!latest) return defaultAdminFeeSettings();
  return { ...defaultAdminFeeSettings(), ...((latest.metadata as any)?.settings ?? {}), updatedBy: latest.actorId ?? 'admin_api_key', updatedAt: latest.createdAt };
}

export async function updateAdminFeeSettings(input: z.infer<typeof feeSettingsSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const previous = await getAdminFeeSettings();
  const { updatedBy, reason, ...settings } = input;
  const next: AdminFeeSettings = { ...previous, ...settings, updatedBy, reason, updatedAt: nowIso() };
  await createAuditLog({
    actorType: 'admin',
    actorId: updatedBy,
    action: 'admin.fees.updated',
    resourceType: 'admin_fee_settings',
    resourceId: 'global',
    severity: 'warning',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { previous, settings: next, reason }
  });
  return next;
}
