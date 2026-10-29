/**
 * DELIVERY DEADLINE SWEEPER
 *
 * Background service that fires proactive countdown notifications for active
 * service agreements. Registered in server.ts as a setInterval loop, controlled
 * by the DEADLINE_SWEEP_SECONDS env var (default: 300 seconds / 5 minutes).
 *
 * EXACTLY-ONCE DELIVERY — two sentinel column pattern:
 *
 *   reminder_6h_sent    — atomic UPDATE ... WHERE reminder_6h_sent = false.
 *                         Two overlapping ticks race; Postgres serialises them;
 *                         the loser matches zero rows and skips the send.
 *
 *   overdue_notice_sent — same pattern for the overdue notice.
 *
 * NOTIFICATION CHANNELS:
 *   Email is dispatched on this layer. Telegram and WhatsApp gateways receive
 *   the same event over their own internal dispatch mechanism when those
 *   integrations are live. For now, email is the only channel wired here;
 *   the sentinel flag ensures no double-send even when the gateway is added.
 *
 * FAILURE SEMANTICS:
 *   Same as the deposit notifier: the sentinel flag is SET BEFORE the send.
 *   A crash between the claim and the send loses that one notification —
 *   acceptable. Sending before claiming could duplicate on retry — not acceptable
 *   for a "delivery overdue" alert that reads like the agreement is broken.
 */

import { db } from '../database/json-database.js';
import { sendEmail, buildSivanBrandedEmail } from '../notifications/email.service.js';
import { env } from '../config/env.js';
import { cancelAgreement } from './agreement.service.js';

export interface DeadlineSweepOutcome {
  considered: number;
  sent6h: number;
  sentOverdue: number;
  expiredCancelled: number;
  failed: number;
}

function hoursRemaining(deliveryDueAt: string, now = new Date()): number {
  const dueMs = new Date(deliveryDueAt).getTime();
  return (dueMs - now.getTime()) / (1000 * 60 * 60);
}

function fmt6hWarning(agreementId: string, sellerName: string): { subject: string; text: string; html: string } {
  const subject = `⚠️ 6 hours left to deliver — Agreement ${agreementId}`;
  const text =
    `Hi ${sellerName},\n\n` +
    `You have 6 hours remaining to submit delivery for service agreement ${agreementId}.\n\n` +
    `Please submit your deliverables before the deadline to avoid a dispute.\n\n` +
    `Sivan Payment Ai`;
  const html = buildSivanBrandedEmail({
    eyebrow: 'Delivery Deadline Reminder',
    title: '6 Hours Remaining',
    intro: `You have 6 hours remaining to submit delivery for agreement ${agreementId}. Please submit your deliverables before the deadline to avoid a dispute.`,
    ctaLabel: 'View Agreement',
    ctaUrl: `${(env.CUSTOMER_APP_URL || 'https://app.sivantech.online').replace(/\/$/, '')}/agreements/${agreementId}`,
  });
  return { subject, text, html };
}

function fmtOverdueNotice(
  agreementId: string,
  sellerName: string,
  buyerName: string,
  sellerEmail: string | undefined,
  buyerEmail: string | undefined
): Array<{ to: string; subject: string; text: string; html: string }> {
  const messages: Array<{ to: string; subject: string; text: string; html: string }> = [];
  const appBase = (env.CUSTOMER_APP_URL || 'https://app.sivantech.online').replace(/\/$/, '');

  if (sellerEmail) {
    const subject = `🔴 Delivery deadline passed — Agreement ${agreementId}`;
    const text =
      `Hi ${sellerName},\n\n` +
      `The delivery deadline for agreement ${agreementId} has passed.\n\n` +
      `The buyer can now extend the deadline or request mutual cancellation.\n\n` +
      `Sivan Payment Ai`;
    messages.push({
      to: sellerEmail,
      subject,
      text,
      html: buildSivanBrandedEmail({
        eyebrow: 'Delivery Overdue',
        title: 'Deadline Passed',
        intro: `The delivery deadline for agreement ${agreementId} has passed. The buyer can now extend the deadline or request mutual cancellation.`,
        ctaLabel: 'View Agreement',
        ctaUrl: `${appBase}/agreements/${agreementId}`,
      }),
    });
  }

  if (buyerEmail) {
    const subject = `🔴 Delivery overdue — Agreement ${agreementId}`;
    const text =
      `Hi ${buyerName},\n\n` +
      `The delivery deadline for your agreement ${agreementId} has passed.\n\n` +
      `You can extend the deadline or request mutual cancellation from your dashboard.\n\n` +
      `Sivan Payment Ai`;
    messages.push({
      to: buyerEmail,
      subject,
      text,
      html: buildSivanBrandedEmail({
        eyebrow: 'Delivery Overdue',
        title: 'Deadline Passed',
        intro: `The delivery deadline for agreement ${agreementId} has passed. You can extend the deadline or request mutual cancellation from your dashboard.`,
        ctaLabel: 'View Agreement',
        ctaUrl: `${appBase}/agreements/${agreementId}`,
      }),
    });
  }

  return messages;
}

