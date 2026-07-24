import { env } from '../../config/env.js';
import { db } from '../../database/json-database.js';
import type { VirtualAccountCurrency } from '../types/virtual-account.types.js';

export type VirtualAccountEligibility = {
  eligible: boolean;
  reasons: string[];
  userId: string;
  customerId?: string;
};

export async function checkVirtualAccountEligibility(userId: string, currency: VirtualAccountCurrency): Promise<VirtualAccountEligibility> {
  const data = await db.read();
  const reasons: string[] = [];
  const user = data.users.find((item) => item.id === userId);
  if (!user) reasons.push('User account not found.');
  if (user && !user.emailVerifiedAt) reasons.push('Email must be verified.');

  const customer = data.customers.find((item) => item.userId === userId);
  if (!customer) reasons.push('Payment customer/KYC profile is required.');
  if (customer && customer.kycStatus !== 'kyc_approved') reasons.push('KYC must be approved before requesting a virtual account.');
  if (customer && env.VIRTUAL_ACCOUNT_PROVIDER === 'bridge' && customer.provider !== 'bridge') {
    reasons.push('A real Bridge verification profile is required before requesting a virtual account.');
  }

  const openRisk = (data.supportTickets ?? []).some((ticket) => ticket.userId === userId && ticket.priority === 'urgent' && !['resolved', 'closed'].includes(ticket.status));
  if (openRisk) reasons.push('Resolve urgent support/risk tickets before requesting a virtual account.');

  const existingSameCurrency = (data.virtualAccounts ?? []).find((account) => account.userId === userId && account.currency === currency && !['closed'].includes(account.status));
  if (existingSameCurrency) reasons.push(`A ${currency.toUpperCase()} virtual account already exists or is in progress.`);

  return { eligible: reasons.length === 0, reasons, userId, customerId: customer?.id };
}
