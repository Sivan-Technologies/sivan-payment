import { z } from 'zod';
import { db } from '../../database/json-database.js';
import { createAuditLog } from '../../audit/audit.service.js';

export interface NgnTransferFeeTier {
  min: number;
  max: number | null;
  networkFee: number;
}

export interface NgnTransferFeePolicy {
  enabled: boolean;
  floorFeeNgn: number;
  stampDutyThresholdNgn: number;
  stampDutyAmountNgn: number;
  tiers: NgnTransferFeeTier[];
}

export interface NgnTransferFeeCalculation {
  principal: number;
  networkFee: number;
  stampDuty: number;
  totalFee: number;
  totalDebit: number;
  isStampDutyApplicable: boolean;
}

export const DEFAULT_NGN_TRANSFER_FEE_POLICY: NgnTransferFeePolicy = {
  enabled: true,
  floorFeeNgn: 20,
  stampDutyThresholdNgn: 10000,
  stampDutyAmountNgn: 50,
  tiers: [
    { min: 0, max: 9999, networkFee: 20 },
    { min: 10000, max: 49999, networkFee: 20 },
    { min: 50000, max: 99999, networkFee: 30 },
    { min: 100000, max: 199999, networkFee: 50 },
    { min: 200000, max: null, networkFee: 70 },
  ],
};

export const ngnTransferFeePolicySchema = z.object({
  enabled: z.boolean().default(true),
  floorFeeNgn: z.coerce.number().min(0).default(20),
  stampDutyThresholdNgn: z.coerce.number().min(1).default(10000),
  stampDutyAmountNgn: z.coerce.number().min(0).default(50),
  tiers: z.array(
    z.object({
      min: z.coerce.number().min(0),
      max: z.coerce.number().nullable(),
      networkFee: z.coerce.number().min(0),
    })
  ).default(DEFAULT_NGN_TRANSFER_FEE_POLICY.tiers),
});

let cachedPolicy: NgnTransferFeePolicy | null = null;
let policyCachedAt = 0;
const POLICY_CACHE_TTL_MS = 60_000;

/**
 * Fetch the active transfer fee policy from database settings or return default.
 */
export async function getNgnTransferFeePolicy(): Promise<NgnTransferFeePolicy> {
  const now = Date.now();
  if (cachedPolicy && now - policyCachedAt < POLICY_CACHE_TTL_MS) {
    return cachedPolicy;
  }

  try {
    const latest = await db.latestAuditLogByAction('admin.ngn_transfer_fee.updated');
    if (latest && (latest.metadata as any)?.policy) {
      const parsed = ngnTransferFeePolicySchema.safeParse((latest.metadata as any).policy);
      if (parsed.success) {
        cachedPolicy = parsed.data as NgnTransferFeePolicy;
        policyCachedAt = now;
        return cachedPolicy;
      }
    }
  } catch {
    // Non-fatal, fall back to default
  }

  cachedPolicy = DEFAULT_NGN_TRANSFER_FEE_POLICY;
  policyCachedAt = now;
  return cachedPolicy;
}

/**
 * Save or update the active transfer fee policy in the database.
 */
export async function setNgnTransferFeePolicy(
  policyInput: Partial<NgnTransferFeePolicy>,
  actorId = 'admin'
): Promise<NgnTransferFeePolicy> {
  const current = await getNgnTransferFeePolicy();
  const merged = {
    ...current,
    ...policyInput,
  };
  const validated = ngnTransferFeePolicySchema.parse(merged) as NgnTransferFeePolicy;

  await createAuditLog({
    actorType: 'admin',
    actorId,
    action: 'admin.ngn_transfer_fee.updated',
    resourceType: 'ngn_transfer_fee_policy',
    resourceId: 'global',
    metadata: { previous: current, policy: validated },
  });

  cachedPolicy = validated;
  policyCachedAt = Date.now();
  return validated;
}

/**
 * Calculate NGN transfer fees:
 * 1. Match network fee from configured tiers (enforcing minimum floor fee).
 * 2. Calculate mandatory CBN Electronic Money Transfer Levy (EMTL / Stamp Duty)
 *    of ₦50 for transactions >= ₦10,000 (₦0 for < ₦10,000).
 * 3. Total fee = networkFee + stampDuty.
 * 4. Total debit = principal + totalFee.
 */
export function calculateNgnTransferFee(
  amount: number,
  policy: NgnTransferFeePolicy = DEFAULT_NGN_TRANSFER_FEE_POLICY
): NgnTransferFeeCalculation {
  const safeAmount = Math.max(0, Number(amount) || 0);
  if (!policy.enabled || safeAmount <= 0) {
    return {
      principal: safeAmount,
      networkFee: 0,
      stampDuty: 0,
      totalFee: 0,
      totalDebit: safeAmount,
      isStampDutyApplicable: false,
    };
  }

  const floor = policy.floorFeeNgn ?? 20;
  let matchedFee = floor;

  if (Array.isArray(policy.tiers) && policy.tiers.length > 0) {
    const tier = policy.tiers.find((t) => {
      const aboveMin = safeAmount >= t.min;
      const belowMax = t.max === null || safeAmount <= t.max;
      return aboveMin && belowMax;
    });
    if (tier && typeof tier.networkFee === 'number') {
      matchedFee = Math.max(floor, tier.networkFee);
    }
  }

  const isStampDutyApplicable = safeAmount >= (policy.stampDutyThresholdNgn ?? 10000);
  const stampDuty = isStampDutyApplicable ? (policy.stampDutyAmountNgn ?? 50) : 0;
  const totalFee = matchedFee + stampDuty;

  return {
    principal: safeAmount,
    networkFee: matchedFee,
    stampDuty,
    totalFee,
    totalDebit: safeAmount + totalFee,
    isStampDutyApplicable,
  };
}

/**
 * Convenience async helper fetching live policy from database before calculating.
 */
export async function calculateNgnOutboundTransferFee(
  amount: number
): Promise<NgnTransferFeeCalculation> {
  const policy = await getNgnTransferFeePolicy();
  return calculateNgnTransferFee(amount, policy);
}
