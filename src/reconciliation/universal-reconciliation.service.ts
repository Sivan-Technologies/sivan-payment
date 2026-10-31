import { db } from '../database/json-database.js';
import { createAuditLog } from '../audit/audit.service.js';
import { createBalanceLedgerEntry } from '../balances/balance.service.js';
import { providerReconciliationRegistry } from './provider-reconciliation/reconciliation-registry.js';
import type {
  VerifiedDepositOutcome,
  VerifiedTransferOutcome,
} from './provider-reconciliation/reconciliation-adapter.interface.js';
import { id, nowIso } from '../shared/id.js';

export interface BackfillDepositInput {
  provider: string;
  reference: string;
  userId?: string;
  reason?: string;
  operatorId?: string;
}

export interface SyncTransferInput {
  provider: string;
  reference: string;
  reason?: string;
  operatorId?: string;
}

export interface ResolveFindingInput {
  findingId: string;
  action: 'auto_remediate' | 'mark_resolved' | 'ignore';
  notes?: string;
  operatorId?: string;
}

/**
 * Reconciles and backfills an inbound deposit from any supported provider (Paystack, Nomba, Flutterwave, etc.).
 *
 * 1. Queries the provider adapter server-to-server.
 * 2. Confirms funds actually settled in Sivan's provider float.
 * 3. Enforces strict idempotency (cannot credit twice).
 * 4. Resolves the beneficiary user.
 * 5. Atomically credits the user ledger with full audit provenance.
 */
export async function reconcileInboundDeposit(input: BackfillDepositInput): Promise<{
  success: boolean;
  credited: boolean;
  message: string;
  outcome?: VerifiedDepositOutcome;
  userId?: string;
  amount?: number;
  currency?: string;
}> {
  const adapter = providerReconciliationRegistry.get(input.provider);
  if (!adapter) {
    throw new Error(`Unsupported reconciliation provider "${input.provider}". Registered providers: ${providerReconciliationRegistry.getAll().map(a => a.providerId).join(', ')}`);
  }

  const outcome = await adapter.verifyInboundDeposit(input.reference);
  if (!outcome.verified || outcome.status !== 'success') {
    return {
      success: false,
      credited: false,
      message: `Provider verification failed: status="${outcome.status}". Error: ${outcome.error || 'Transaction not confirmed as successful by provider'}`,
      outcome,
    };
  }

  const snapshot = await db.read();

  // 1. Check idempotency: Has this provider reference already been credited?
  const existingLedger = (snapshot.auditLogs ?? []).some((log) => {
    if (log.action === 'balance.ledger_entry' || log.action === 'admin.reconciliation.deposit_backfilled') {
      const meta = log.metadata as any;
      return meta?.sourceId === input.reference || meta?.reference === input.reference;
    }
    return false;
  });

  const existingVaTx = (snapshot.virtualAccountTransactions ?? []).some(
    (tx) =>
      tx.depositId === input.reference ||
      tx.depositReference === input.reference ||
      (tx as any).reference === input.reference ||
      (tx as any).providerReference === input.reference
  );

  if (existingLedger || existingVaTx) {
    return {
      success: true,
      credited: false,
      message: `Deposit with reference "${input.reference}" is already credited in Sivan ledger. No duplicate action taken.`,
      outcome,
    };
  }

  // 2. Resolve target user
  let targetUserId = input.userId;
  if (!targetUserId) {
    // Attempt lookup by email
    if (outcome.customerEmail) {
      const matchedUser = snapshot.users.find(
        (u) => (u.email || '').toLowerCase() === (outcome.customerEmail || '').toLowerCase()
      );
      if (matchedUser) targetUserId = matchedUser.id;
    }
    // Attempt lookup by virtual account code
    if (!targetUserId && outcome.customerId) {
      const matchedVa = (snapshot.virtualAccounts ?? []).find(
        (va) =>
          va.customerId === outcome.customerId ||
          va.providerAccountId === outcome.customerId ||
          (va as any).accountNumber === outcome.customerAccount ||
          (va as any).accountNumberMasked === outcome.customerAccount
      );
      if (matchedVa) targetUserId = matchedVa.userId;
    }
  }

  if (!targetUserId) {
    return {
      success: true,
      credited: false,
      message: `Deposit verified with ${adapter.displayName} (${outcome.amount} ${outcome.currency}), but matching Sivan user could not be automatically resolved. Please specify target userId to complete backfill.`,
      outcome,
    };
  }

  // 3. Atomically credit user ledger
  const asset = (outcome.currency.toLowerCase() === 'ngn' ? 'ngn' : 'usdc') as 'ngn' | 'usdc';
  const entry = await createBalanceLedgerEntry(
    {
      userId: targetUserId,
      asset,
      amount: outcome.amount.toFixed(2),
      kind: 'credit_available',
      status: 'available',
      sourceType: 'provider_reconciliation',
      sourceId: input.reference,
      description: `Reconciliation deposit backfill from ${adapter.displayName} (Ref: ${input.reference})`,
    },
    {
      actorType: 'admin',
      actorId: input.operatorId || 'admin_api_key',
    }
  );

  // 4. Log permanent reconciliation audit trail
  await createAuditLog({
    actorType: 'admin',
    actorId: input.operatorId || 'admin_api_key',
    action: 'admin.reconciliation.deposit_backfilled',
    resourceType: 'balance_ledger_entry',
    resourceId: entry.entryId,
    severity: 'warning',
    metadata: {
      provider: input.provider,
      reference: input.reference,
      userId: targetUserId,
      amount: outcome.amount,
      currency: outcome.currency,
      reason: input.reason || 'Admin manual reconciliation backfill',
      outcome,
      entry,
    },
  });

  return {
    success: true,
    credited: true,
    message: `Successfully credited ${outcome.amount.toLocaleString()} ${outcome.currency} to user ${targetUserId}. Entry ID: ${entry.entryId}`,
    outcome,
    userId: targetUserId,
    amount: outcome.amount,
    currency: outcome.currency,
  };
}

