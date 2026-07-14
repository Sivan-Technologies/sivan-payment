import { db } from '../database/json-database.js';
import { env } from '../config/env.js';

const DEFAULT_WINDOWS = [7, 14, 30, 60, 90];

type ActivityType = 'signup' | 'kyc_started' | 'bank_account_added' | 'withdrawal_created' | 'withdrawal_completed' | 'webhook_processed';

interface UserActivity {
  id: string;
  userId: string;
  type: ActivityType;
  label: string;
  occurredAt: string;
  metadata?: Record<string, unknown>;
}

function daysAgo(days: number) {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function toTime(value?: string) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function money(value: number) {
  return value.toFixed(2);
}

function ratio(numerator: number, denominator: number) {
  if (denominator <= 0) return '0';
  return ((numerator / denominator) * 100).toFixed(2);
}

function grossWithdrawalAmount(withdrawal: any) {
  const feeAmount = Number(withdrawal.feeAmount ?? 0);
  const destinationAmount = Number(withdrawal.destinationAmount ?? 0);
  const sourceAmount = Number(withdrawal.sourceAmount ?? 0);
  return destinationAmount > 0 || feeAmount > 0 ? destinationAmount + feeAmount : sourceAmount;
}

export async function getAdminAnalytics() {
  const data = await db.read();
  const activities: UserActivity[] = [];

  for (const user of data.users) {
    activities.push({
      id: `act_signup_${user.id}`,
      userId: user.id,
      type: 'signup',
      label: 'User signed up',
      occurredAt: user.createdAt,
      metadata: { email: user.email, fullName: user.fullName }
    });
  }

  for (const customer of data.customers) {
    activities.push({
      id: `act_kyc_${customer.id}`,
      userId: customer.userId,
      type: 'kyc_started',
      label: `${customer.customerType === 'business' ? 'KYB' : 'KYC'} started`,
      occurredAt: customer.createdAt,
      metadata: {
        kycStatus: customer.kycStatus,
        customerType: customer.customerType,
        onboardingCostUsd: customer.onboardingCostUsd
      }
    });
  }

  for (const account of data.externalAccounts) {
    activities.push({
      id: `act_bank_${account.id}`,
      userId: account.userId,
      type: 'bank_account_added',
      label: 'Bank account added',
      occurredAt: account.createdAt,
      metadata: { currency: account.currency, status: account.status, bankName: account.bankName }
    });
  }

  for (const withdrawal of data.withdrawals) {
    activities.push({
      id: `act_withdrawal_${withdrawal.id}`,
      userId: withdrawal.userId,
      type: 'withdrawal_created',
      label: 'Withdrawal created',
      occurredAt: withdrawal.createdAt,
      metadata: {
        status: withdrawal.status,
        destinationCurrency: withdrawal.destinationCurrency,
        destinationAmount: withdrawal.destinationAmount,
        feeAmount: withdrawal.feeAmount
      }
    });

    if (withdrawal.completedAt) {
      activities.push({
        id: `act_withdrawal_completed_${withdrawal.id}`,
        userId: withdrawal.userId,
        type: 'withdrawal_completed',
        label: 'Withdrawal completed',
        occurredAt: withdrawal.completedAt,
        metadata: {
          destinationCurrency: withdrawal.destinationCurrency,
          destinationAmount: withdrawal.destinationAmount,
          feeAmount: withdrawal.feeAmount
        }
      });
    }
  }

  for (const event of data.webhookEvents) {
    const withdrawal = data.withdrawals.find((item) => item.providerDrainId && item.providerDrainId === event.eventObjectId);
    if (!withdrawal?.userId) continue;
    activities.push({
      id: `act_webhook_${event.id}`,
      userId: withdrawal.userId,
      type: 'webhook_processed',
      label: 'Webhook processed',
      occurredAt: event.processedAt ?? event.createdAt,
      metadata: { provider: event.provider, eventCategory: event.eventCategory, eventType: event.eventType }
    });
  }

  const activitiesByUser = new Map<string, UserActivity[]>();
  for (const activity of activities) {
    const list = activitiesByUser.get(activity.userId) ?? [];
    list.push(activity);
    activitiesByUser.set(activity.userId, list);
  }

  for (const list of activitiesByUser.values()) {
    list.sort((a, b) => toTime(a.occurredAt) - toTime(b.occurredAt));
  }

  const users = data.users.map((user) => {
    const userActivities = activitiesByUser.get(user.id) ?? [];
    const firstActivityAt = userActivities[0]?.occurredAt ?? user.createdAt;
    const lastActivityAt = userActivities[userActivities.length - 1]?.occurredAt ?? user.createdAt;
    const withdrawalCount = data.withdrawals.filter((withdrawal) => withdrawal.userId === user.id).length;
    const completedWithdrawalCount = data.withdrawals.filter((withdrawal) => withdrawal.userId === user.id && withdrawal.status === 'completed').length;
    return {
      ...user,
      firstActivityAt,
      lastActivityAt,
      activityCount: userActivities.length,
      withdrawalCount,
      completedWithdrawalCount,
      kycStatus: data.customers.find((customer) => customer.userId === user.id)?.kycStatus ?? 'not_started'
    };
  });

  const windows = DEFAULT_WINDOWS.map((days) => {
    const cutoff = daysAgo(days);
    const previousCutoff = daysAgo(days * 2);

    const activeUserIds = unique(
      activities
        .filter((activity) => toTime(activity.occurredAt) >= cutoff)
        .map((activity) => activity.userId)
    );

    const returningUserIds = activeUserIds.filter((userId) => {
      const userActivities = activitiesByUser.get(userId) ?? [];
      return userActivities.some((activity) => toTime(activity.occurredAt) < cutoff);
    });

    const newUserIds = activeUserIds.filter((userId) => {
      const userActivities = activitiesByUser.get(userId) ?? [];
      return !userActivities.some((activity) => toTime(activity.occurredAt) < cutoff);
    });

    const churningUserIds = users
      .filter((user) => {
        const lastActivity = toTime(user.lastActivityAt);
        return lastActivity < cutoff && lastActivity >= previousCutoff;
      })
      .map((user) => user.id);

    const dormantUserIds = users.filter((user) => toTime(user.lastActivityAt) < cutoff).map((user) => user.id);

    return {
      days,
      activeUsers: activeUserIds.length,
      returningUsers: returningUserIds.length,
      newUsers: newUserIds.length,
      churningUsers: churningUserIds.length,
      dormantUsers: dormantUserIds.length,
      activeUserIds,
      returningUserIds,
      newUserIds,
      churningUserIds,
      dormantUserIds
    };
  });

  const activityCounts = activities.reduce<Record<string, number>>((acc, activity) => {
    acc[activity.type] = (acc[activity.type] ?? 0) + 1;
    return acc;
  }, {});

  const recentActivities = activities
    .slice()
    .sort((a, b) => toTime(b.occurredAt) - toTime(a.occurredAt))
    .slice(0, 100)
    .map((activity) => ({
      ...activity,
      user: data.users.find((user) => user.id === activity.userId) ?? null
    }));


  const completedWithdrawals = data.withdrawals.filter((withdrawal) => withdrawal.status === 'completed');
  const failedWithdrawals = data.withdrawals.filter((withdrawal) => ['failed', 'cancelled'].includes(withdrawal.status));
  const usersWithWithdrawals = unique(data.withdrawals.map((withdrawal) => withdrawal.userId));
  const usersWithRepeatWithdrawals = usersWithWithdrawals.filter((userId) => data.withdrawals.filter((withdrawal) => withdrawal.userId === userId).length >= 2);
  const completedGrossVolume = completedWithdrawals.reduce((sum, withdrawal) => sum + grossWithdrawalAmount(withdrawal), 0);
  const allKnownGrossVolume = data.withdrawals.reduce((sum, withdrawal) => sum + grossWithdrawalAmount(withdrawal), 0);
  const sivanFeeRevenue = completedWithdrawals.reduce((sum, withdrawal) => sum + Number(withdrawal.feeAmount ?? 0), 0);
  const estimatedBridgeVariableCost = completedGrossVolume * (env.BRIDGE_OFFRAMP_COST_PERCENT / 100);
  const onboardingCost = data.customers.reduce((sum, customer) => sum + Number(customer.onboardingCostUsd ?? 0), 0);
  const kycCustomers = data.customers.filter((customer) => customer.onboardingCostType === 'kyc');
  const customerAcquisitionCostTotal = data.users.length * env.CUSTOMER_ACQUISITION_COST_USD;
  const providerCostTotal = estimatedBridgeVariableCost + onboardingCost;
  const netMarginBeforeCac = sivanFeeRevenue - providerCostTotal;
  const netMarginAfterCac = netMarginBeforeCac - customerAcquisitionCostTotal;
  const onboardingRecovered = Math.min(onboardingCost, Math.max(sivanFeeRevenue - estimatedBridgeVariableCost, 0));

  return {
    generatedAt: new Date().toISOString(),
    definitions: {
      activeUsers: 'Users with at least one tracked activity within the window.',
      returningUsers: 'Users active within the window who also had activity before the window.',
      newUsers: 'Users whose first tracked activity happened within the window.',
      churningUsers: 'Users whose last activity is older than the window but not older than twice the window.',
      dormantUsers: 'Users whose last activity is older than the window.'
    },
    totals: {
      users: data.users.length,
      activities: activities.length,
      activityCounts
    },
    profitability: {
      averageLifetimeVolumePerUserUsd: money(completedGrossVolume / Math.max(data.users.length, 1)),
      averageLifetimeVolumePerTransactingUserUsd: money(completedGrossVolume / Math.max(usersWithWithdrawals.length, 1)),
      kycCostRecoveryPerKycUserUsd: money(onboardingRecovered / Math.max(kycCustomers.length, 1)),
      withdrawalVolumePerUserUsd: money(allKnownGrossVolume / Math.max(data.users.length, 1)),
      withdrawalVolumePerTransactingUserUsd: money(allKnownGrossVolume / Math.max(usersWithWithdrawals.length, 1)),
      repeatWithdrawalRatePercent: ratio(usersWithRepeatWithdrawals.length, usersWithWithdrawals.length),
      averageWithdrawalSizeUsd: money(completedGrossVolume / Math.max(completedWithdrawals.length, 1)),
      failedWithdrawalRatePercent: ratio(failedWithdrawals.length, data.withdrawals.length),
      providerCostUsd: money(providerCostTotal),
      bridgeVariableCostUsd: money(estimatedBridgeVariableCost),
      onboardingCostUsd: money(onboardingCost),
      sivanFeeRevenueUsd: money(sivanFeeRevenue),
      netMarginBeforeCacUsd: money(netMarginBeforeCac),
      customerAcquisitionCostPerUserUsd: money(env.CUSTOMER_ACQUISITION_COST_USD),
      customerAcquisitionCostTotalUsd: money(customerAcquisitionCostTotal),
      netMarginAfterCacUsd: money(netMarginAfterCac),
      transactingUsers: usersWithWithdrawals.length,
      repeatUsers: usersWithRepeatWithdrawals.length,
      completedWithdrawalCount: completedWithdrawals.length,
      failedWithdrawalCount: failedWithdrawals.length
    },
    windows,
    users,
    recentActivities
  };
}
