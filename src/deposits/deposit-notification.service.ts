import { db } from '../database/json-database.js';
import { buildSivanBrandedEmail, sendEmail } from '../notifications/email.service.js';
import { nowIso } from '../shared/id.js';
import type { WalletDepositRecord } from '../database/types.js';

/**
 * LAYER 3: TELLING THE USER.
 *
 * Reads WalletDepositRecord and nothing else. It does not know, and must never
 * learn, whether the deposit was found by a poller or a webhook - that is the
 * point of the seam in deposit.service.ts.
 *
 *
 * EXACTLY-ONCE DELIVERY, WITH THE DATABASE AS THE ARBITER.
 *
 * An email cannot be un-sent, so "did I already tell them" has to be answered
 * correctly under concurrency, not approximately. The row is CLAIMED before
 * the send:
 *
 *   markWalletDepositNotified(id, at)  ->  update ... where notified_at is null
 *
 * Two overlapping ticks both attempt it; Postgres serialises them and the
 * second matches zero rows. Only the winner sends.
 *
 * This orders the failure modes deliberately. Claiming first means a crash
 * between the claim and the send loses that one notification. Sending first
 * would mean a crash between the send and the claim sends it AGAIN on the next
 * tick, and repeatedly if the crash recurs. For money notifications a missed
 * message is a support question; a repeated one reads as a double credit or a
 * phishing attempt. Lose the message, never duplicate it.
 */

/**
 * WORDING IS A CORRECTNESS CONCERN HERE, NOT COPYWRITING.
 *
 * A pending deposit has been SEEN on chain but is not final. The message must
 * therefore never say the money is available, spendable, or in their balance -
 * a user who reads "available" and immediately tries to send will hit a
 * rejection they were just told would not happen.
 *
 * Guarded by test:deposit-notification, which fails on the words "available",
 * "spendable" and "ready to spend" appearing in a pending message.
 */
export function depositMessage(deposit: WalletDepositRecord): { subject: string; text: string; html: string } {
  const amount = `${deposit.amount} ${deposit.asset}`;
  const network = humanNetwork(deposit.chain);

  if (deposit.status === 'confirmed') {
    const subject = `Deposit confirmed: ${amount}`;
    const text =
      `Your deposit of ${amount} on ${network} is confirmed.\n\n` +
      `It is now part of your Sivan balance and you can send or convert it.\n\n` +
      `Sivan`;
    return {
      subject,
      text,
      html: buildSivanBrandedEmail({
        eyebrow: 'Deposit confirmed',
        title: `${amount} confirmed`,
        intro: `Your deposit on ${network} has completed and is now reflected in your Sivan balance.`,
        badge: 'Ready to use',
        rows: [
          { label: 'Amount', value: amount },
          { label: 'Network', value: network },
          { label: 'Status', value: 'Confirmed' },
        ],
        ctaLabel: 'Open Sivan',
        ctaUrl: '/dashboard',
        note: 'You can now send, convert, or manage this balance from your Sivan dashboard.'
      })
    };
  }

  const subject = `Deposit received: ${amount}`;
  const text =
    `We have seen your deposit of ${amount} on ${network}.\n\n` +
    `It is still being confirmed on the network. We will let you know the ` +
    `moment it completes - this usually takes a few minutes.\n\n` +
    `You do not need to do anything.\n\n` +
    `Sivan`;
  return {
    subject,
    text,
    html: buildSivanBrandedEmail({
      eyebrow: 'Deposit received',
      title: `${amount} received`,
      intro: `We have seen your deposit on ${network}. It is still confirming on the network and we will update you once it completes.`,
      badge: 'Confirming now',
      rows: [
        { label: 'Amount', value: amount },
        { label: 'Network', value: network },
        { label: 'Status', value: 'Confirming' },
      ],
      ctaLabel: 'View activity',
      ctaUrl: '/transactions',
      note: 'No action is needed. A received deposit is visible in Sivan, but it is not final until it is confirmed.'
    })
  };
}

/**
 * Chain ids are internal strings. 'base' in an email to a customer looks like a
 * typo; casing matters too - a rendered screenshot caught "Sending on solana"
 * once already.
 */
export function humanNetwork(chain: string): string {
  const map: Record<string, string> = {
    base: 'Base',
    ethereum: 'Ethereum',
    solana: 'Solana',
    polygon: 'Polygon',
    arbitrum: 'Arbitrum',
    avalanche_c_chain: 'Avalanche'
  };
  return map[chain] ?? chain.replaceAll('_', ' ');
}

export interface NotifyOutcome {
  considered: number;
  sent: number;
  /** Claimed by another worker, or already notified. Not an error. */
  skipped: number;
  failed: number;
}

/**
 * Deliver Telegram deposit notification if user has linked Telegram.
 */
export async function notifyTelegramDeposit(userId: string, deposit: WalletDepositRecord): Promise<void> {
  try {
    const notifyUrl = process.env.TELEGRAM_NOTIFICATION_URL || 'https://telegram.sivantech.online';
    const secret = process.env.NOTIFY_SECRET || process.env.NOTIFICATION_SECRET || 'vDhsV0u8QLu-DhMP8muxUxp4XLk5I8TtaqXa9oO-ErU';

    const links = await db.listCustomerIdentityLinks();
    const telegramLink = links.find((l) => l.paymentUserId === userId && l.status === 'linked' && l.telegramUserId);
    if (!telegramLink?.telegramUserId) return;

    const prefs = await db.getUserPreferencesRecord(userId);
    if (prefs && prefs.telegramNotificationsEnabled === false) return;

    const amount = `${deposit.amount} ${deposit.asset}`;
    const network = humanNetwork(deposit.chain);
    const text = deposit.status === 'confirmed'
      ? `💰 Deposit Confirmed: ${amount} on ${network} has settled into your Sivan balance.`
      : `⏳ Deposit Detected: ${amount} on ${network} is currently confirming on-chain.`;

    await fetch(`${notifyUrl.replace(/\/$/, '')}/api/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-notify-secret': secret,
      },
      body: JSON.stringify({
        telegramId: telegramLink.telegramUserId,
        message: text,
      }),
    });
  } catch {
    // Non-blocking notification enhancement
  }
}

/**
 * Deliver everything owed.
 *
 * In-app delivery needs no work here: the activity feed reads the deposit rows
 * directly, so a deposit is visible the instant it is recorded, whether or not
 * an email ever goes out. Email and Telegram notifications dispatch beside each
 * other without touching detection or the feed.
 */
export async function notifyPendingDeposits(limit = 50): Promise<NotifyOutcome> {
  const outcome: NotifyOutcome = { considered: 0, sent: 0, skipped: 0, failed: 0 };

  const owed = await db.listUnnotifiedWalletDeposits(limit);
  outcome.considered = owed.length;

  for (const deposit of owed) {
    const user = await db.findUserById(deposit.userId);

    // CLAIM BEFORE SENDING. See the header.
    const claimed = await db.markWalletDepositNotified(deposit.id, nowIso());
    if (!claimed) {
      outcome.skipped += 1;
      continue;
    }

    // Deliver Telegram notification if linked & enabled
    void notifyTelegramDeposit(deposit.userId, deposit);

    if (!user?.email) {
      outcome.skipped += 1;
      continue;
    }

    try {
      const message = depositMessage(deposit);
      await sendEmail({ to: user.email, subject: message.subject, text: message.text, html: message.html });
      outcome.sent += 1;
    } catch {
      outcome.failed += 1;
    }
  }

  return outcome;
}
