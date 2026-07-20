import assert from 'node:assert/strict';
import { createSystemIncident, listActiveSystemIncidents, listSystemIncidents, resolveSystemIncident } from '../src/incidents/system-incidents.service.js';
import { getSystemStatus } from '../src/system/system-status.service.js';
import { buildPublicWithdrawalTimeline } from '../src/timeline/transaction-timeline.service.js';

const incident = await createSystemIncident({ provider: 'Bridge', affectedService: 'withdrawals', severity: 'warning', message: 'USD Withdrawals Delayed', eta: '30 minutes', createdBy: 'Samson' });
assert.equal(incident.provider, 'Bridge');
assert.equal(incident.customerMessage.includes('USD Withdrawals Delayed'), true);
const active = await listActiveSystemIncidents();
assert.equal(active.length, 1);
const status = await getSystemStatus();
assert.equal(status.activeIncidents?.length, 1);
await resolveSystemIncident(incident.id, { actorId: 'Samson', resolutionSummary: 'Bridge delay resolved.' });
const all = await listSystemIncidents();
assert.equal(all[0].status, 'resolved');

const now = new Date().toISOString();
const timeline = buildPublicWithdrawalTimeline({ id: 'wd_x', userId: 'usr_x', customerId: 'cus_x', externalAccountId: 'ea_x', liquidationAddressId: 'la_x', provider: 'bridge', sourceCurrency: 'usdc', destinationCurrency: 'usd', status: 'deposit_received', createdAt: now, updatedAt: now } as any, { customers: [{ id: 'cus_x', kycStatus: 'kyc_approved', updatedAt: now }], liquidationAddresses: [{ id: 'la_x', createdAt: now, providerLiquidationAddressId: 'pla_x' }], transactionReferences: [], webhookEvents: [] } as any);
assert.equal(timeline.explanation, 'Your crypto has arrived. We are preparing your bank payout.');
console.log(JSON.stringify({ ok: true, incidentId: incident.id, explanation: timeline.explanation }, null, 2));
