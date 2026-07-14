import { z } from 'zod';
import { db } from '../database/json-database.js';
import type { SupportTicketMessageRecord, SupportTicketRecord } from '../database/types.js';
import { badRequest, notFound } from '../shared/errors.js';
import { id, nowIso } from '../shared/id.js';
import { createAuditLog } from '../audit/audit.service.js';
import { env } from '../config/env.js';
import { sendEmail } from '../notifications/email.service.js';

export const createSupportTicketSchema = z.object({
  userId: z.string().min(1),
  type: z.enum(['verification', 'bank_account', 'withdrawal', 'deposit_not_detected', 'wrong_token_or_network', 'payout_delayed', 'onramp_payment', 'onramp_delivery', 'account_access', 'other']),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  subject: z.string().min(3).max(160),
  description: z.string().min(10).max(5000),
  resourceType: z.enum(['withdrawal', 'onramp_order', 'external_account', 'customer', 'general']).default('general'),
  resourceId: z.string().optional(),
  transactionHash: z.string().optional(),
  bankReference: z.string().optional(),
  walletAddress: z.string().optional(),
  attachmentUrl: z.string().url().optional(),
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
    metadata: { ...(typeof input.metadata === 'object' && input.metadata ? input.metadata as Record<string, unknown> : {}), transactionHash: input.transactionHash, bankReference: input.bankReference, walletAddress: input.walletAddress, attachmentUrl: input.attachmentUrl },
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
  await notifyTicketCreated(ticket, user.email);
  return enrichTicket({ ...ticket, messages: [message], user });
}

export async function listUserSupportTickets(userId: string, options: { limit?: number; offset?: number } = {}) {
  return (await db.listUserSupportTicketsView(userId, options)).map(enrichTicket);
}

export async function getSupportTicket(ticketId: string, requester?: { userId?: string; admin?: boolean }) {
  const ticket = await db.getSupportTicketView(ticketId);
  if (!ticket) throw notFound('Support ticket');
  if (!requester?.admin && requester?.userId && (ticket as any).userId !== requester.userId) throw notFound('Support ticket');
  return enrichTicket(ticket);
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
  if (sender.type === 'admin' && !message.internalNote) await notifyAdminReply(current as any, message);
  return message;
}

export async function listAdminSupportTickets(options: { limit?: number; offset?: number; status?: string; priority?: string; type?: string; assignedTo?: string; search?: string; dateFrom?: string; dateTo?: string } = {}) {
  return (await db.listAdminSupportTicketsView(options)).map(enrichTicket);
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
  if (['resolved', 'closed'].includes(updated.status) && !['resolved', 'closed'].includes((current as any).status)) await notifyTicketResolved(current as any);
  return enrichTicket(updated);
}


export async function getSupportAnalytics() {
  const tickets = await listAdminSupportTickets({ limit: 500 });
  const now = Date.now();
  const byStatus = countBy(tickets, 'status');
  const byType = countBy(tickets, 'type');
  const byPriority = countBy(tickets, 'priority');
  const urgentTickets = tickets.filter((ticket: any) => ticket.priority === 'urgent' && !['resolved', 'closed'].includes(ticket.status));
  const openTickets = tickets.filter((ticket: any) => !['resolved', 'closed'].includes(ticket.status));
  const wrongNetworkCount = tickets.filter((ticket: any) => ticket.type === 'wrong_token_or_network').length;
  const providerRelatedCount = tickets.filter((ticket: any) => ticket.status === 'waiting_on_provider' || ['deposit_not_detected', 'payout_delayed', 'onramp_payment', 'onramp_delivery'].includes(ticket.type)).length;
  const resolved = tickets.filter((ticket: any) => ticket.closedAt);
  const avgResolutionMs = average(resolved.map((ticket: any) => new Date(ticket.closedAt).getTime() - new Date(ticket.createdAt).getTime()));
  return {
    generatedAt: new Date().toISOString(),
    openTickets: openTickets.length,
    urgentTickets: urgentTickets.length,
    wrongNetworkCount,
    providerRelatedCount,
    byStatus,
    byType,
    byPriority,
    averageResolutionMinutes: Math.round(avgResolutionMs / 60000),
    overdueTickets: openTickets.filter((ticket: any) => ticket.sla?.overdue).length,
    newestOpenAgeMinutes: openTickets.length ? Math.round((now - Math.max(...openTickets.map((ticket: any) => new Date(ticket.createdAt).getTime()))) / 60000) : 0
  };
}

function enrichTicket(ticket: any): any {
  const createdAt = new Date(ticket.createdAt).getTime();
  const lastMessageAt = ticket.lastMessageAt ? new Date(ticket.lastMessageAt).getTime() : createdAt;
  const dueAt = firstResponseDueAt(ticket.priority, createdAt);
  const now = Date.now();
  return {
    ...ticket,
    sla: {
      firstResponseDueAt: new Date(dueAt).toISOString(),
      minutesUntilDue: Math.round((dueAt - now) / 60000),
      overdue: !['resolved', 'closed'].includes(ticket.status) && now > dueAt,
      ageMinutes: Math.round((now - createdAt) / 60000),
      minutesSinceLastMessage: Math.round((now - lastMessageAt) / 60000)
    }
  };
}

function firstResponseDueAt(priority: string, createdAtMs: number) {
  const hours = priority === 'urgent' ? 1 : priority === 'high' ? 4 : priority === 'low' ? 48 : 24;
  return createdAtMs + hours * 60 * 60 * 1000;
}

function countBy(items: any[], key: string) {
  return items.reduce<Record<string, number>>((acc, item) => {
    const value = item[key] ?? 'unknown';
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function safeSendEmail(input: { to?: string; subject: string; text: string }) {
  if (!input.to) return;
  try {
    await sendEmail({ to: input.to, subject: input.subject, text: input.text });
  } catch (error) {
    console.warn('[support.email_failed]', error instanceof Error ? error.message : String(error));
  }
}

async function notifyTicketCreated(ticket: SupportTicketRecord, userEmail?: string) {
  await safeSendEmail({ to: userEmail, subject: 'We received your Sivan support request', text: `We received your support request.\n\nTicket: ${ticket.id}\nSubject: ${ticket.subject}\nStatus: ${ticket.status}\n\nWe will review and update you.` });
  if (ticket.priority === 'urgent') await safeSendEmail({ to: env.SUPPORT_NOTIFICATION_EMAIL, subject: 'Urgent Sivan support ticket created', text: `Urgent support ticket created.\n\nTicket: ${ticket.id}\nType: ${ticket.type}\nUser: ${ticket.userId}\nSubject: ${ticket.subject}` });
}

async function notifyAdminReply(ticket: any, message: SupportTicketMessageRecord) {
  const email = ticket.user?.email;
  await safeSendEmail({ to: email, subject: 'Sivan Support replied to your ticket', text: `Sivan Support replied to your ticket ${ticket.id}.\n\n${message.message}` });
}

async function notifyTicketResolved(ticket: any) {
  const email = ticket.user?.email;
  await safeSendEmail({ to: email, subject: 'Your support ticket has been resolved', text: `Your support ticket ${ticket.id} has been marked as resolved. If you still need help, reply to the ticket or open a new support request.` });
}

function validateResourceOwnership(userId: string, resourceType: string, resourceId: string | undefined, data: any) {
  if (!resourceId || resourceType === 'general') return;
  if (resourceType === 'withdrawal' && !data.withdrawals.some((item: any) => item.id === resourceId && item.userId === userId)) throw badRequest('Related withdrawal was not found for this user');
  if (resourceType === 'onramp_order' && !(data.onrampOrders ?? []).some((item: any) => item.id === resourceId && item.userId === userId)) throw badRequest('Related on-ramp order was not found for this user');
  if (resourceType === 'external_account' && !data.externalAccounts.some((item: any) => item.id === resourceId && item.userId === userId)) throw badRequest('Related bank account was not found for this user');
  if (resourceType === 'customer' && !data.customers.some((item: any) => item.id === resourceId && item.userId === userId)) throw badRequest('Related verification record was not found for this user');
}
