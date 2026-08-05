import { db } from '../database/json-database.js';
import { sendEmail } from '../notifications/email.service.js';
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
export function depositMessage(deposit: WalletDepositRecord): { subject: string; text: string } {
  const amount = `${deposit.amount} ${deposit.asset}`;
  const network = humanNetwork(deposit.chain);

  if (deposit.status === 'confirmed') {
    return {
      subject: `Deposit confirmed: ${amount}`,
      text:
        `Your deposit of ${amount} on ${network} is confirmed.\n\n` +
        `It is now part of your Sivan balance and you can send or convert it.\n\n` +
        `Sivan`
    };
  }

  return {
    subject: `Deposit received: ${amount}`,
    text:
      `We have seen your deposit of ${amount} on ${network}.\n\n` +
      `It is still being confirmed on the network. We will let you know the ` +
      `moment it completes - this usually takes a few minutes.\n\n` +
      `You do not need to do anything.\n\n` +
      `Sivan`
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
 * Deliver everything owed.
 *
 * In-app delivery needs no work here: the activity feed reads the deposit rows
 * directly, so a deposit is visible the instant it is recorded, whether or not
 * an email ever goes out. This loop is the email channel only. WhatsApp and
 * Telegram slot in beside sendEmail without touching detection or the feed.
 */
export async function notifyPendingDeposits(limit = 50): Promise<NotifyOutcome> {
  const outcome: NotifyOutcome = { considered: 0, sent: 0, skipped: 0, failed: 0 };

  const owed = await db.listUnnotifiedWalletDeposits(limit);
  outcome.considered = owed.length;

  for (const deposit of owed) {
    const user = await db.findUserById(deposit.userId);
    /**
     * No email address is not a failure to retry.
     *
     * A WhatsApp-first user may genuinely have no email. Claim the row anyway,
     * so the notifier does not re-examine it on every tick forever. The feed
     * row is already showing them the deposit; email is one channel of several.
     */
    if (!user?.email) {
      await db.markWalletDepositNotified(deposit.id, nowIso());
      outcome.skipped += 1;
      continue;
    }

    // CLAIM BEFORE SENDING. See the header.
    const claimed = await db.markWalletDepositNotified(deposit.id, nowIso());
    if (!claimed) {
      outcome.skipped += 1;
      continue;
    }

    try {
      const message = depositMessage(deposit);
      await sendEmail({ to: user.email, subject: message.subject, text: message.text });
      outcome.sent += 1;
    } catch {
      /**
       * The claim is NOT rolled back on a send failure.
       *
       * Un-claiming would retry, and a provider that fails after actually
       * delivering - a timeout on the response, say - would then send twice.
       * The deposit is recorded and visible in the app regardless; a failed
       * email is logged by the caller and is not worth risking a duplicate.
       */
      outcome.failed += 1;
    }
  }

  return outcome;
}
