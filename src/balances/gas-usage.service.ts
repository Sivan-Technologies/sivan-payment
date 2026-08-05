import { db } from '../database/json-database.js';
import { getAdminFeeSettings } from '../admin/admin-fees.service.js';
import {
  DEFAULT_GAS_CONTROLS,
  checkGasLimits,
  sponsoredCostUsd,
  tierForAge,
  type GasControls,
  type GasLimitDecision,
} from './gas-policy.js';

/**
 * WHAT SIVAN HAS SPONSORED, AND FOR WHOM.
 *
 * Answers the three questions the limits need: how many transfers has this
 * user made today, how many NEW recipients have they funded, and what has the
 * platform spent in total.
 *
 * Computed from the audit log rather than a counter. A counter would be faster
 * and would drift: it has to be incremented in exactly the right place, it
 * cannot be rebuilt after an incident, and the first time it disagrees with
 * reality nobody can tell which is right. The log already records every
 * transfer with its network and whether it created a recipient account.
 *
 * PERFORMANCE, stated honestly. This reads the transfer log on every transfer
 * request, which is fine at launch volume and will not be at 10k users. The
 * fix then is a materialised daily counter reconciled against this, not a
 * counter that replaces it. Flagged rather than pre-optimised.
 */

const WINDOW_HOURS = 24;

interface TransferLike {
  userId: string;
  network: string;
  destinationAddress: string;
  createdAt: string;
  createsRecipientAccount?: boolean;
  status?: string;
}

/** Every transfer in the rolling window, across all users. */
async function recentTransfers(): Promise<TransferLike[]> {
  const data = await db.read();
  const cutoff = Date.now() - WINDOW_HOURS * 3600_000;

  const seen = new Map<string, TransferLike>();
  for (const log of data.auditLogs ?? []) {
    if (log.action !== 'balance.transfer_requested') continue;
    const transfer = log.metadata as any;
    if (!transfer?.transferId) continue;
    const at = Date.parse(transfer.createdAt ?? log.createdAt);
    if (!Number.isFinite(at) || at < cutoff) continue;
    /**
     * Keyed by transferId so a retried or re-logged request counts once. A
     * user who hits a gateway timeout and retries has made ONE transfer
     * attempt from the network's point of view, and counting it twice would
     * penalise them for our own 12-second ceiling.
     */
    seen.set(transfer.transferId, {
      userId: transfer.userId,
      network: transfer.network,
      destinationAddress: transfer.destinationAddress,
      createdAt: transfer.createdAt ?? log.createdAt,
      createsRecipientAccount: Boolean(transfer.createsRecipientAccount),
      status: transfer.status,
    });
  }
  return [...seen.values()];
}

export interface GasUsageSnapshot {
  /** Rolling-24h sponsored spend across the platform, USD. */
  spendTodayUsd: number;
  /** Solana transfers in the window. */
  transfers24h: number;
  /** How many of those created a recipient account - the expensive kind. */
  newAccounts24h: number;
  budgetUsd: number;
  /** 0-1. Above 1 means the breaker has tripped. */
  budgetUsed: number;
  breakerTripped: boolean;
  warnOnly: boolean;
}

export async function getGasControls(): Promise<GasControls> {
  const fees = await getAdminFeeSettings().catch(() => undefined) as any;
  return {
    limitsEnabled: fees?.gasLimitsEnabled ?? DEFAULT_GAS_CONTROLS.limitsEnabled,
    warnOnly: fees?.gasLimitsWarnOnly ?? DEFAULT_GAS_CONTROLS.warnOnly,
    tiers: DEFAULT_GAS_CONTROLS.tiers,
    dailyBudgetUsd: fees?.gasDailyBudgetUsd ?? DEFAULT_GAS_CONTROLS.dailyBudgetUsd,
    solPriceUsd: fees?.gasSolPriceUsd ?? DEFAULT_GAS_CONTROLS.solPriceUsd,
  };
}

