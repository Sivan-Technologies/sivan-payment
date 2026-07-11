import { env } from '../config/env.js';
import { db } from '../database/json-database.js';

function money(value: number): string {
  return value.toFixed(2);
}

function percent(value: number): string {
  return Number(value.toFixed(6)).toString();
}

export async function getOnboardingCostSummary() {
  const data = await db.read();

  const customersWithTrackedCost = data.customers.filter((customer) => customer.onboardingCostUsd);
  const kycCustomers = customersWithTrackedCost.filter((customer) => customer.onboardingCostType === 'kyc');
  const kybCustomers = customersWithTrackedCost.filter((customer) => customer.onboardingCostType === 'kyb');

  const kycCostTotal = kycCustomers.reduce((sum, customer) => sum + Number(customer.onboardingCostUsd ?? 0), 0);
  const kybCostTotal = kybCustomers.reduce((sum, customer) => sum + Number(customer.onboardingCostUsd ?? 0), 0);
  const totalOnboardingCost = kycCostTotal + kybCostTotal;

  const potentialKycCostIfEverySignupVerifies = data.users.length * env.BRIDGE_KYC_COST_USD;
  const signedUpButNotKycStarted = Math.max(data.users.length - data.customers.length, 0);
  const potentialUnstartedKycExposure = signedUpButNotKycStarted * env.BRIDGE_KYC_COST_USD;

  const customersByKycStatus = data.customers.reduce<Record<string, number>>((acc, customer) => {
    acc[customer.kycStatus] = (acc[customer.kycStatus] ?? 0) + 1;
    return acc;
  }, {});

  const completedWithdrawals = data.withdrawals.filter((withdrawal) => withdrawal.status === 'completed');
  const completedGrossVolume = completedWithdrawals.reduce((sum, withdrawal) => {
    const feeAmount = Number(withdrawal.feeAmount ?? 0);
    const destinationAmount = Number(withdrawal.destinationAmount ?? 0);
    const sourceAmount = Number(withdrawal.sourceAmount ?? 0);

    // For liquidation-address drains, Bridge webhook usually gives destination/net amount and developer fee.
    // If both exist, gross volume is net + fee. Fallback to source amount if available.
    const gross = destinationAmount > 0 || feeAmount > 0 ? destinationAmount + feeAmount : sourceAmount;
    return sum + gross;
  }, 0);

  const sivanDeveloperFeeRevenue = completedWithdrawals.reduce((sum, withdrawal) => sum + Number(withdrawal.feeAmount ?? 0), 0);
  const estimatedBridgeOfframpCost = completedGrossVolume * (env.BRIDGE_OFFRAMP_COST_PERCENT / 100);
  const contributionBeforeOnboarding = sivanDeveloperFeeRevenue - estimatedBridgeOfframpCost;
  const onboardingCostRecovered = Math.min(totalOnboardingCost, Math.max(contributionBeforeOnboarding, 0));
  const unrecoveredOnboardingCost = Math.max(totalOnboardingCost - onboardingCostRecovered, 0);
  const netAfterOnboarding = contributionBeforeOnboarding - totalOnboardingCost;

  return {
    users: {
      totalSignedUp: data.users.length,
      withBridgeCustomer: data.customers.length,
      withoutBridgeCustomer: signedUpButNotKycStarted
    },
    signupExposure: {
      bridgeKycCostUsd: money(env.BRIDGE_KYC_COST_USD),
      potentialKycCostIfEverySignupVerifiesUsd: money(potentialKycCostIfEverySignupVerifies),
      potentialUnstartedKycExposureUsd: money(potentialUnstartedKycExposure),
      note: 'This is potential exposure only. It becomes an actual tracked cost when Bridge KYC/customer creation starts.'
    },
    onboardingCosts: {
      trackedCustomers: customersWithTrackedCost.length,
      kycCount: kycCustomers.length,
      kybCount: kybCustomers.length,
      kycCostTotalUsd: money(kycCostTotal),
      kybCostTotalUsd: money(kybCostTotal),
      totalOnboardingCostUsd: money(totalOnboardingCost)
    },
    recovery: {
      sivanOfframpFeePercent: percent(env.SIVAN_OFFRAMP_FEE_PERCENT),
      bridgeOfframpCostPercent: percent(env.BRIDGE_OFFRAMP_COST_PERCENT),
      completedWithdrawalCount: completedWithdrawals.length,
      completedGrossVolumeUsdEstimate: money(completedGrossVolume),
      sivanDeveloperFeeRevenueUsd: money(sivanDeveloperFeeRevenue),
      estimatedBridgeOfframpCostUsd: money(estimatedBridgeOfframpCost),
      contributionBeforeOnboardingUsd: money(contributionBeforeOnboarding),
      onboardingCostRecoveredUsd: money(onboardingCostRecovered),
      unrecoveredOnboardingCostUsd: money(unrecoveredOnboardingCost),
      netAfterOnboardingUsd: money(netAfterOnboarding),
      note: 'Recovery is estimated from completed withdrawal feeAmount values. Actual Bridge developer-fee settlement and invoices should be reconciled monthly.'
    },
    kycStatuses: customersByKycStatus,
    note: 'KYC/KYB cost is tracked once when a Bridge customer/KYC link is created, not when a user merely signs up. Signup exposure is shown separately so Sivan can forecast cost if all signups complete KYC.'
  };
}
