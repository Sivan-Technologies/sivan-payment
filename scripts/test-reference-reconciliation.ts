import assert from 'node:assert/strict';
import { db } from '../src/database/json-database.js';
import { buildReferenceReconciliationDashboard, persistReferenceReconciliationRun } from '../src/reconciliation/reference-reconciliation.service.js';

const now = new Date().toISOString();

await db.mutate((data) => {
  data.users = [];
  data.customers = [];
  data.externalAccounts = [];
  data.liquidationAddresses = [];
  data.withdrawals = [
    {
      id: 'wd_recon_1',
      userId: 'usr_1',
      customerId: 'cus_1',
      externalAccountId: 'ea_1',
      liquidationAddressId: 'la_1',
      provider: 'bridge',
      providerDrainId: 'drain_new',
      sourceCurrency: 'usdc',
      destinationCurrency: 'usd',
      destinationReference: 'ACH-REAL-1',
      status: 'payout_processing',
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'wd_recon_2',
      userId: 'usr_2',
      customerId: 'cus_2',
      externalAccountId: 'ea_2',
      liquidationAddressId: 'la_2',
      provider: 'bridge',
      providerDrainId: 'dup-drain',
      sourceCurrency: 'usdc',
      destinationCurrency: 'usd',
      status: 'completed',
      createdAt: now,
      updatedAt: now
    }
  ] as any;
  data.onrampOrders = [
    {
      id: 'or_recon_1',
      userId: 'usr_1',
      customerId: 'cus_1',
      provider: 'bridge',
      providerTransferId: 'transfer_1',
      sourceCurrency: 'usd',
      sourcePaymentRail: 'ach_push',
      destinationCurrency: 'usdc',
      destinationChain: 'avalanche_c_chain',
      destinationAddress: '0x0000000000000000000000000000000000000001',
      amount: '100',
      providerReference: 'ACH-REAL-1',
      status: 'processing',
      createdAt: now,
      updatedAt: now
    }
  ] as any;
  data.virtualAccounts = [];
  data.virtualAccountEvents = [];
  data.virtualAccountTransactions = [];
  data.transactionReferences = [
    {
      id: 'txref_mismatch',
      sivanTransactionId: 'wd_recon_1',
      resourceType: 'withdrawal',
      resourceId: 'wd_recon_1',
      provider: 'bridge',
      referenceType: 'bridge_drain_id',
      referenceValue: 'drain_old',
      direction: 'outbound',
      status: 'payout_processing',
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'txref_dup_1',
      sivanTransactionId: 'wd_recon_2',
      resourceType: 'withdrawal',
      resourceId: 'wd_recon_2',
      provider: 'bridge',
      referenceType: 'bridge_drain_id',
      referenceValue: 'dup-drain',
      direction: 'outbound',
      status: 'completed',
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'txref_dup_2',
      sivanTransactionId: 'or_recon_1',
      resourceType: 'onramp_order',
      resourceId: 'or_recon_1',
      provider: 'bridge',
      referenceType: 'bridge_drain_id',
      referenceValue: 'dup-drain',
      direction: 'inbound',
      status: 'processing',
      createdAt: now,
      updatedAt: now
    }
  ] as any;
  data.webhookEvents = [
    {
      id: 'wh_unmatched_1',
      provider: 'bridge',
      providerEventId: 'evt_unmatched_1',
      eventCategory: 'transfer',
      eventType: 'payment_processed',
      eventObjectId: 'transfer_missing',
      payload: { event_id: 'evt_unmatched_1', event_category: 'transfer', event_object_id: 'transfer_missing', event_object: { id: 'transfer_missing' } },
      processedAt: now,
      createdAt: now
    }
  ];
  data.unifiedWebhookLogs = [];
  data.reconciliationRuns = [];
  data.reconciliationFindings = [];
});

const dashboard = await buildReferenceReconciliationDashboard();
assert.equal(dashboard.summary.missingReferences > 0, true, 'expected missing references');
assert.equal(dashboard.summary.duplicateReferences > 0, true, 'expected duplicate references');
assert.equal(dashboard.summary.unmatchedWebhooks > 0, true, 'expected unmatched webhooks');
assert.equal(dashboard.summary.referenceMismatches > 0, true, 'expected reference mismatch');
assert.equal(dashboard.findings.some((finding) => finding.type === 'missing_reference'), true);
assert.equal(dashboard.findings.some((finding) => finding.type === 'duplicate_reference'), true);
assert.equal(dashboard.findings.some((finding) => finding.type === 'unmatched_webhook'), true);
assert.equal(dashboard.findings.some((finding) => finding.type === 'reference_mismatch'), true);

const persisted = await persistReferenceReconciliationRun({ dryRun: true });
assert.ok(persisted.runId);
const after = await db.read();
assert.equal(after.reconciliationRuns.length, 1);
assert.equal(after.reconciliationFindings.length, persisted.findings.length);

console.log(JSON.stringify({ ok: true, summary: dashboard.summary, persistedRunId: persisted.runId }, null, 2));
