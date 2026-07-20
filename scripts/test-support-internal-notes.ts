import assert from 'node:assert/strict';
import { db } from '../src/database/json-database.js';
import { addSupportTicketMessage, createSupportTicket, getSupportTicket } from '../src/support/support.service.js';

const now = new Date().toISOString();

await db.mutate((data) => {
  data.users = [{ id: 'usr_support_notes', email: 'support-notes@sivan.test', fullName: 'Support Notes', role: 'user', createdAt: now, updatedAt: now } as any];
  data.customers = [{ id: 'cus_support_notes', userId: 'usr_support_notes', provider: 'bridge', providerCustomerId: 'bridge_customer_notes', kycStatus: 'kyc_approved', createdAt: now, updatedAt: now } as any];
  data.supportTickets = [];
  data.supportTicketMessages = [];
  data.auditLogs = [];
});

const ticket = await createSupportTicket({
  userId: 'usr_support_notes',
  type: 'payout_delayed',
  subject: 'Payout delayed',
  description: 'My payout has not arrived after the provider accepted it.',
  resourceType: 'general'
});

await addSupportTicketMessage(ticket.id, {
  internalNote: true,
  messageType: 'internal_note',
  noteType: 'investigation',
  title: 'Provider settlement delayed',
  message: 'Provider says settlement delayed. Waiting on webhook. Do not retry payout.',
  statusAfter: 'waiting_on_provider'
}, { type: 'admin', id: 'Samson' });

await addSupportTicketMessage(ticket.id, {
  internalNote: true,
  messageType: 'resolution',
  noteType: 'resolution',
  title: 'Settlement completed',
  message: 'Webhook arrived and payout completed. No retry was needed.',
  statusAfter: 'closed'
}, { type: 'admin', id: 'Samson' });

const adminView = await getSupportTicket(ticket.id, { admin: true }) as any;
const userView = await getSupportTicket(ticket.id, { userId: 'usr_support_notes' }) as any;

assert.equal(adminView.status, 'closed');
assert.equal(adminView.internalNotes.length, 2, 'resolution defaults internal unless visibleToCustomer=true');
assert.equal(adminView.resolutionNotes.length, 1);
assert.equal(adminView.internalNotes[0].noteType, 'investigation');
assert.equal(adminView.internalNotes[0].senderId, 'Samson');
assert.equal(adminView.supportWorkflow.map((step: any) => step.label).join(' > '), 'Ticket > Conversation > Internal Notes > Resolution > Closed');
assert.equal(adminView.supportWorkflow.every((step: any) => step.status === 'completed'), true);
assert.equal(userView.messages.some((message: any) => message.internalNote), false, 'internal notes must never be exposed to customers');
assert.equal(userView.internalNotes.length, 0);

console.log(JSON.stringify({ ok: true, ticketId: ticket.id, workflow: adminView.supportWorkflow, userVisibleMessages: userView.messages.length }, null, 2));