/** Platform-wide sponsored spend and breaker state. */
export async function getGasUsage(): Promise<GasUsageSnapshot> {
  const controls = await getGasControls();
  const transfers = (await recentTransfers()).filter((t) => String(t.network).toLowerCase() === 'solana');

  const spendTodayUsd = transfers.reduce(
    (sum, t) => sum + sponsoredCostUsd({
      network: t.network,
      createsRecipientAccount: t.createsRecipientAccount,
      solPriceUsd: controls.solPriceUsd,
    }),
    0
  );

  const newAccounts24h = transfers.filter((t) => t.createsRecipientAccount).length;
  const budgetUsd = controls.dailyBudgetUsd;

  return {
    spendTodayUsd: Math.round(spendTodayUsd * 1e6) / 1e6,
    transfers24h: transfers.length,
    newAccounts24h,
    budgetUsd,
    budgetUsed: budgetUsd > 0 ? spendTodayUsd / budgetUsd : 0,
    breakerTripped: budgetUsd > 0 && spendTodayUsd >= budgetUsd,
    warnOnly: controls.warnOnly,
  };
}

export interface UserGasUsage {
  transfersToday: number;
  newRecipientsToday: number;
  accountAgeHours: number;
  tier: string;
  /** Hours until the oldest counted transfer falls out of the window. */
  resetInHours: number;
}

export async function getUserGasUsage(userId: string): Promise<UserGasUsage> {
  const controls = await getGasControls();
  const data = await db.read();
  const user = (data.users ?? []).find((item: any) => item.id === userId);

  const createdAt = Date.parse(String((user as any)?.createdAt ?? ''));
  const accountAgeHours = Number.isFinite(createdAt)
    ? Math.max(0, (Date.now() - createdAt) / 3600_000)
    // Unknown age is treated as BRAND NEW, not established. An account we
    // cannot date is the one most likely to be anomalous, and defaulting it to
    // the loosest tier would make the tiers optional.
    : 0;

  const mine = (await recentTransfers()).filter((t) => t.userId === userId);

  /**
   * DISTINCT addresses, not transfer count.
   *
   * Two sends to the same new address in one day create ONE account and cost
   * one rent. Counting them as two would refuse a user for a cost they did not
   * cause - and the second send genuinely is free, because by then the account
   * exists.
   */
  const newRecipients = new Set(
    mine.filter((t) => t.createsRecipientAccount).map((t) => t.destinationAddress)
  );

  const oldest = mine.reduce<number | undefined>((min, t) => {
    const at = Date.parse(t.createdAt);
    return Number.isFinite(at) && (min === undefined || at < min) ? at : min;
  }, undefined);
  const resetInHours = oldest === undefined
    ? 0
    : Math.max(0, WINDOW_HOURS - (Date.now() - oldest) / 3600_000);

  return {
    transfersToday: mine.length,
    newRecipientsToday: newRecipients.size,
    accountAgeHours,
    tier: tierForAge(accountAgeHours, controls.tiers).label,
    resetInHours,
  };
}

/**
 * The gate the transfer path calls.
 *
 * Never throws: a failure to READ usage must not block a transfer. Being
 * unable to count is not evidence of abuse, and refusing on a database hiccup
 * would turn a monitoring problem into an outage.
 */
export async function evaluateGasLimits(input: {
  userId: string;
  createsRecipientAccount: boolean;
}): Promise<GasLimitDecision> {
  try {
    const [controls, usage, platform] = await Promise.all([
      getGasControls(),
      getUserGasUsage(input.userId),
      getGasUsage(),
    ]);

    return checkGasLimits({
      accountAgeHours: usage.accountAgeHours,
      transfersToday: usage.transfersToday,
      newRecipientsToday: usage.newRecipientsToday,
      createsRecipientAccount: input.createsRecipientAccount,
      spendTodayUsd: platform.spendTodayUsd,
      resetInHours: usage.resetInHours,
      controls,
    });
  } catch {
    return { allowed: true, wouldRefuse: false, rule: 'none', tier: 'unknown' };
  }
}
