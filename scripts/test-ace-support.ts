import assert from 'node:assert/strict';
import { db } from '../src/database/json-database.js';
import { answerAceSupport } from '../src/ace/service/ace-support.service.js';

const now = new Date().toISOString();
await db.mutate((data) => {
  data.users = [{ id: 'usr_ace', email: 'ace@sivan.test', fullName: 'Ace User', role: 'user', createdAt: now, updatedAt: now } as any];
  data.customers = [{ id: 'cus_ace', userId: 'usr_ace', provider: 'bridge', providerCustomerId: 'bridge_cus_ace', kycStatus: 'kyc_approved', createdAt: now, updatedAt: now } as any];
  data.liquidationAddresses = [{ id: 'la_ace', userId: 'usr_ace', customerId: 'cus_ace', externalAccountId: 'ea_ace', provider: 'bridge', providerLiquidationAddressId: 'pla_ace', address: '0xabc', chain: 'avalanche_c_chain', sourceCurrency: 'usdc', destinationCurrency: 'usd', destinationPaymentRail: 'ach', status: 'active', createdAt: now, updatedAt: now } as any];
  data.withdrawals = [{ id: 'wd_ace', userId: 'usr_ace', customerId: 'cus_ace', externalAccountId: 'ea_ace', liquidationAddressId: 'la_ace', provider: 'bridge', providerDrainId: 'drain_ace', sourceCurrency: 'usdc', destinationCurrency: 'usd', sourceAmount: '100', destinationAmount: '99', depositTxHash: '0xdeposit', status: 'payout_processing', createdAt: now, updatedAt: now } as any];
  data.onrampOrders = [];
  data.webhookEvents = [{ id: 'wh_ace', provider: 'bridge', providerEventId: 'evt_ace', eventCategory: 'liquidation_address_drain', eventType: 'payment_submitted', eventObjectId: 'drain_ace', payload: { event_object: { id: 'drain_ace' } }, processedAt: now, createdAt: now }];
  data.transactionReferences = [];
  data.reconciliationFindings = [];
  data.systemIncidents = [];
  data.supportTickets = [];
  data.supportTicketMessages = [];
  data.aceSupportSessions = [];
  data.aceSupportMessages = [];
  data.aceToolCalls = [];
  data.aceSupportResolutions = [];
});

const response = await answerAceSupport({ userId: 'usr_ace', message: 'Where is my money?', resourceType: 'withdrawal', resourceId: 'wd_ace', channel: 'web_dashboard' });
assert.equal(response.confidence, 'high');
assert.equal(response.needsHuman, false);
assert.equal(response.answer.includes('Your withdrawal'), true);
assert.equal(response.answer.includes('Request ID: wd_ace'), true);
assert.equal(response.evidenceChecked.includes('Webhook events'), true);
const data = await db.read();
assert.equal(data.aceSupportSessions.length, 1);
assert.equal(data.aceToolCalls.length > 0, true);
console.log(JSON.stringify({ ok: true, answer: response.answer, evidenceChecked: response.evidenceChecked }, null, 2));