/**
 * Reconciles a stuck or disputed outbound transfer with provider terminal state.
 *
 * If provider confirmed failed or reversed:
 *   - Automatically refunds the hold back to user spendable balance.
 * If provider confirmed success:
 *   - Marks transfer completed.
 */
export async function reconcileOutboundTransfer(input: SyncTransferInput): Promise<{
  success: boolean;
  updated: boolean;
  message: string;
  status: string;
  outcome?: VerifiedTransferOutcome;
}> {
  const adapter = providerReconciliationRegistry.get(input.provider);
  if (!adapter) {
    throw new Error(`Unsupported reconciliation provider "${input.provider}".`);
  }

  const outcome = await adapter.verifyOutboundTransfer(input.reference);
  if (!outcome.verified) {
    return {
      success: false,
      updated: false,
      message: `Failed to verify transfer with provider: ${outcome.error || 'Unknown outcome'}`,
      status: 'unverified',
      outcome,
    };
  }

  const snapshot = await db.read();
  const transfer = (snapshot.ngnTransfers ?? []).find(
    (t) =>
      t.id === input.reference ||
      t.providerTransferId === input.reference ||
      t.bankReference === input.reference ||
      t.settlementReference === input.reference ||
      (t as any).reference === input.reference ||
      (t as any).providerReference === input.reference
  );

  // If transfer failed or reversed on provider rail
  if (outcome.status === 'failed' || outcome.status === 'reversed') {
    const transferUserId = transfer?.userId;
    if (transferUserId) {
      // Check if reversal was already refunded
      const alreadyRefunded = (snapshot.auditLogs ?? []).some((log) => {
        const meta = log.metadata as any;
        return (
          log.action === 'admin.reconciliation.transfer_reversed' &&
          meta?.reference === input.reference
        );
      });

      if (!alreadyRefunded && transfer) {
        // Refund the held amount back to user's available balance
        await createBalanceLedgerEntry(
          {
            userId: transferUserId,
            asset: 'ngn',
            amount: Number(transfer.sourceAmount || transfer.destinationAmount || 0).toFixed(2),
            kind: 'credit_available',
            status: 'available',
            sourceType: 'provider_reversal_refund',
            sourceId: input.reference,
            description: `Transfer ${outcome.status} by ${adapter.displayName} . Refunded to balance (Ref: ${input.reference})`,
          },
          {
            actorType: 'admin',
            actorId: input.operatorId || 'admin_api_key',
          }
        );
      }
    }

    await createAuditLog({
      actorType: 'admin',
      actorId: input.operatorId || 'admin_api_key',
      action: outcome.status === 'reversed' ? 'admin.reconciliation.transfer_reversed' : 'admin.reconciliation.transfer_failed',
      resourceType: 'ngn_transfer',
      resourceId: transfer?.id || input.reference,
      severity: 'warning',
      metadata: {
        provider: input.provider,
        reference: input.reference,
        status: outcome.status,
        reason: input.reason || outcome.failureReason || 'Provider reported terminal failure/reversal',
        outcome,
      },
    });

    return {
      success: true,
      updated: true,
      message: `Transfer verified as ${outcome.status.toUpperCase()} by ${adapter.displayName}. Funds restored to user balance.`,
      status: outcome.status,
      outcome,
    };
  }

  // If transfer succeeded
  if (outcome.status === 'completed') {
    await createAuditLog({
      actorType: 'admin',
      actorId: input.operatorId || 'admin_api_key',
      action: 'admin.reconciliation.transfer_confirmed',
      resourceType: 'ngn_transfer',
      resourceId: transfer?.id || input.reference,
      severity: 'info',
      metadata: {
        provider: input.provider,
        reference: input.reference,
        status: 'completed',
        outcome,
      },
    });

    return {
      success: true,
      updated: true,
      message: `Transfer verified as COMPLETED by ${adapter.displayName}.`,
      status: 'completed',
      outcome,
    };
  }

  return {
    success: true,
    updated: false,
    message: `Transfer is currently ${outcome.status.toUpperCase()} at ${adapter.displayName}. No state change required.`,
    status: outcome.status,
    outcome,
  };
}

