import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../database/json-database.js';
import { createAuditLog } from '../audit/audit.service.js';
import { badRequest } from '../shared/errors.js';
import { nowIso } from '../shared/id.js';
import { validateTiers } from './fee-policy.js';
import { DEFAULT_TRANSFER_FEE, DEFAULT_TRANSFER_MIN_SEND } from '../balances/transfer-fee-policy.js';

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

export const onrampTierSchema = z.object({
  minAmount: z.coerce.number().min(0),
  maxAmount: z.coerce.number().min(0).nullable(),
  percent: z.coerce.number().min(0).max(100),
});

export const feeSettingsSchema = z.object({
  onrampFeePercent: z.coerce.number().min(0).max(100),
  /**
   * Minimum on-ramp fee in USD, and optional amount tiers.
   *
   * These apply to ON-RAMP ONLY, and that is a property of Bridge's API rather
   * than a product choice. On-ramp sends `developer_fee` as a fixed USD amount
   * that Sivan computes per order, so any shape is expressible. Off-ramp and
   * virtual accounts send a flat percentage fixed before any amount exists, so
   * a floor or tier is impossible there - see fee-policy.ts.
   *
   * Tiers must start at 0, must not overlap or leave gaps, and the last must be
   * open-ended. Validated on save rather than trusted.
   */
  onrampMinimumFeeUsd: z.coerce.number().min(0).max(1000).default(0),
  onrampFeeTiers: z.array(onrampTierSchema).default([]),
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
  /**
   * Floor and ceiling on the virtual account fee, in USD.
   *
   * Why a floor: at 1.25% a $50 deposit earns $0.62 while Bridge charges
   * $0.25 and the customer cost $2 to onboard. Small deposits never pay their
   * way. A $1 floor is still cheaper than Grey, whose minimum is $2.
   *
   * Why a ceiling: Nigerian competitors cap deposit fees ($10 Grey, $15
   * Raenest), so an uncapped percentage makes Sivan look expensive on large
   * deposits. Note Bridge's own 0.50% is NOT capped, so a cap set too low
   * loses money: at a $25 cap the break-even deposit is $5,000. Large money
   * typically arrives by wire, which is why the cap is applied per rail.
   *
   * Both require Bridge to enable `fee_config` on the developer account. It is
   * in beta and gated; until then Bridge rejects the field outright and Sivan
   * falls back to a plain percentage. Zero means "not set".
   */
  virtualAccountMinimumFeeUsd: z.coerce.number().min(0).max(1000).default(0),
  virtualAccountMaximumFeeUsd: z.coerce.number().min(0).max(100000).default(0),
  /**
   * Whether Bridge has enabled fee_config for this account. Sending the field
   * before then fails the whole provisioning call with
   * `"fee_config": "is not yet available"`, so this must stay false until they
   * confirm, and the value is verified at runtime rather than assumed.
   */
  virtualAccountFeeConfigEnabled: z.boolean().default(false),
  /**
   * NGN rail fees, separate from the Bridge on/off-ramp fees above.
   *
   * A separate lever because it is a different rail with a different cost base
   * and different competition:
   *
   *   - the provider differs. Bridge charges ~0.25-0.50%; Breet charges 0.50%
   *     on the NGN rail. Sharing one percentage means a change to one provider
   *     silently reprices the other.
   *   - the flows differ. Bridge moves USD/EUR/GBP; this moves naira between
   *     Nigerian banks and stablecoin.
   *   - the competition differs. Nigerian naira on/off-ramp is priced against
   *     local players, not against a USD wire.
   *
   * These are SIVAN'S MARGIN ONLY. The provider's own fee is added on top by
   * the quote path and reported separately, so the user pays
   * ngnOnrampFeePercent + the provider's cut. Blending them would make a
   * provider price rise indistinguishable from Sivan earning more.
   *
   * Zero means "not set" and the flow falls back to the Bridge on/off-ramp
   * percentages, which is the behaviour every existing deployment already has.
   */
  ngnOnrampFeePercent: z.coerce.number().min(0).max(100).default(0),
  ngnOfframpFeePercent: z.coerce.number().min(0).max(100).default(0),
  /**
   * Minimum NGN margin per transaction, in naira.
   *
   * Same reasoning as the on-ramp USD floor: a percentage of a small transfer
   * does not cover the fixed cost of processing it. Unlike Bridge's virtual
   * accounts there is no provider restriction here, so this can be set freely.
   */
  ngnMinimumFeeNgn: z.coerce.number().min(0).max(10_000_000).default(0),

  /**
   * ───── TRANSFER FEE: crypto-to-crypto sends from a user's own wallet ─────
   *
   * The only fee in this file NOT constrained by a provider's API. Every
   * percentage above is shaped by what Bridge or Breet will accept - off-ramp
   * cannot express a floor at all, because the fee is fixed when the
   * liquidation address is created and no amount exists yet. This one runs on
   * Sivan's own wallet layer, so any shape is possible.
   *
   * It exists because Sivan sponsors gas on every transfer (`sponsor: true` on
   * both the EVM and Solana paths) and charged nothing for it - there was no
   * fee logic anywhere in balance.service.ts.
   *
   * A percentage with a floor and a cap rather than a fixed fee: at $0.50 flat
   * a $10 sender pays 5% while a $100 sender pays 0.5%, ten times the rate for
   * the same service, and small transfers are the core case for a WhatsApp-
   * first Nigerian product. See transfer-fee-policy.ts for the full reasoning
   * and the rejected alternatives.
   *
   * DEDUCTED from the amount, not added: the recipient of a 100 USDC send
   * receives 99.50. Matches exchange withdrawal behaviour.
   */
  transferFeePercent: z.coerce.number().min(0).max(100).default(DEFAULT_TRANSFER_FEE.percent),
  /**
   * Floor, USD. Without it a $2 transfer earns a cent while still costing a
   * sponsored gas payment.
   */
  transferFeeMinimumUsd: z.coerce.number().min(0).max(100).default(DEFAULT_TRANSFER_FEE.minimumUsd),
  /**
   * Cap, USD. Without it 0.5% of a $10,000 transfer is $50 to cover half a cent
   * of Solana gas - indefensible, and it drives away the largest users.
   *
   * This cap is also why ETHEREUM IS DISABLED for transfers rather than priced:
   * L1 gas is $2-5, so no capped fee covers it at any transfer size. 0 disables
   * the cap.
   */
  transferFeeMaximumUsd: z.coerce.number().min(0).max(10_000).default(DEFAULT_TRANSFER_FEE.maximumUsd),
  /**
   * Smallest transfer a user may send.
   *
   * Lives in the FEE TAB, beside the curve it has to agree with: the minimum is
   * what stops the fee floor becoming an absurd effective rate. Previously
   * `process.env.BALANCE_TRANSFER_MIN_AMOUNT || 10`, so changing it needed a
   * redeploy.
   *
   * Lowered 10 -> 5 alongside the fee. The 10 floor partly existed BECAUSE
   * small transfers were a pure loss; once priced, that reason weakens. At a
   * $0.10 fee floor a $5 transfer costs 2% - high but honest. Not lower: at $1
   * the floor would be 10%.
   */
  transferMinimumSendAmount: z.coerce.number().min(0).max(1_000_000).default(DEFAULT_TRANSFER_MIN_SEND),

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
    // No floor and no tiers by default. A flat percentage is the behaviour
    // every existing deployment already has; anything else must be chosen.
    onrampMinimumFeeUsd: 0,
    onrampFeeTiers: [],
    virtualAccountFeePercent: Number(percent(Number.isFinite(virtualAccount) ? virtualAccount : offramp)),
    // Off by default. Bridge has not enabled fee_config, and sending a floor
    // or cap before they do fails the entire provisioning request.
    virtualAccountMinimumFeeUsd: 0,
    virtualAccountMaximumFeeUsd: 0,
    virtualAccountFeeConfigEnabled: false,
    // Zero means "not set": the NGN flows fall back to the Bridge percentages
    // above, preserving existing behaviour until an admin chooses otherwise.
    ngnOnrampFeePercent: Number(percent(env.SIVAN_NGN_ONRAMP_FEE_PERCENT || 0)),
    ngnOfframpFeePercent: Number(percent(env.SIVAN_NGN_OFFRAMP_FEE_PERCENT || 0)),
    ngnMinimumFeeNgn: Number(env.SIVAN_NGN_MINIMUM_FEE_NGN || 0),
    // Transfer fee. Defaults come from transfer-fee-policy.ts rather than being
    // repeated here, so the curve has exactly one definition.
    transferFeePercent: DEFAULT_TRANSFER_FEE.percent,
    transferFeeMinimumUsd: DEFAULT_TRANSFER_FEE.minimumUsd,
    transferFeeMaximumUsd: DEFAULT_TRANSFER_FEE.maximumUsd,
    transferMinimumSendAmount: DEFAULT_TRANSFER_MIN_SEND,
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

  // A tier table with a gap or an overlap makes the fee depend on array order.
  // That surfaces months later as a customer charged the wrong amount, so it is
  // rejected at the boundary rather than stored and discovered.
  const tierErrors = validateTiers(settings.onrampFeeTiers ?? []);
  if (tierErrors.length) {
    throw badRequest(`On-ramp fee tiers are invalid: ${tierErrors.join(' ')}`);
  }

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
