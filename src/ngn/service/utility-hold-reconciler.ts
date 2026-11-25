/**
 * UTILITY HOLD AUTO-RECONCILER (1-HOUR STALE HOLD GUARD)
 *
 * Reconciles utility reservations that remained in `pending_reconciliation`
 * for 1 hour or more after an ambiguous provider outcome (timeout / 5xx).
 *
 * Financial safety rules:
 * - Never releases a hold before 1 hour unless an authoritative rejection was already recorded.
 * - Never releases a hold if the provider status lookup fails transiently ('UNKNOWN').
 * - Only releases when the provider confirms FAILED or NOT_FOUND after 1 hour.
 * - Atomically consumes the hold if the provider confirms SUCCESS.
 * - Sends a WhatsApp notification when a user's held balance is restored.
 */

import { db } from '../../database/json-database.js';
import { createBalanceLedgerEntry } from '../../balances/balance.service.js';
import { env } from '../../config/env.js';
import { listActiveSystemIncidents, resolveSystemIncident } from '../../incidents/system-incidents.service.js';
import type { VirtualAccountTransactionRecord } from '../../virtual-accounts/types/virtual-account.types.js';
import { NombaUtilityProvider } from '../provider/nomba-utility.provider.js';

export const UTILITY_HOLD_STALE_MS = 60 * 60 * 1000; // 1 hour

const nombaUtilityProvider = new NombaUtilityProvider();

const SERVICE_LABELS: Record<string, string> = {
  airtime: 'airtime',
  data: 'data bundle',
  electricity: 'electricity',
  cable_tv: 'Cable TV',
  betting: 'betting wallet',
};

function formatServiceLabel(service?: string): string {
  const key = String(service || '').toLowerCase();
  return SERVICE_LABELS[key] || 'utility bill';
}

async function resolveMatchingUtilityIncidents(reservationId: string, summary: string): Promise<void> {
  try {
    const active = await listActiveSystemIncidents();
    const matches = active.filter(
      (inc) =>
        inc.provider === 'utility_aggregator' &&
        (inc.metadata as Record<string, unknown> | undefined)?.reservationId === reservationId
    );
    for (const inc of matches) {
      await resolveSystemIncident(inc.id, {
        actorId: 'utility_hold_reconciler',
        resolutionSummary: summary,
      }).catch(() => null);
    }
  } catch {
    // Non-fatal: incident cleanup should never block ledger reconciliation
  }
}