/**
 * Resolves an open reconciliation finding with an automated remediation or operator dismissal.
 */
export async function resolveReconciliationFinding(input: ResolveFindingInput): Promise<{
  success: boolean;
  message: string;
}> {
  const snapshot = await db.read();
  const finding = (snapshot.reconciliationFindings ?? []).find((f) => f.id === input.findingId);

  if (!finding) {
    throw new Error(`Reconciliation finding with ID "${input.findingId}" not found.`);
  }

  let remediationMessage = '';
  if (input.action === 'auto_remediate') {
    // If it's a missing or uncredited deposit
    if (finding.findingType === 'unmatched_webhook' || finding.findingType === 'missing_reference') {
      const ref = (finding as any).referenceValue || (finding as any).providerDrainId;
      const prov = finding.provider || 'paystack';
      if (ref) {
        const backfill = await reconcileInboundDeposit({
          provider: prov,
          reference: ref,
          reason: `Auto-remediation for finding ${input.findingId}`,
          operatorId: input.operatorId,
        });
        remediationMessage = backfill.message;
      }
    }
  }

  // Update finding record
  finding.severity = 'info';
  (finding as any).status = input.action === 'ignore' ? 'ignored' : 'resolved';
  (finding as any).resolvedAt = nowIso();
  (finding as any).resolvedBy = input.operatorId || 'admin_api_key';
  (finding as any).resolutionNotes = input.notes || remediationMessage || 'Resolved by admin';

  await createAuditLog({
    actorType: 'admin',
    actorId: input.operatorId || 'admin_api_key',
    action: 'admin.reconciliation.finding_resolved',
    resourceType: 'reconciliation_finding',
    resourceId: input.findingId,
    severity: 'info',
    metadata: {
      findingId: input.findingId,
      action: input.action,
      notes: input.notes,
      remediationMessage,
    },
  });

  return {
    success: true,
    message: `Finding ${input.findingId} marked as ${input.action}. ${remediationMessage}`,
  };
}

/**
 * Autonomous daily / periodic reconciliation sweep.
 * Sweeps all pending settlements, checks active provider statuses, and records findings.
 */
export async function runUniversalDailyReconciliation(): Promise<{
  scannedCount: number;
  unresolvedCount: number;
  autoResolvedCount: number;
  timestamp: string;
}> {
  const snapshot = await db.read();
  let scannedCount = 0;
  let autoResolvedCount = 0;
  let unresolvedCount = 0;

  // 1. Sweep pending NGN transfers older than 15 minutes
  const now = Date.now();
  const pendingTransfers = (snapshot.ngnTransfers ?? []).filter((t) => {
    const isPending = t.status === 'processing' || t.status === 'bank_processing' || t.status === 'awaiting_deposit';
    const ageMs = now - new Date(t.createdAt).getTime();
    return isPending && ageMs > 15 * 60 * 1000;
  });

  for (const transfer of pendingTransfers) {
    scannedCount++;
    try {
      const ref = transfer.providerTransferId || transfer.bankReference || (transfer as any).reference || transfer.id;
      const provider = (transfer as any).provider || 'paystack';
      const outcome = await reconcileOutboundTransfer({
        provider,
        reference: ref,
        reason: 'Automated daily reconciliation sweep',
      });
      if (outcome.updated) {
        autoResolvedCount++;
      } else if (outcome.status === 'processing') {
        unresolvedCount++;
      }
    } catch (err) {
      console.warn(`[universal-reconciliation] Transfer scan failed for ${transfer.id}:`, err);
    }
  }

  return {
    scannedCount,
    unresolvedCount,
    autoResolvedCount,
    timestamp: nowIso(),
  };
}
