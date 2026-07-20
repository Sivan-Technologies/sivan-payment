import assert from 'node:assert/strict';
import { db } from '../src/database/json-database.js';
import { listWithdrawals } from '../src/offramp/service/withdrawals.service.js';
import { listOnrampOrders } from '../src/onramp/service/onramp-orders.service.js';

const now = new Date('2026-07-20T09:14:01.000Z').toISOString();
const later = new Date('2026-07-20T09:15:35.000Z').toISOString();

await db.mutate((data) => {
  data.users = [{ id: 'usr_timeline', email: 'timeline@sivan.test', fullName: 'Timeline User', role: 'user', createdAt: now, updatedAt: now } as any];
  data.customers = [{ id: 'cus_timeline', userId: 'usr_timeline', provider: 'bridge', providerCustomerId: 'bridge_customer_1', kycStatus: 'kyc_approved', createdAt: now, updatedAt: now } as any];
  data.externalAccounts = [];
  data.liquidationAddresses = [{ id: 'la_timeline', userId: 'usr_timeline', customerId: 'cus_timeline', externalAccountId: 'ea_timeline', provider: 'bridge', providerLiquidationAddressId: 'la_bridge_1', address: '0xabc', chain: 'avalanche_c_chain', sourceCurrency: 'usdc', destinationCurrency: 'usd', destinationPaymentRail: 'ach', status: 'active', createdAt: now, updatedAt: now } as any];
  data.withdrawals = [{ id: 'wd_timeline', userId: 'usr_timeline', customerId: 'cus_timeline', externalAccountId: 'ea_timeline', liquidationAddressId: 'la_timeline', provider: 'bridge', providerDrainId: 'drain_timeline_1', sourceCurrency: 'usdc', destinationCurrency: 'usd', sourceAmount: '100', destinationAmount: '99', depositTxHash: '0xhash', destinationTxHash: 'bank-ref-1', status: 'completed', createdAt: now, updatedAt: later, completedAt: later } as any];
  data.onrampOrders = [{ id: 'or_timeline', userId: 'usr_timeline', customerId: 'cus_timeline', provider: 'bridge', providerTransferId: 'transfer_timeline_1', sourceCurrency: 'usd', sourcePaymentRail: 'ach_push', destinationCurrency: 'usdc', destinationChain: 'avalanche_c_chain', destinationAddress: '0xwallet', amount: '100', netAmount: '98.75', providerReference: 'BANK-REF-1', destinationTxHash: '0xdelivery', status: 'completed', createdAt: now, updatedAt: later, completedAt: later } as any];
  data.webhookEvents = [];
  data.transactionReferences = [];
});

const withdrawals = await listWithdrawals('usr_timeline') as any[];
const onramps = await listOnrampOrders('usr_timeline') as any[];

assert.equal(withdrawals.length, 1);
assert.equal(onramps.length, 1);
assert.equal(withdrawals[0].transactionTimeline.requestId, 'wd_timeline');
assert.equal(withdrawals[0].transactionTimeline.providerReference, 'drain_timeline_1');
assert.equal(withdrawals[0].transactionTimeline.steps.map((step: any) => step.label).includes('Bank Processing'), true);
assert.equal(withdrawals[0].transactionTimeline.steps.every((step: any) => step.status === 'completed'), true);
assert.equal(onramps[0].transactionTimeline.requestId, 'or_timeline');
assert.equal(onramps[0].transactionTimeline.providerReference, 'transfer_timeline_1');
assert.equal(onramps[0].transactionTimeline.steps.map((step: any) => step.label).includes('Blockchain Delivered'), true);

console.log(JSON.stringify({ ok: true, withdrawalSteps: withdrawals[0].transactionTimeline.steps.length, onrampSteps: onramps[0].transactionTimeline.steps.length }, null, 2));