async function notifyWhatsAppUtilityHoldReleased(params: {
  userId: string;
  amountNgn: number;
  service?: string;
  reservationId: string;
}): Promise<void> {
  try {
    const rawWaUrl = env.WHATSAPP_NOTIFICATION_URL || process.env.WHATSAPP_NOTIFICATION_URL;
    const secret = process.env.NOTIFY_SECRET || process.env.NOTIFICATION_SECRET || process.env.CORE_API_SECRET;
    if (!rawWaUrl || !secret) return;

    const user = await db.findUserById(params.userId).catch(() => null);
    let targetPhone = user?.whatsappNumber;
    if (!targetPhone) {
      const links = await db.listCustomerIdentityLinks().catch(() => []);
      const activeWa = links
        .filter((l) => l.paymentUserId === params.userId && l.status === 'linked' && Boolean(l.whatsappNumber))
        .sort((a, b) => (b.linkedAt || b.createdAt || '').localeCompare(a.linkedAt || a.createdAt || ''));
      targetPhone = activeWa[0]?.whatsappNumber;
    }
    if (!targetPhone) return;

    const amountText = `₦${params.amountNgn.toLocaleString('en-NG', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
    const serviceLabel = formatServiceLabel(params.service);

    const message =
      `⚠️ Payment Outcome . Sivan Payment Ai\n\n` +
      `Your ${amountText} ${serviceLabel} payment could not be completed. Your balance has been fully restored.\n\n` +
      `Ref: ${params.reservationId}`;

    const waNotifyUrl = rawWaUrl.endsWith('/api/notify')
      ? rawWaUrl
      : `${rawWaUrl.replace(/\/$/, '')}/api/notify`;
    const formattedTo = targetPhone.startsWith('whatsapp:')
      ? targetPhone
      : `whatsapp:${targetPhone.startsWith('+') ? targetPhone : `+${targetPhone.replace(/\D/g, '')}`}`;

    await fetch(waNotifyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-notify-secret': secret,
        'x-target-service': 'whatsapp-bot',
      },
      body: JSON.stringify({
        to: formattedTo,
        message,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.warn('[utility_hold_reconciler] Failed to send WhatsApp restoration notice:', err);
  }
}

export async function reconcileStaleUtilityHold(
  tx: VirtualAccountTransactionRecord
): Promise<'released' | 'confirmed' | 'pending'> {
  if (tx.paymentRail !== 'utility_reservation' || tx.status !== ('pending_reconciliation' as any)) {
    return 'pending';
  }

  const raw = (tx.rawPayload || {}) as Record<string, any>;
  const heldAtMs = new Date(String(raw.heldAt || tx.createdAt)).getTime();
  if (!Number.isFinite(heldAtMs) || Date.now() - heldAtMs < UTILITY_HOLD_STALE_MS) {
    return 'pending';
  }

  const merchantTxRef = String(tx.depositReference || raw.idempotencyKey || tx.depositId || '').trim();
  if (!merchantTxRef || !nombaUtilityProvider.isConfigured()) {
    return 'pending';
  }

  const lookup = await nombaUtilityProvider.queryBillTransactionStatus(merchantTxRef);
  const reservationId = tx.depositId;
  const amountNgn = Math.abs(Number(tx.sourceAmount || tx.destinationAmount || 0));
  const nowIso = new Date().toISOString();

  if (lookup.status === 'FAILED' || lookup.status === 'NOT_FOUND') {
    if (tx.userId && amountNgn > 0) {
      await createBalanceLedgerEntry(
        {
          userId: tx.userId,
          asset: 'ngn',
          amount: amountNgn.toFixed(2),
          kind: 'hold_release',
          status: 'completed',
          sourceType: 'utility_reservation',
          sourceId: reservationId,
          description: `Auto-release 1h stale utility hold (${lookup.status}): ${amountNgn} NGN`,
          transferId: `rel_${reservationId}`,
        },
        { actorType: 'system', actorId: tx.userId }
      );
    }

    await db.upsertVirtualAccountTransactionRecord({
      ...tx,
      status: 'failed',
      destinationAmount: '0.00',
      rawPayload: {
        ...raw,
        reconciledAt: nowIso,
        reconciliationAction: 'hold_released_after_1h_provider_check',
        providerLookupStatus: lookup.status,
        providerLookupRaw: lookup.raw,
      },
      updatedAt: nowIso,
    });

    await resolveMatchingUtilityIncidents(
      reservationId,
      `Auto-reconciled after 1h: provider confirmed ${lookup.status}; ${amountNgn} NGN hold released.`
    );

    if (tx.userId && amountNgn > 0) {
      await notifyWhatsAppUtilityHoldReleased({
        userId: tx.userId,
        amountNgn,
        service: raw.service,
        reservationId,
      });
    }

    console.info(
      JSON.stringify({
        worker: 'utility_hold_reconciler',
        action: 'hold_released',
        reservationId,
        merchantTxRef,
        providerStatus: lookup.status,
        amountNgn,
      })
    );
    return 'released';
  }

  if (lookup.status === 'SUCCESS') {
    if (tx.userId && amountNgn > 0) {
      await createBalanceLedgerEntry(
        {
          userId: tx.userId,
          asset: 'ngn',
          amount: amountNgn.toFixed(2),
          kind: 'debit_transfer',
          status: 'completed',
          sourceType: 'utility_reservation',
          sourceId: reservationId,
          description: `Auto-confirmed utility purchase (${raw.service || 'utility'}): ${amountNgn} NGN`,
          transferId: reservationId,
        },
        { actorType: 'system', actorId: tx.userId }
      );
    }

    await db.upsertVirtualAccountTransactionRecord({
      ...tx,
      status: 'completed',
      destinationAmount: '0.00',
      completedAt: nowIso,
      rawPayload: {
        ...raw,
        reconciledAt: nowIso,
        reconciliationAction: 'confirmed_success_by_provider',
        providerLookupStatus: lookup.status,
        providerLookupRaw: lookup.raw,
      },
      updatedAt: nowIso,
    });

    await resolveMatchingUtilityIncidents(
      reservationId,
      `Auto-reconciled after 1h: provider confirmed SUCCESS; ${amountNgn} NGN debit finalized.`
    );

    console.info(
      JSON.stringify({
        worker: 'utility_hold_reconciler',
        action: 'debit_confirmed',
        reservationId,
        merchantTxRef,
        amountNgn,
      })
    );
    return 'confirmed';
  }

  return 'pending';
}
