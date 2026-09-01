/**
 * SERVICE AGREEMENT LIFECYCLE MANAGER
 *
 * Owns creation, state transitions, and the live countdown label computation
 * for service agreements. The sweeper (deadline-sweeper.service.ts) calls
 * listActiveAgreementsForDeadlineSweep() and claims sentinel flags through
 * markReminder6hSent() / markOverdueNoticeSent().
 *
 * STATE MACHINE:
 *   createAgreement()   → pending_payment
 *   fundAgreement()     → funded        (computes delivery_due_at)
 *   startDelivery()     → in_delivery   (optional; seller signals work started)
 *   markDelivered()     → delivered
 *   releaseAgreement()  → released
 *   cancelAgreement()   → cancelled
 */

import { db } from '../database/json-database.js';
import { id as generateId, nowIso } from '../shared/id.js';
import { parseDeliveryDeadline } from './deadline-parser.js';
import { badRequest, notFound } from '../shared/errors.js';
import type { ServiceAgreementRecord, ServiceAgreementStatus, WalletChain } from '../database/types.js';

// ─── Input shapes ────────────────────────────────────────────────────────────

export interface CreateAgreementInput {
  buyerUserId: string;
  sellerUserId: string;
  title: string;
  description: string;
  amountUsdc: number;
  currency?: string;
  network: WalletChain;
  /** Optional override: bypass NL extraction and set deadline_days directly. */
  deadlineDays?: number;
}

// ─── Countdown label ─────────────────────────────────────────────────────────

/**
 * Computes a human-readable countdown label for the chat card and web badge.
 *
 * Examples:
 *   ⏱ 18 hours remaining
 *   ⚠️ Delivery due today at 5:00 PM
 *   🔴 Overdue by 3 hours
 *   ✅ Delivered
 *   — (no deadline set yet)
 */
export function getCountdownLabel(agreement: ServiceAgreementRecord, now = new Date()): string {
  if (agreement.status === 'released') return '✅ Released';
  if (agreement.status === 'delivered') return '✅ Delivered — awaiting release';
  if (agreement.status === 'cancelled') return '❌ Cancelled';
  if (agreement.status === 'disputed') return '⚠️ In dispute';

  if (!agreement.deliveryDueAt) {
    return agreement.status === 'pending_payment'
      ? '⏳ Awaiting payment'
      : '— No deadline set';
  }

  const dueAt = new Date(agreement.deliveryDueAt);
  const diffMs = dueAt.getTime() - now.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);

  if (diffHours > 24) {
    const days = Math.floor(diffHours / 24);
    const remainingHours = Math.floor(diffHours % 24);
    return remainingHours > 0
      ? `⏱ ${days}d ${remainingHours}h remaining`
      : `⏱ ${days} day${days === 1 ? '' : 's'} remaining`;
  }

  if (diffHours > 0) {
    const hours = Math.floor(diffHours);
    const mins = Math.floor((diffHours - hours) * 60);
    if (hours === 0) return `⚠️ Delivery due in ${mins} minute${mins === 1 ? '' : 's'}`;
    return `⚠️ ${hours}h ${mins > 0 ? `${mins}m ` : ''}remaining`;
  }

  // Overdue
  const overdueHours = Math.abs(Math.floor(diffHours));
  if (overdueHours < 24) return `🔴 Overdue by ${overdueHours} hour${overdueHours === 1 ? '' : 's'}`;
  const overdueDays = Math.floor(overdueHours / 24);
  return `🔴 Overdue by ${overdueDays} day${overdueDays === 1 ? '' : 's'}`;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Create a new agreement record. Extracts deadline_days from the description
 * via natural language parsing unless the caller provides an explicit override.
 */
