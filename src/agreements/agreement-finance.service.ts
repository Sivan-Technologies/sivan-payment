/**
 * Money-side helpers for service agreements: the Sivan fee wallet resolver and
 * the human countdown label shown against a deadline.
 *
 * Extracted verbatim from agreement.service.ts as part of the god-service
 * split (FUTURE_BUILD_GOD_SERVICE_SPLIT.md Part 2). No logic changes.
 */
import type { WalletChain, ServiceAgreementRecord } from '../database/types.js';

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
  if (agreement.status === 'declined') return '❌ Declined by seller';
  if (agreement.status === 'disputed') return '⚠️ In dispute';

  if (!agreement.deliveryDueAt) {
    if (agreement.status === 'pending_seller_acceptance') return '⏳ Awaiting seller acceptance';
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

/**
 * Resolves Sivan's protocol fee collection wallet for service agreements per network.
 */
export function getSivanServiceAgreementFeeWallet(network: string): string {
  const n = (network || '').toLowerCase().trim();
  if (n === 'solana') {
    return process.env.SIVAN_FEE_WALLET_SOLANA?.trim() || '';
  }
  if (n === 'stellar') {
    return process.env.SIVAN_FEE_WALLET_STELLAR?.trim() || process.env.STELLAR_DISTRIBUTION_PUBLIC_KEY?.trim() || '';
  }
  if (n === 'celo') {
    return process.env.SIVAN_FEE_WALLET_CELO?.trim() || process.env.SIVAN_CELO_FEE_WALLET?.trim() || '0xd62D8aD1EE242745959221b5d020FAf20b41d14A';
  }
  // Base, BSC, and general EVM
  return process.env.SIVAN_FEE_WALLET_EVM?.trim() || process.env.SIVAN_FEE_WALLET_BASE?.trim() || process.env.EVM_VAULT_ADDRESS?.trim() || process.env.EVM_SETTLEMENT_ROUTER_ADDRESS?.trim() || '';
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────
