import assert from 'node:assert/strict';
import { db } from '../src/database/json-database.js';
import { answerWhatsappAceSupport } from '../src/ace/service/ace-whatsapp.service.js';

const now = new Date().toISOString();
await db.mutate((data) => {
  data.users = [{ id: 'usr_ace_wa', email: 'ace-wa@sivan.test', fullName: 'Ace WhatsApp', role: 'user', whatsappNumber: 'whatsapp:+2348012345678', whatsappVerifiedAt: now, emailVerifiedAt: now, primaryChannel: 'both', createdAt: now, updatedAt: now } as any];
  data.customers = [{ id: 'cus_ace_wa', userId: 'usr_ace_wa', provider: 'bridge', providerCustomerId: 'bridge_cus_ace_wa', kycStatus: 'kyc_approved', createdAt: now, updatedAt: now } as any];
  data.customerIdentityLinks = [{ id: 'identity_ace_wa', paymentUserId: 'usr_ace_wa', email: 'ace-wa@sivan.test', whatsappNumber: 'whatsapp:+2348012345678', status: 'linked', linkedAt: now, createdAt: now, updatedAt: now } as any];
  data.liquidationAddresses = [{ id: 'la_ace_wa', userId: 'usr_ace_wa', customerId: 'cus_ace_wa', externalAccountId: 'ea_ace_wa', provider: 'bridge', providerLiquidationAddressId: 'pla_ace_wa', address: '0xabc', chain: 'avalanche_c_chain', sourceCurrency: 'usdc', destinationCurrency: 'usd', destinationPaymentRail: 'ach', status: 'active', createdAt: now, updatedAt: now } as any];
  data.withdrawals = [{ id: 'wd_ace_wa', userId: 'usr_ace_wa', customerId: 'cus_ace_wa', externalAccountId: 'ea_ace_wa', liquidationAddressId: 'la_ace_wa', provider: 'bridge', providerDrainId: 'drain_ace_wa', sourceCurrency: 'usdc', destinationCurrency: 'usd', sourceAmount: '100', destinationAmount: '99', depositTxHash: '0xdeposit', status: 'payout_processing', createdAt: now, updatedAt: now } as any];
  data.onrampOrders = [];
  data.webhookEvents = [];
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

const response = await answerWhatsappAceSupport({ whatsappNumber: '+2348012345678', message: 'where is my money' });
assert.equal(response.confidence, 'high');
assert.equal(response.needsHuman, false);
assert.equal(response.answer.length > 20, true);
assert.equal(response.evidenceChecked.includes('Transaction'), true);
const data = await db.read();
assert.equal(data.aceSupportSessions[0].channel, 'whatsapp');
console.log(JSON.stringify({ ok: true, answer: response.answer, session: data.aceSupportSessions[0] }, null, 2));