export async function createAgreement(
  input: CreateAgreementInput
): Promise<ServiceAgreementRecord> {
  if (!input.buyerUserId) throw badRequest('buyerUserId is required');
  if (!input.sellerUserId) throw badRequest('sellerUserId is required');
  if (!input.title) throw badRequest('title is required');
  if (!input.amountUsdc || input.amountUsdc <= 0) throw badRequest('amountUsdc must be positive');
  if (!input.network) throw badRequest('network is required');

  const parseResult = parseDeliveryDeadline(input.description || '');
  const deadlineDays = input.deadlineDays ?? parseResult.deadlineDays;

  const now = nowIso();
  const agreement: ServiceAgreementRecord = {
    id: generateId('agr'),
    buyerUserId: input.buyerUserId,
    sellerUserId: input.sellerUserId,
    title: input.title,
    description: input.description || '',
    amountUsdc: input.amountUsdc,
    currency: input.currency || 'usdc',
    network: input.network,
    status: 'pending_payment',
    deadlineDays,
    deliveryDueAt: null,
    reminder6hSent: false,
    overdueNoticeSent: false,
    fundedAt: null,
    deliveredAt: null,
    releasedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  await db.insertServiceAgreement(agreement);
  return agreement;
}

/**
 * Mark an agreement as funded and compute the delivery due timestamp.
 * delivery_due_at = now + deadlineDays calendar days.
 */
export async function fundAgreement(agreementId: string): Promise<ServiceAgreementRecord> {
  const existing = await db.findServiceAgreementById(agreementId);
  if (!existing) throw notFound(`Service agreement ${agreementId}`);
  if (existing.status !== 'pending_payment') {
    throw badRequest(`Agreement ${agreementId} is already ${existing.status}; cannot fund`);
  }

  const now = new Date();
  const dueAt = new Date(now.getTime() + existing.deadlineDays * 24 * 60 * 60 * 1000);

  const updated: ServiceAgreementRecord = {
    ...existing,
    status: 'funded',
    fundedAt: now.toISOString(),
    deliveryDueAt: dueAt.toISOString(),
    updatedAt: now.toISOString(),
  };

  await db.updateServiceAgreement(updated);
  return updated;
}

/**
 * Seller signals they have started work. Optional intermediate state.
 */
export async function startDelivery(agreementId: string): Promise<ServiceAgreementRecord> {
  const existing = await db.findServiceAgreementById(agreementId);
  if (!existing) throw notFound(`Service agreement ${agreementId}`);
  if (existing.status !== 'funded') {
    throw badRequest(`Agreement ${agreementId} must be funded to start delivery; current: ${existing.status}`);
  }

  const updated: ServiceAgreementRecord = {
    ...existing,
    status: 'in_delivery',
    updatedAt: nowIso(),
  };
  await db.updateServiceAgreement(updated);
  return updated;
}

/**
 * Seller marks delivery submitted.
 */
export async function markDelivered(agreementId: string): Promise<ServiceAgreementRecord> {
  const existing = await db.findServiceAgreementById(agreementId);
  if (!existing) throw notFound(`Service agreement ${agreementId}`);
  if (existing.status !== 'funded' && existing.status !== 'in_delivery') {
    throw badRequest(`Agreement ${agreementId} cannot be marked delivered from ${existing.status}`);
  }

  const now = nowIso();
  const updated: ServiceAgreementRecord = {
    ...existing,
    status: 'delivered',
    deliveredAt: now,
    updatedAt: now,
  };
  await db.updateServiceAgreement(updated);
  return updated;
}

/**
 * Buyer approves delivery and releases funds.
 */
export async function releaseAgreement(agreementId: string): Promise<ServiceAgreementRecord> {
  const existing = await db.findServiceAgreementById(agreementId);
  if (!existing) throw notFound(`Service agreement ${agreementId}`);
  if (existing.status !== 'delivered') {
    throw badRequest(`Agreement ${agreementId} must be delivered before release; current: ${existing.status}`);
  }

  const now = nowIso();
  const updated: ServiceAgreementRecord = {
    ...existing,
    status: 'released',
    releasedAt: now,
    updatedAt: now,
  };
  await db.updateServiceAgreement(updated);
  return updated;
}

/**
 * Cancel an agreement. Allowed from any pre-release active status.
 */
export async function cancelAgreement(agreementId: string): Promise<ServiceAgreementRecord> {
  const existing = await db.findServiceAgreementById(agreementId);
  if (!existing) throw notFound(`Service agreement ${agreementId}`);

  const terminalStatuses: ServiceAgreementStatus[] = ['released', 'cancelled', 'disputed'];
  if (terminalStatuses.includes(existing.status)) {
    throw badRequest(`Agreement ${agreementId} is already ${existing.status}; cannot cancel`);
  }

  const updated: ServiceAgreementRecord = {
    ...existing,
    status: 'cancelled',
    updatedAt: nowIso(),
  };
  await db.updateServiceAgreement(updated);
  return updated;
}

/**
 * Get a single agreement by id. Returns null if not found.
 */
export async function getAgreement(agreementId: string): Promise<ServiceAgreementRecord | null> {
  return db.findServiceAgreementById(agreementId);
}
