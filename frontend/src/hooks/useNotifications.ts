import { useEffect, useMemo, useState } from 'react';
import type { BalanceTransferRecord, CustomerRecord, OnrampOrderRecord, SupplierPaymentRecord, SupportTicketRecord, SystemStatus, UserRecord, ViewKey, VirtualAccountTransactionRecord, WithdrawalRecord } from '../types';
import { friendlyStatus, readStorage } from '../appUtils';

export type UserNotification = {
  id: string;
  icon: string;
  title: string;
  message: string;
  severity: 'info' | 'action' | 'urgent';
  createdAt: string;
  actionLabel?: string;
  view?: ViewKey;
};

export function useNotifications(input: {
  systemStatus: SystemStatus;
  customer: CustomerRecord | null;
  hasBank: boolean;
  hasUser: boolean;
  user: UserRecord | null;
  twoFactorEnabled?: boolean;
  onrampOrders: OnrampOrderRecord[];
  withdrawals: WithdrawalRecord[];
  balanceTransfers: BalanceTransferRecord[];
  supplierPayments: SupplierPaymentRecord[];
  virtualAccountTransactions: VirtualAccountTransactionRecord[];
  supportTickets: SupportTicketRecord[];
}) {
  const [readNotificationIds, setReadNotificationIds] = useState<string[]>(() => readStorage<string[]>('sivan.readNotifications', []));

  useEffect(() => {
    localStorage.setItem('sivan.readNotifications', JSON.stringify(readNotificationIds.slice(-200)));
  }, [readNotificationIds]);

  const notifications = useMemo<UserNotification[]>(() => {
    const items: UserNotification[] = [];
    const push = (item: UserNotification) => items.push(item);
    const now = new Date().toISOString();
    const { systemStatus, customer, hasBank, hasUser, user, twoFactorEnabled, onrampOrders, withdrawals, balanceTransfers, supplierPayments, virtualAccountTransactions, supportTickets } = input;

    for (const incident of systemStatus.activeIncidents ?? []) {
      push({ id: `incident:${incident.id}`, icon: incident.severity === 'critical' ? '!' : '⚠', title: incident.severity === 'critical' ? 'Service disruption' : 'Provider maintenance', message: incident.customerMessage || incident.message || 'Some payment services may be delayed.', severity: incident.severity === 'critical' ? 'urgent' : 'action', createdAt: incident.startedAt || (incident as any).createdAt || now, actionLabel: 'View support', view: 'help' });
    }
    if (customer?.kycStatus === 'kyc_incomplete') push({ id: `kyc:${customer.id}:incomplete`, icon: '◈', title: 'Verification needs one more step', message: customer.customerAction?.message || 'Complete the remaining verification details to continue.', severity: 'action', createdAt: customer.updatedAt || now, actionLabel: 'Continue', view: 'kyc' });
    else if (customer?.kycStatus === 'kyc_rejected') push({ id: `kyc:${customer.id}:rejected`, icon: '!', title: 'Verification needs support', message: 'Your verification could not be completed. Retry securely or contact support.', severity: 'urgent', createdAt: customer.updatedAt || now, actionLabel: 'Review', view: 'kyc' });
    else if (customer?.kycStatus === 'kyc_under_review') push({ id: `kyc:${customer.id}:review`, icon: '⏳', title: 'Verification under review', message: 'We will update your account as soon as review is complete.', severity: 'info', createdAt: customer.updatedAt || now, actionLabel: 'Check status', view: 'kyc' });
    else if (customer?.kycStatus === 'kyc_approved' && !hasBank) push({ id: `bank:${user?.id || 'me'}:missing`, icon: '▭', title: 'Add payout bank', message: 'You are verified. Add a payout bank to start selling crypto.', severity: 'action', createdAt: customer.updatedAt || now, actionLabel: 'Add bank', view: 'banks' });
    if (customer?.kycStatus === 'kyc_approved' && !twoFactorEnabled) push({ id: `security:${user?.id || 'me'}:2fa-recommended`, icon: '⚿', title: 'Protect your Sivan account', message: 'Enable authenticator 2FA to secure transfers and payouts.', severity: 'info', createdAt: customer.updatedAt || now, actionLabel: 'Enable', view: 'settings' });
    else if (!customer && hasUser) push({ id: `kyc:${user?.id || 'me'}:not-started`, icon: '◈', title: 'Identity verification required', message: 'Complete identity verification to unlock payments.', severity: 'action', createdAt: user?.createdAt || now, actionLabel: 'Start verification', view: 'kyc' });

    for (const order of onrampOrders.slice(0, 5)) {
      if (order.status === 'awaiting_payment') push({ id: `onramp:${order.id}:awaiting`, icon: '↙', title: 'Buy order awaiting payment', message: `Send ${order.amount} ${order.sourceCurrency.toUpperCase()} using the exact reference.`, severity: 'action', createdAt: order.updatedAt || order.createdAt, actionLabel: 'View', view: 'history' });
      if (['payment_received', 'processing'].includes(order.status)) push({ id: `onramp:${order.id}:processing`, icon: '↙', title: 'Bank payment received', message: 'We are preparing your crypto delivery.', severity: 'info', createdAt: order.updatedAt || order.createdAt, actionLabel: 'Track', view: 'history' });
      if (order.status === 'failed') push({ id: `onramp:${order.id}:failed`, icon: '!', title: 'Buy order failed', message: 'Open the transaction timeline or contact support.', severity: 'urgent', createdAt: order.updatedAt || order.createdAt, actionLabel: 'View', view: 'history' });
    }
    for (const withdrawal of withdrawals.slice(0, 5)) {
      if (['pending_deposit', 'deposit_received', 'payout_processing', 'requires_action'].includes(withdrawal.status)) push({ id: `withdrawal:${withdrawal.id}:${withdrawal.status}`, icon: '↗', title: withdrawal.status === 'deposit_received' ? 'Withdrawal deposit detected' : 'Withdrawal in progress', message: withdrawal.status === 'requires_action' ? 'This withdrawal needs review.' : 'Your sell transaction is moving through settlement.', severity: withdrawal.status === 'requires_action' ? 'action' : 'info', createdAt: withdrawal.updatedAt || withdrawal.createdAt, actionLabel: 'Track', view: 'history' });
      if (withdrawal.status === 'failed') push({ id: `withdrawal:${withdrawal.id}:failed`, icon: '!', title: 'Withdrawal failed', message: 'Open the transaction timeline or contact support.', severity: 'urgent', createdAt: withdrawal.updatedAt || withdrawal.createdAt, actionLabel: 'View', view: 'history' });
    }
    for (const transfer of balanceTransfers.slice(0, 5)) if (transfer.status === 'pending_review') push({ id: `balance-transfer:${transfer.transferId}:review`, icon: '⇆', title: 'Transfer held for review', message: 'Your transfer is pending compliance review.', severity: 'action', createdAt: transfer.updatedAt || transfer.createdAt, actionLabel: 'View', view: 'transfer' });
    for (const payment of supplierPayments.slice(0, 5)) {
      if (payment.status === 'pending_review') push({ id: `supplier-payment:${payment.id}:review`, icon: '▭', title: 'Supplier payment held for review', message: 'Sivan is reviewing your supplier payout before provider release.', severity: 'action', createdAt: payment.updatedAt || payment.createdAt, actionLabel: 'View', view: 'transfer' });
      if (payment.status === 'failed') push({ id: `supplier-payment:${payment.id}:failed`, icon: '!', title: 'Supplier payment failed', message: 'Open Transfer & Pay or contact support.', severity: 'urgent', createdAt: payment.updatedAt || payment.createdAt, actionLabel: 'View', view: 'transfer' });
    }
    for (const tx of virtualAccountTransactions.slice(0, 4)) {
      if (!['completed', 'payment_processed'].includes(String(tx.status))) push({ id: `va-tx:${tx.id}:pending`, icon: '▥', title: 'Virtual account deposit pending', message: 'Funds are being settled before becoming available.', severity: 'info', createdAt: tx.updatedAt || tx.createdAt, actionLabel: 'View', view: 'virtualAccounts' });
      if (['completed', 'payment_processed'].includes(String(tx.status))) push({ id: `va-tx:${tx.id}:completed`, icon: '✓', title: 'USDC balance credited', message: 'A virtual account deposit has settled into your Sivan balance.', severity: 'info', createdAt: tx.updatedAt || tx.createdAt, actionLabel: 'View', view: 'transfer' });
    }
    for (const ticket of supportTickets.slice(0, 5)) {
      if (['open', 'in_review', 'waiting_on_user', 'waiting_on_provider'].includes(ticket.status)) push({ id: `support:${ticket.id}:${ticket.status}`, icon: '?', title: ticket.status === 'waiting_on_user' ? 'Support needs your response' : 'Support ticket active', message: `${ticket.subject || 'Your ticket'} · ${friendlyStatus(ticket.status)}`, severity: ticket.status === 'waiting_on_user' ? 'action' : 'info', createdAt: ticket.updatedAt || ticket.lastMessageAt || ticket.createdAt, actionLabel: 'Open', view: 'help' });
      if (ticket.status === 'resolved') push({ id: `support:${ticket.id}:resolved`, icon: '✓', title: 'Support ticket resolved', message: ticket.subject || 'Your ticket has been marked resolved.', severity: 'info', createdAt: ticket.updatedAt || ticket.closedAt || ticket.createdAt, actionLabel: 'View', view: 'help' });
    }
    const rank = { urgent: 3, action: 2, info: 1 } as const;
    return items.sort((a, b) => rank[b.severity] - rank[a.severity] || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 12);
  }, [input]);

  const unreadNotifications = notifications.filter((item) => !readNotificationIds.includes(item.id));
  const notificationDotClass = unreadNotifications.some((item) => item.severity === 'urgent') ? 'urgent' : unreadNotifications.some((item) => item.severity === 'action') ? 'action' : '';
  const markNotificationRead = (id: string) => setReadNotificationIds((ids) => ids.includes(id) ? ids : [...ids, id]);
  const markAllNotificationsRead = () => setReadNotificationIds((ids) => Array.from(new Set([...ids, ...notifications.map((item) => item.id)])));

  return { notifications, readNotificationIds, unreadNotifications, notificationDotClass, markNotificationRead, markAllNotificationsRead };
}