/**
 * Main sweeper tick. Called by the setInterval in server.ts.
 * Returns a summary object for structured logging.
 */
export async function sweepDeadlineAlerts(
  limit = 100,
  now = new Date()
): Promise<DeadlineSweepOutcome> {
  const outcome: DeadlineSweepOutcome = { considered: 0, sent6h: 0, sentOverdue: 0, expiredCancelled: 0, failed: 0 };

  // ── Auto-cancel unaccepted agreements past 48-hour acceptance window ──────
  try {
    const expired = await db.listExpiredPendingAcceptanceAgreements(now, limit);
    for (const agr of expired) {
      try {
        await cancelAgreement(agr.id, {
          reason: 'Agreement auto-cancelled: seller did not accept within 48 hours',
        });
        outcome.expiredCancelled += 1;
      } catch (cancelErr) {
        console.warn(`[sweepDeadlineAlerts] Failed to auto-cancel expired agreement ${agr.id}:`, cancelErr);
        outcome.failed += 1;
      }
    }
  } catch (err) {
    console.warn('[sweepDeadlineAlerts] Failed to query expired agreements:', err);
  }

  const active = await db.listActiveAgreementsForDeadlineSweep(limit);
  outcome.considered = active.length;

  for (const agreement of active) {
    if (!agreement.deliveryDueAt) continue;

    const hours = hoursRemaining(agreement.deliveryDueAt, now);

    // ── 6-hour warning ──────────────────────────────────────────────────────
    if (hours <= 6 && hours > 0 && !agreement.reminder6hSent) {
      // CLAIM FIRST — prevents duplicate on concurrent ticks.
      const claimed = await db.markAgreementReminder6hSent(agreement.id);
      if (!claimed) continue;

      try {
        const seller = await db.findUserById(agreement.sellerUserId);
        if (seller?.email) {
          const msg = fmt6hWarning(agreement.id, seller.fullName || 'there');
          await sendEmail({ to: seller.email, subject: msg.subject, text: msg.text, html: msg.html });
        }
        outcome.sent6h += 1;
      } catch {
        // Logged by the caller (server.ts); claim is NOT rolled back.
        outcome.failed += 1;
      }
      continue;
    }

    // ── Overdue notice ───────────────────────────────────────────────────────
    if (hours <= 0 && !agreement.overdueNoticeSent) {
      const claimed = await db.markAgreementOverdueNoticeSent(agreement.id);
      if (!claimed) continue;

      try {
        const [seller, buyer] = await Promise.all([
          db.findUserById(agreement.sellerUserId),
          db.findUserById(agreement.buyerUserId),
        ]);

        const messages = fmtOverdueNotice(
          agreement.id,
          seller?.fullName || 'Seller',
          buyer?.fullName || 'Buyer',
          seller?.email,
          buyer?.email
        );

        for (const msg of messages) {
          await sendEmail({ to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
        }
        outcome.sentOverdue += 1;
      } catch {
        outcome.failed += 1;
      }
    }
  }

  return outcome;
}
