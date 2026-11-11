import { z } from 'zod';
import { db } from '../database/json-database.js';
import { nowIso } from '../shared/id.js';
import { badRequest } from '../shared/errors.js';
import { createAuditLog } from '../audit/audit.service.js';

export interface CorridorComplianceNgRecord {
  corridor: 'nigeria';
  currency: 'NGN';
  singleTxLimitNgn: number;
  monthlyCapNgn: number;
  tier2Enforced: boolean;
  autoPromptEnabled: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface CorridorComplianceGlobalRecord {
  corridor: 'global';
  currency: 'USD';
  singleTxLimitUsd: number;
  monthlyCapUsd: number;
  tier2Enforced: boolean;
  autoPromptEnabled: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface ComplianceThresholdsResponse {
  nigeria: CorridorComplianceNgRecord;
  global: CorridorComplianceGlobalRecord;
}

export const DEFAULT_COMPLIANCE_LIMITS_NG: CorridorComplianceNgRecord = {
  corridor: 'nigeria',
  currency: 'NGN',
  singleTxLimitNgn: 2000000, // ₦2,000,000 NGN (~$1,470 USD)
  monthlyCapNgn: 7500000,    // ₦7,500,000 NGN (~$5,500 USD)
  tier2Enforced: false,      // Growth Mode (zero paperwork friction) by default
  autoPromptEnabled: true,
  updatedAt: nowIso(),
  updatedBy: 'system',
};

export const DEFAULT_COMPLIANCE_LIMITS_GLOBAL: CorridorComplianceGlobalRecord = {
  corridor: 'global',
  currency: 'USD',
  singleTxLimitUsd: 2500,   // $2,500 USD
  monthlyCapUsd: 10000,     // $10,000 USD
  tier2Enforced: false,     // Growth Mode (zero paperwork friction) by default
  autoPromptEnabled: true,
  updatedAt: nowIso(),
  updatedBy: 'system',
};

const SETTING_KEY_NG = 'compliance_limits_ng';
const SETTING_KEY_GLOBAL = 'compliance_limits_global';

export const updateComplianceThresholdsSchema = z.object({
  corridor: z.enum(['nigeria', 'global']),
  singleTxLimit: z.number().positive('Single transaction limit must be greater than zero'),
  monthlyCap: z.number().positive('Monthly cap must be greater than zero'),
  tier2Enforced: z.boolean(),
  autoPromptEnabled: z.boolean().optional().default(true),
});

export type UpdateComplianceThresholdsInput = z.infer<typeof updateComplianceThresholdsSchema>;

/**
 * Retrieves the compliance and step-up KYC settings for both Nigeria and Global corridors.
 */
export async function getComplianceThresholds(): Promise<ComplianceThresholdsResponse> {
  const ngSetting = await db.getSystemSetting<CorridorComplianceNgRecord>(SETTING_KEY_NG);
  const globalSetting = await db.getSystemSetting<CorridorComplianceGlobalRecord>(SETTING_KEY_GLOBAL);

  return {
    nigeria: ngSetting
      ? { ...DEFAULT_COMPLIANCE_LIMITS_NG, ...ngSetting }
      : { ...DEFAULT_COMPLIANCE_LIMITS_NG },
    global: globalSetting
      ? { ...DEFAULT_COMPLIANCE_LIMITS_GLOBAL, ...globalSetting }
      : { ...DEFAULT_COMPLIANCE_LIMITS_GLOBAL },
  };
}

/**
 * Updates compliance thresholds for a specific corridor (Nigeria or Global).
 */
export async function updateComplianceThresholds(
  input: UpdateComplianceThresholdsInput,
  actor: string
): Promise<ComplianceThresholdsResponse> {
  const now = nowIso();

  if (input.corridor === 'nigeria') {
    const existing = (await db.getSystemSetting<CorridorComplianceNgRecord>(SETTING_KEY_NG)) || DEFAULT_COMPLIANCE_LIMITS_NG;
    const updated: CorridorComplianceNgRecord = {
      ...existing,
      corridor: 'nigeria',
      currency: 'NGN',
      singleTxLimitNgn: input.singleTxLimit,
      monthlyCapNgn: input.monthlyCap,
      tier2Enforced: input.tier2Enforced,
      autoPromptEnabled: input.autoPromptEnabled ?? existing.autoPromptEnabled,
      updatedAt: now,
      updatedBy: actor || 'admin',
    };
    await db.setSystemSetting(SETTING_KEY_NG, updated);

    await createAuditLog({
      action: 'admin.compliance_thresholds.updated',
      resourceType: 'system_setting',
      resourceId: SETTING_KEY_NG,
      actorType: 'admin',
      actorId: actor || 'admin',
      metadata: {
        corridor: 'nigeria',
        singleTxLimitNgn: updated.singleTxLimitNgn,
        monthlyCapNgn: updated.monthlyCapNgn,
        tier2Enforced: updated.tier2Enforced,
        autoPromptEnabled: updated.autoPromptEnabled,
      },
    });
  } else {
    const existing = (await db.getSystemSetting<CorridorComplianceGlobalRecord>(SETTING_KEY_GLOBAL)) || DEFAULT_COMPLIANCE_LIMITS_GLOBAL;
    const updated: CorridorComplianceGlobalRecord = {
      ...existing,
      corridor: 'global',
      currency: 'USD',
      singleTxLimitUsd: input.singleTxLimit,
      monthlyCapUsd: input.monthlyCap,
      tier2Enforced: input.tier2Enforced,
      autoPromptEnabled: input.autoPromptEnabled ?? existing.autoPromptEnabled,
      updatedAt: now,
      updatedBy: actor || 'admin',
    };
    await db.setSystemSetting(SETTING_KEY_GLOBAL, updated);

    await createAuditLog({
      action: 'admin.compliance_thresholds.updated',
      resourceType: 'system_setting',
      resourceId: SETTING_KEY_GLOBAL,
      actorType: 'admin',
      actorId: actor || 'admin',
      metadata: {
        corridor: 'global',
        singleTxLimitUsd: updated.singleTxLimitUsd,
        monthlyCapUsd: updated.monthlyCapUsd,
        tier2Enforced: updated.tier2Enforced,
        autoPromptEnabled: updated.autoPromptEnabled,
      },
    });
  }

  return getComplianceThresholds();
}

export interface ComplianceEvaluationParams {
  userId: string;
  amountNgn?: number;
  amountUsd?: number;
  corridor?: 'nigeria' | 'global';
  action?: 'withdrawal' | 'agreement_release' | 'p2p_send';
}

export interface ComplianceEvaluationResult {
  stepUpRequired: boolean;
  enforced: boolean;
  growthMode: boolean;
  corridor: 'nigeria' | 'global';
  reason?: string;
  userTier: number;
  limit?: number;
  currentAmount?: number;
  cumulative30DayAmount?: number;
}

/**
 * Checks whether a user is Tier 2 KYC verified.
 * Tier 2 requires either:
 * 1. An accepted NIN verification ('nin_info' with status 'matched')
 * 2. An approved Step-Up Verification Request
 */
export async function isUserTier2Verified(userId: string): Promise<boolean> {
  try {
    const verifications = await db.listNgnIdentityVerifications(userId);
    const hasNinMatched = verifications.some(
      (v) => v.checkType === 'nin_info' && v.status === 'matched'
    );
    if (hasNinMatched) return true;

    const requests = await db.listVerificationRequests(userId);
    const hasApproved = requests.some((r) => r.status === 'approved');
    if (hasApproved) return true;
  } catch {
    // Non-fatal, assume unverified if error reading
  }
  return false;
}

/**
 * Evaluates whether a pending financial action requires step-up KYC verification.
 */
export async function evaluateComplianceStepUp(
  params: ComplianceEvaluationParams
): Promise<ComplianceEvaluationResult> {
  const { userId, amountNgn, amountUsd, action = 'withdrawal' } = params;

  // Determine corridor
  let corridor = params.corridor;
  if (!corridor) {
    if (amountNgn !== undefined && amountNgn > 0) {
      corridor = 'nigeria';
    } else {
      corridor = 'global';
    }
  }

  const thresholds = await getComplianceThresholds();
  const isNg = corridor === 'nigeria';
  const settings = isNg ? thresholds.nigeria : thresholds.global;
  const isTier2 = await isUserTier2Verified(userId);
  const userTier = isTier2 ? 2 : 1;

  // If Tier 2 is NOT enforced (Growth Mode), never block the user
  if (!settings.tier2Enforced) {
    return {
      stepUpRequired: false,
      enforced: false,
      growthMode: true,
      corridor,
      userTier,
      reason: 'Growth Mode active - processing without step-up KYC challenge',
    };
  }

  // If user is already Tier 2, they have passed enhanced KYC
  if (isTier2) {
    return {
      stepUpRequired: false,
      enforced: true,
      growthMode: false,
      corridor,
      userTier: 2,
      reason: 'User is Tier 2 verified',
    };
  }

  // Evaluate Single Transaction Limit
  if (isNg) {
    const txAmount = amountNgn || 0;
    if (txAmount > thresholds.nigeria.singleTxLimitNgn) {
      return {
        stepUpRequired: true,
        enforced: true,
        growthMode: false,
        corridor: 'nigeria',
        userTier: 1,
        limit: thresholds.nigeria.singleTxLimitNgn,
        currentAmount: txAmount,
        reason: `Single transaction (₦${txAmount.toLocaleString()} NGN) exceeds Tier 1 limit of ₦${thresholds.nigeria.singleTxLimitNgn.toLocaleString()} NGN`,
      };
    }
  } else {
    const txAmount = amountUsd || 0;
    if (txAmount > thresholds.global.singleTxLimitUsd) {
      return {
        stepUpRequired: true,
        enforced: true,
        growthMode: false,
        corridor: 'global',
        userTier: 1,
        limit: thresholds.global.singleTxLimitUsd,
        currentAmount: txAmount,
        reason: `Single transaction ($${txAmount.toLocaleString()} USD) exceeds Tier 1 limit of $${thresholds.global.singleTxLimitUsd.toLocaleString()} USD`,
      };
    }
  }

  // Evaluate Rolling 30-Day Cumulative Volume
  const thirtyDaysAgoIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  let past30DayVolume = 0;

  try {
    if (isNg) {
      const pastTransfers = await db.listNgnTransfersByUserSince(userId, thirtyDaysAgoIso);
      past30DayVolume = pastTransfers.reduce((acc, t) => acc + Number(t.sourceAmount || 0), 0);
      const totalVolumeWithThisTx = past30DayVolume + (amountNgn || 0);

      if (totalVolumeWithThisTx > thresholds.nigeria.monthlyCapNgn) {
        return {
          stepUpRequired: true,
          enforced: true,
          growthMode: false,
          corridor: 'nigeria',
          userTier: 1,
          limit: thresholds.nigeria.monthlyCapNgn,
          currentAmount: amountNgn || 0,
          cumulative30DayAmount: totalVolumeWithThisTx,
          reason: `Rolling 30-day cumulative volume (₦${totalVolumeWithThisTx.toLocaleString()} NGN) exceeds monthly cap of ₦${thresholds.nigeria.monthlyCapNgn.toLocaleString()} NGN`,
        };
      }
    } else {
      const pastWithdrawals = await db.listWithdrawalsByUserSince(userId, thirtyDaysAgoIso);
      past30DayVolume = pastWithdrawals.reduce((acc, w) => acc + Number(w.sourceAmount || 0), 0);
      const totalVolumeWithThisTx = past30DayVolume + (amountUsd || 0);

      if (totalVolumeWithThisTx > thresholds.global.monthlyCapUsd) {
        return {
          stepUpRequired: true,
          enforced: true,
          growthMode: false,
          corridor: 'global',
          userTier: 1,
          limit: thresholds.global.monthlyCapUsd,
          currentAmount: amountUsd || 0,
          cumulative30DayAmount: totalVolumeWithThisTx,
          reason: `Rolling 30-day cumulative volume ($${totalVolumeWithThisTx.toLocaleString()} USD) exceeds monthly cap of $${thresholds.global.monthlyCapUsd.toLocaleString()} USD`,
        };
      }
    }
  } catch (err: any) {
    console.warn('[evaluateComplianceStepUp] Error computing 30-day volume:', err?.message || err);
  }

  return {
    stepUpRequired: false,
    enforced: true,
    growthMode: false,
    corridor,
    userTier: 1,
    reason: 'Transaction is within standard Tier 1 volume thresholds',
  };
}

/**
 * Retrieves the full compliance profile and current tier status for a user.
 */
export async function getUserComplianceProfile(userId: string): Promise<{
  userId: string;
  tier: number;
  isTier2Verified: boolean;
  nigeriaLimits: CorridorComplianceNgRecord;
  globalLimits: CorridorComplianceGlobalRecord;
  past30DayVolumeNgn: number;
  past30DayVolumeUsd: number;
}> {
  const isTier2 = await isUserTier2Verified(userId);
  const thresholds = await getComplianceThresholds();
  const thirtyDaysAgoIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  let past30DayVolumeNgn = 0;
  let past30DayVolumeUsd = 0;

  try {
    const ngTransfers = await db.listNgnTransfersByUserSince(userId, thirtyDaysAgoIso);
    past30DayVolumeNgn = ngTransfers.reduce((acc, t) => acc + Number(t.sourceAmount || 0), 0);
  } catch {
    // Non-fatal
  }

  try {
    const withdrawals = await db.listWithdrawalsByUserSince(userId, thirtyDaysAgoIso);
    past30DayVolumeUsd = withdrawals.reduce((acc, w) => acc + Number(w.sourceAmount || 0), 0);
  } catch {
    // Non-fatal
  }

  return {
    userId,
    tier: isTier2 ? 2 : 1,
    isTier2Verified: isTier2,
    nigeriaLimits: thresholds.nigeria,
    globalLimits: thresholds.global,
    past30DayVolumeNgn,
    past30DayVolumeUsd,
  };
}
