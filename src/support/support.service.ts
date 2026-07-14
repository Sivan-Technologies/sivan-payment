import { z } from 'zod';
import { db } from '../database/json-database.js';
import type { SupportTicketMessageRecord, SupportTicketRecord } from '../database/types.js';
import { badRequest, notFound } from '../shared/errors.js';
import { id, nowIso } from '../shared/id.js';
import { createAuditLog } from '../audit/audit.service.js';

export const createSupportTicketSchema = z.object({
  userId: z.string().min(1),
  type: z.enum(['verification', 'bank_account', 'withdrawal', 'deposit_not_detected', 'wrong_token_or_network', 'payout_delayed', 'onramp_payment', 'onramp_delivery', 'account_access', 'other']),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  subject: z.string().min(3).max(160),
  description: z.string().min(10).max(5000),
  resourceType: z.enum(['withdrawal', 'onramp_order', 'external_account', 'customer', 'general']).default('general'),
  resourceId: z.string().optional(),
  metadata: z.unknown().optional()
});

export const createSupportMessageSchema = z.object({
  userId: z.string().optional(),
  message: z.string().min(1).max(5000),
  internalNote: z.boolean().optional().default(false)
});

export const updateSupportTicketSchema = z.object({
  status: z.enum(['open', 'in_review', 'waiting_on_user', 'waiting_on_provider', 'resolved', 'closed']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  assignedTo: z.string().optional().nullable()
});

export function defaultPriority(type: z.infer<typeof createSupportTicketSchema>['type']) {
  if (type === 'wrong_token_or_network') return 'urgent' as const;
  if (['deposit_not_detected', 'payout_delayed', 'onramp_payment', 'onramp_delivery'].includes(type)) return 'high' as const;
  return 'normal' as const;
}

export async function createSupportTicket(input: z.infer<typeof createSupportTicketSchema>) {
  const data = await db.read();
  const user = data.users.find((item) => item.id === input.userId);
  if (!user) throw notFound('User');
  const customer = data.customers.find((item) => item.userId === input.userId);
  validateResourceOwnership(input.userId, input.resourceType, input.resourceId, data);

  const now = nowIso();
  const ticket: SupportTicketRecord = {
    id: id('sup'),
    userId: input.userId,
    customerId: customer?.id,
    type: input.type,
    priority: input.priority ?? defaultPriority(input.type),
    status: 'open',
    subject: input.subject,
    description: input.description,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    lastMessageAt: now,
    metadata: input.metadata,
    createdAt: now,
    updatedAt: now
  };
  const message: SupportTicketMessageRecord = {
    id: id('msg'),
    ticketId: ticket.id,
    senderType: 'user',
    senderId: input.userId,
    message: input.description,
    internalNote: false,
    createdAt: now
  };

  await db.insertSupportTicketRecord(ticket);
  await db.insertSupportTicketMessageRecord(message);
  await createAuditLog({ actorType: 'user', actorId: input.userId, action: 'support.ticket_created', resourceType: 'payments_support_ticket', resourceId: ticket.id, severity: ticket.priority === 'urgent' ? 'warning' : 'info', metadata: { type: ticket.type, priority: ticket.priority, resourceType: ticket.resourceType, resourceId: ticket.resourceId } });
  return { ...ticket, messages: [message], user };
}

export async function listUserSupportTickets(userId: string, options: { limit?: number; offset?: number } = {}) {
  return db.listUserSupportTicketsView(userId, options);
}

export async function getSupportTicket(ticketId: string, requester?: { userId?: string; admin?: boolean }) {
  const ticket = await db.getSupportTicketView(ticketId);
  if (!ticket) throw notFound('Support ticket');
  if (!requester?.admin && requester?.userId && (ticket as any).userId !== requester.userId) throw notFound('Support ticket');
  return ticket;
}

export async function addSupportTicketMessage(ticketId: string, input: z.infer<typeof createSupportMessageSchema>, sender: { type: 'user' | 'admin' | 'system'; id?: string }) {
  const current = await getSupportTicket(ticketId, { userId: sender.type === 'user' ? sender.id : undefined, admin: sender.type === 'admin' || sender.type === 'system' });
  const now = nowIso();
  const message: SupportTicketMessageRecord = { id: id('msg'), ticketId, senderType: sender.type, senderId: sender.id, message: input.message, internalNote: sender.type === 'admin' ? Boolean(input.internalNote) : false, createdAt: now };
  await db.insertSupportTicketMessageRecord(message);

  let nextStatus = (current as any).status;
  if (sender.type === 'user' && nextStatus === 'waiting_on_user') nextStatus = 'in_review';
  const updated: SupportTicketRecord = { ...(current as any), status: nextStatus, lastMessageAt: now, updatedAt: now };
  delete (updated as any).messages;
  delete (updated as any).user;
  await db.updateSupportTicketRecord(updated);
  await createAuditLog({ actorType: sender.type === 'admin' ? 'admin' : 'user', actorId: sender.id, action: sender.type === 'admin' ? (message.internalNote ? 'support.ticket_internal_note_added' : 'support.ticket_admin_replied') : 'support.ticket_user_replied', resourceType: 'payments_support_ticket', resourceId: ticketId, severity: 'info', metadata: { internalNote: message.internalNote } });
  return message;
}

export async function listAdminSupportTickets(options: { limit?: number; offset?: number; status?: string; priority?: string; type?: string } = {}) {
  return db.listAdminSupportTicketsView(options);
}

export async function updateSupportTicket(ticketId: string, input: z.infer<typeof updateSupportTicketSchema>, actorId = 'admin_api_key') {
  const current = await getSupportTicket(ticketId, { admin: true });
  const now = nowIso();
  const status = input.status ?? (current as any).status;
  const updated: SupportTicketRecord = {
    ...(current as any),
    status,
    priority: input.priority ?? (current as any).priority,
    assignedTo: input.assignedTo ?? (current as any).assignedTo,
    updatedAt: now,
    closedAt: ['resolved', 'closed'].includes(status) ? ((current as any).closedAt ?? now) : undefined
  };
  delete (updated as any).messages;
  delete (updated as any).user;
  await db.updateSupportTicketRecord(updated);
  await createAuditLog({ actorType: 'admin', actorId, action: 'support.ticket_updated', resourceType: 'payments_support_ticket', resourceId: ticketId, severity: updated.priority === 'urgent' ? 'warning' : 'info', metadata: { previousStatus: (current as any).status, nextStatus: updated.status, priority: updated.priority, assignedTo: updated.assignedTo } });
  return updated;
}

function validateResourceOwnership(userId: string, resourceType: string, resourceId: string | undefined, data: any) {
  if (!resourceId || resourceType === 'general') return;
  if (resourceType === 'withdrawal' && !data.withdrawals.some((item: any) => item.id === resourceId && item.userId === userId)) throw badRequest('Related withdrawal was not found for this user');
  if (resourceType === 'onramp_order' && !(data.onrampOrders ?? []).some((item: any) => item.id === resourceId && item.userId === userId)) throw badRequest('Related on-ramp order was not found for this user');
  if (resourceType === 'external_account' && !data.externalAccounts.some((item: any) => item.id === resourceId && item.userId === userId)) throw badRequest('Related bank account was not found for this user');
  if (resourceType === 'customer' && !data.customers.some((item: any) => item.id === resourceId && item.userId === userId)) throw badRequest('Related verification record was not found for this user');
}
