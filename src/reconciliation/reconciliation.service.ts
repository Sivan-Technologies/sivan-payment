import { db } from '../database/json-database.js';
import type { WithdrawalRecord, WithdrawalStatus } from '../database/types.js';
import { getOfframpProvider } from '../providers/provider-registry.js';
import { mapBridgeDrainState } from '../offramp/service/withdrawal-mapping.js';
import { nowIso } from '../shared/id.js';

export interface ReconciliationRunInput {
  dryRun?: boolean;
  provider?: string;
  userId?: string;
  liquidationAddressId?: string;
}

export interface ReconciliationFinding {
  type: 'matched_drain' | 'unmatched_drain' | 'provider_error' | 'would_update_withdrawal' | 'updated_withdrawal';
  severity: 'info' | 'warning' | 'error';
  message: string;
  withdrawalId?: string;
  liquidationAddressId?: string;
  providerDrainId?: string;
  previousStatus?: WithdrawalStatus;
  nextStatus?: WithdrawalStatus;
  raw?: unknown;
}

export async function runOfframpReconciliation(input: ReconciliationRunInput = {}) {
  const dryRun = input.dryRun ?? true;
  const startedAt = nowIso();
  const findings: ReconciliationFinding[] = [];
  let checkedLiquidationAddresses = 0;
  let checkedDrains = 0;
  let updatedWithdrawals = 0;
  let unmatchedDrains = 0;
  let providerErrors = 0;

  const snapshot = await db.read();
  const liquidationAddresses = snapshot.liquidationAddresses.filter((address) => {
    if (input.provider && address.provider !== input.provider) return false;
    if (input.userId && address.userId !== input.userId) return false;
    if (input.liquidationAddressId && address.id !== input.liquidationAddressId) return false;
    return true;
  });

  for (const liquidationAddress of liquidationAddresses) {
    checkedLiquidationAddresses += 1;
    const customer = snapshot.customers.find((item) => item.id === liquidationAddress.customerId);
    if (!customer) {
      providerErrors += 1;
      findings.push({
        type: 'provider_error',
        severity: 'error',
        message: `Missing customer for liquidation address ${liquidationAddress.id}`,
        liquidationAddressId: liquidationAddress.id
      });
      continue;
    }

    try {
      const provider = getOfframpProvider(liquidationAddress.provider);
      const drains = await provider.getLiquidationAddressDrains(
        customer.providerCustomerId,
        liquidationAddress.providerLiquidationAddressId
      );

      for (const rawDrain of drains as any[]) {
        checkedDrains += 1;
        const drain = rawDrain ?? {};
        const providerDrainId = drain.id;
        const nextStatus = mapBridgeDrainState(drain.state);
        const withdrawal = findWithdrawalForDrain(snapshot.withdrawals, liquidationAddress.id, providerDrainId);

        if (!withdrawal) {
          unmatchedDrains += 1;
          findings.push({
            type: 'unmatched_drain',
            severity: 'warning',
            message: `Provider drain ${providerDrainId ?? 'unknown'} has no matching local withdrawal`,
            liquidationAddressId: liquidationAddress.id,
            providerDrainId,
            nextStatus,
            raw: drain
          });
          continue;
        }

        findings.push({
          type: 'matched_drain',
          severity: 'info',
          message: `Provider drain ${providerDrainId ?? 'unknown'} matched withdrawal ${withdrawal.id}`,
          withdrawalId: withdrawal.id,
          liquidationAddressId: liquidationAddress.id,
          providerDrainId,
          previousStatus: withdrawal.status,
          nextStatus,
          raw: drain
        });

        const needsUpdate = shouldUpdateWithdrawal(withdrawal, drain, nextStatus);
        if (!needsUpdate) continue;

        findings.push({
          type: dryRun ? 'would_update_withdrawal' : 'updated_withdrawal',
          severity: 'info',
          message: `${dryRun ? 'Would update' : 'Updated'} withdrawal ${withdrawal.id} from ${withdrawal.status} to ${nextStatus}`,
          withdrawalId: withdrawal.id,
          liquidationAddressId: liquidationAddress.id,
          providerDrainId,
          previousStatus: withdrawal.status,
          nextStatus
        });

        if (!dryRun) {
          await applyDrainToWithdrawal(withdrawal.id, drain, nextStatus);
          updatedWithdrawals += 1;
        }
      }
    } catch (error) {
      providerErrors += 1;
      findings.push({
        type: 'provider_error',
        severity: 'error',
        message: error instanceof Error ? error.message : String(error),
        liquidationAddressId: liquidationAddress.id
      });
    }
  }

  return {
    dryRun,
    startedAt,
    completedAt: nowIso(),
    summary: {
      checkedLiquidationAddresses,
      checkedDrains,
      matchedDrains: findings.filter((finding) => finding.type === 'matched_drain').length,
      unmatchedDrains,
      updatedWithdrawals,
      providerErrors,
      findingCount: findings.length
    },
    findings
  };
}

function findWithdrawalForDrain(withdrawals: WithdrawalRecord[], liquidationAddressId: string, providerDrainId?: string) {
  if (providerDrainId) {
    const byDrainId = withdrawals.find((withdrawal) => withdrawal.providerDrainId === providerDrainId);
    if (byDrainId) return byDrainId;
  }

  return withdrawals
    .filter((withdrawal) => withdrawal.liquidationAddressId === liquidationAddressId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function shouldUpdateWithdrawal(withdrawal: WithdrawalRecord, drain: any, nextStatus: WithdrawalStatus) {
  return (
    withdrawal.status !== nextStatus ||
    withdrawal.providerDrainId !== drain.id ||
    withdrawal.destinationAmount !== drain.amount ||
    withdrawal.depositTxHash !== drain.deposit_tx_hash ||
    withdrawal.destinationTxHash !== drain.destination_tx_hash
  );
}

async function applyDrainToWithdrawal(withdrawalId: string, drain: any, nextStatus: WithdrawalStatus) {
  return db.mutate((mutable) => {
    const withdrawal = mutable.withdrawals.find((item) => item.id === withdrawalId);
    if (!withdrawal) return null;
    withdrawal.providerDrainId = drain.id ?? withdrawal.providerDrainId;
    withdrawal.destinationAmount = drain.amount ?? withdrawal.destinationAmount;
    withdrawal.destinationCurrency = drain.currency ?? withdrawal.destinationCurrency;
    withdrawal.feeAmount = drain.developer_fee ?? drain.receipt?.developer_fee ?? withdrawal.feeAmount;
    withdrawal.depositTxHash = drain.deposit_tx_hash ?? withdrawal.depositTxHash;
    withdrawal.destinationTxHash = drain.destination_tx_hash ?? withdrawal.destinationTxHash;
    withdrawal.status = nextStatus;
    withdrawal.statusReason = drain.state ?? withdrawal.statusReason;
    withdrawal.raw = drain;
    withdrawal.updatedAt = nowIso();
    if (nextStatus === 'completed' && !withdrawal.completedAt) withdrawal.completedAt = nowIso();
    return withdrawal;
  });
}
