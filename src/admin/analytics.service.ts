import { db } from '../database/json-database.js';

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
    windows,
    users,
    recentActivities
  };
}
