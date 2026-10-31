import assert from 'node:assert/strict';
import { db } from '../src/database/json-database.js';
import { providerReconciliationRegistry } from '../src/reconciliation/provider-reconciliation/reconciliation-registry.js';
import type {
  IProviderReconciliationAdapter,
  VerifiedDepositOutcome,
  VerifiedTransferOutcome,
} from '../src/reconciliation/provider-reconciliation/reconciliation-adapter.interface.js';
import {
  reconcileInboundDeposit,
  reconcileOutboundTransfer,
  resolveReconciliationFinding,
  runUniversalDailyReconciliation,
} from '../src/reconciliation/universal-reconciliation.service.js';
import { createBalanceLedgerEntry, getUserBalance } from '../src/balances/balance.service.js';

class MockNombaStyleAdapter implements IProviderReconciliationAdapter {
  readonly providerId = 'mock_nomba';
  readonly displayName = 'Mock Nomba Gateway';

  isConfigured(): boolean {
    return true;
  }

  async verifyInboundDeposit(reference: string): Promise<VerifiedDepositOutcome> {
    if (reference === 'nomba_dep_valid_123') {
      return {
        provider: this.providerId,
        reference,
        verified: true,
        amount: 25000,
        currency: 'NGN',
        status: 'success',
        customerEmail: 'reconcile_test_user@sivantech.online',
      };
    }
    return {
      provider: this.providerId,
      reference,
      verified: false,
      amount: 0,
      currency: 'NGN',
      status: 'failed',
      error: 'Transaction reference not found',
    };
  }

  async verifyOutboundTransfer(reference: string): Promise<VerifiedTransferOutcome> {
    if (reference === 'nomba_tf_reversed_456') {
      return {
        provider: this.providerId,
        reference,
        verified: true,
        amount: 10000,
        currency: 'NGN',
        status: 'reversed',
        failureReason: 'Destination bank rejected beneficiary name',
      };
    }
    if (reference === 'nomba_tf_success_789') {
      return {
        provider: this.providerId,
        reference,
        verified: true,
        amount: 15000,
        currency: 'NGN',
        status: 'completed',
      };
    }
    return {
      provider: this.providerId,
      reference,
      verified: false,
      amount: 0,
      currency: 'NGN',
      status: 'failed',
    };
  }
}

async function main() {
  console.log('[test-universal-reconciliation] Starting multi-provider reconciliation tests...');

  // 1. Verify default adapters in registry
  const adapters = providerReconciliationRegistry.getAll();
  const ids = adapters.map((a) => a.providerId);
  console.log('[test-universal-reconciliation] Registered adapters:', ids);
  assert(ids.includes('paystack'), 'Paystack adapter must be registered');
  assert(ids.includes('nomba'), 'Nomba adapter must be registered');
  assert(ids.includes('flutterwave'), 'Flutterwave adapter must be registered');
  assert(ids.includes('breet'), 'Breet adapter must be registered');

  // 2. Register mock provider adapter
  const mockAdapter = new MockNombaStyleAdapter();
  providerReconciliationRegistry.register(mockAdapter);

  // 3. Create a test user in database
  const testUserId = 'usr_reconcile_test_1';
  await db.insertUserRecord({
    id: testUserId,
    email: 'reconcile_test_user@sivantech.online',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as any);

  // 4. Test Inbound Deposit Backfill
  console.log('[test-universal-reconciliation] Testing inbound deposit backfill...');
  const backfillRes = await reconcileInboundDeposit({
    provider: 'mock_nomba',
    reference: 'nomba_dep_valid_123',
    userId: testUserId,
    reason: 'Customer reported missing GTBank deposit',
  });

  console.log('[test-universal-reconciliation] Backfill outcome:', backfillRes);
  assert(backfillRes.success, 'Deposit backfill must succeed');
  assert(backfillRes.credited, 'User balance must be credited');
  assert.equal(backfillRes.amount, 25000);

  // Check user spendable balance reflects the credited 25,000 NGN
  const balance1 = await getUserBalance(testUserId);
  const ngnBal1 = balance1.balances.find((b) => b.asset === 'ngn');
  assert(Number(ngnBal1?.available) >= 25000, `User NGN available balance must reflect credited funds, got ${ngnBal1?.available}`);

  // 5. Test Idempotency Guardrail: Replaying same reference must NOT credit twice!
  const replayRes = await reconcileInboundDeposit({
    provider: 'mock_nomba',
    reference: 'nomba_dep_valid_123',
    userId: testUserId,
  });
  console.log('[test-universal-reconciliation] Replay outcome:', replayRes);
  assert(replayRes.success, 'Replay call must succeed safely');
  assert(!replayRes.credited, 'Idempotency guard must prevent duplicate credit!');

  // 6. Test Outbound Transfer Reversal Remediation
  console.log('[test-universal-reconciliation] Testing transfer reversal remediation...');
  // Simulate an outbound transfer record that was held/debited
  const transferId = 'trf_reversal_test_1';
  const transferRef = 'nomba_tf_reversed_456';
  await db.mutate((data) => {
    data.ngnTransfers = data.ngnTransfers ?? [];
    data.ngnTransfers.push({
      id: transferId,
      userId: testUserId,
      reference: transferRef,
      amountNgn: 10000,
      feeNgn: 0,
      status: 'processing',
      destinationAccount: '0123456789',
      destinationBankCode: '999999',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any);
  });

  // Reconcile with provider
  const syncRes = await reconcileOutboundTransfer({
    provider: 'mock_nomba',
    reference: transferRef,
    reason: 'Bank name mismatch reversal',
  });
  console.log('[test-universal-reconciliation] Sync transfer outcome:', syncRes);
  assert(syncRes.success, 'Sync transfer must succeed');
  assert(syncRes.updated, 'Transfer state must be updated');
  assert.equal(syncRes.status, 'reversed', 'Provider status must be reversed');

  // 7. Test Finding Resolution
  console.log('[test-universal-reconciliation] Testing finding resolution...');
  const findingId = 'fnd_test_reconcile_1';
  await db.mutate((data) => {
    data.reconciliationFindings = data.reconciliationFindings ?? [];
    data.reconciliationFindings.push({
      id: findingId,
      runId: 'run_1',
      provider: 'mock_nomba',
      severity: 'warning',
      findingType: 'unmatched_webhook',
      message: 'Unmatched deposit reference',
      createdAt: new Date().toISOString(),
    } as any);
  });

  const resolveRes = await resolveReconciliationFinding({
    findingId,
    action: 'mark_resolved',
    notes: 'Verified and manual reconciliation complete',
    operatorId: 'admin_test',
  });
  console.log('[test-universal-reconciliation] Resolve finding outcome:', resolveRes);
  assert(resolveRes.success, 'Finding must be resolved');

  // 8. Test Daily Sweep Worker
  console.log('[test-universal-reconciliation] Testing daily sweep worker...');
  const sweepRes = await runUniversalDailyReconciliation();
  console.log('[test-universal-reconciliation] Sweep outcome:', sweepRes);
  assert(sweepRes.timestamp, 'Sweep must complete and return timestamp');

  console.log('✅ [test-universal-reconciliation] All multi-provider reconciliation tests passed!');
}

main().catch((err) => {
  console.error('❌ [test-universal-reconciliation] Failed:', err);
  process.exit(1);
});
