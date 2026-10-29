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
    arc: 'Arc',
    celo: 'Celo',
    bsc: 'BNB Chain',
    bnb: 'BNB Chain',
    stellar: 'Stellar',
    avalanche_c_chain: 'Avalanche',
    starknet: 'Starknet',
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

const notifiedDepositCache = new Set<string>();

export function shouldNotifyDepositOnce(channel: string, depositId: string): boolean {
  const key = `${channel}:${depositId}`;
  if (notifiedDepositCache.has(key)) return false;
  if (notifiedDepositCache.size > 5000) {
    notifiedDepositCache.clear();
  }
  notifiedDepositCache.add(key);
  return true;
}

/**
 * Deliver Telegram deposit notification if user has linked Telegram.
 */
export async function notifyTelegramDeposit(userId: string, deposit: WalletDepositRecord): Promise<void> {
  try {
    // Only send Deposit Received once confirmed — never send unconfirmed "Deposit Detected"
    if (deposit.status !== 'confirmed') {
      return;
    }

    if (!shouldNotifyDepositOnce('telegram', deposit.id)) {
      return;
    }

    // Ignore synthetic or test users during background sweeps
    if (
      userId.startsWith('usr_dev_') ||
      userId.startsWith('usr_test_') ||
      userId.includes('mock') ||
      userId.includes('test_agent') ||
      userId.includes('buyer_test') ||
      userId.includes('seller_test')
    ) {
      return;
    }

    const isLive = process.env.NODE_ENV === 'production' || process.env.DATABASE_MODE === 'live';
    const gatewayUrl = (
      process.env.CORE_API_BASE_URL ||
      process.env.API_GATEWAY_URL ||
      process.env.PUBLIC_API_GATEWAY_URL ||
      (isLive ? 'https://api.sivantech.online' : 'https://api-staging.sivantech.online')
    ).replace(/\/$/, '');
    const defaultUrl = `${gatewayUrl}/api/telegram`;
    const rawTgUrl = process.env.TELEGRAM_NOTIFICATION_URL || defaultUrl;
    const notifyUrl = rawTgUrl.endsWith('/api/notify') ? rawTgUrl : `${rawTgUrl.replace(/\/$/, '')}/api/notify`;
    const secret = process.env.NOTIFY_SECRET || process.env.NOTIFICATION_SECRET || process.env.CORE_API_SECRET;
    if (!notifyUrl || !secret) {
      return;
    }

    const user = await db.findUserById(userId);
    let targetTelegramId: string | null = null;

    const links = await db.listCustomerIdentityLinks();
    const activeLinks = links
      .filter((l) => l.paymentUserId === userId && l.status === 'linked' && Boolean(l.telegramUserId))
      .sort((a, b) => (b.linkedAt || b.createdAt || '').localeCompare(a.linkedAt || a.createdAt || ''));

    if (activeLinks[0]?.telegramUserId) {
      targetTelegramId = activeLinks[0].telegramUserId;
    } else if (user?.telegramUserId) {
      targetTelegramId = user.telegramUserId;
    } else {
      const { resolveTelegramIdForAgreement } = await import('../agreements/agreement-identity.service.js');
      targetTelegramId = await resolveTelegramIdForAgreement(userId);
    }

    if (!targetTelegramId) return;

    // Verify this Telegram ID has not been superseded by a newer link to a different user
    const allLinksForTg = links
      .filter((l) => l.telegramUserId === targetTelegramId && l.status === 'linked')
      .sort((a, b) => (b.linkedAt || b.createdAt || '').localeCompare(a.linkedAt || a.createdAt || ''));

    if (allLinksForTg.length > 0 && allLinksForTg[0].paymentUserId !== userId) {
      return;
    }

    const prefs = await db.getUserPreferencesRecord(userId);
    if (prefs && prefs.telegramNotificationsEnabled === false) return;

    const recipientName = user?.fullName || (user?.username ? `@${user.username}` : (user?.email ? user.email : 'your account'));
    const amount = `${deposit.amount} ${deposit.asset.toUpperCase()}`;
    const network = humanNetwork(deposit.chain);

    let spendableFormatted = `$${Number(deposit.amount).toFixed(2)}`;
    try {
      const { getUnifiedBalance } = await import('../balances/unified-balance.service.js');
      const unified = await getUnifiedBalance(userId);
      const isNgn = deposit.asset.toLowerCase() === 'ngn';
      const assetBal = unified.balances.find((b) => b.asset.toLowerCase() === deposit.asset.toLowerCase());
      if (assetBal) {
        const val = Number(assetBal.spendable || 0);
        spendableFormatted = isNgn ? `₦${val.toLocaleString()}` : `$${val.toFixed(2)}`;
      }
    } catch {
      // fallback
    }

    const text = `✅ Deposit Received\n\n${amount} on ${network} has arrived for ${recipientName}.\n\nStatus: Confirmed\nSpendable Balance: ${spendableFormatted}\n\nWhat would you like to do?\n• Reply TRANSFER to send\n• Reply CASHOUT to withdraw to bank\n• Reply AGREEMENT to fund a Service agreement`;

    const depositKeyboard = [
      [
        { text: '💸 Transfer', callback_data: 'v1:transfer' },
        { text: '🏦 Cashout', callback_data: 'v1:cashout' },
        { text: '🤝 Agreement', callback_data: 'v1:agreement' },
      ],
      [
        { text: '💰 View Balance', callback_data: 'v1:balance' },
        { text: '🏠 Main Menu', callback_data: 'v1:menu' },
      ],
    ];

    await fetch(notifyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-notify-secret': secret,
        'x-target-service': 'telegram',
      },
      body: JSON.stringify({
        telegramId: targetTelegramId,
        message: text,
        keyboard: depositKeyboard,
      }),
    });
  } catch {
    // Non-blocking notification enhancement
  }
}

/**
 * Deliver WhatsApp deposit notification if user has linked WhatsApp.
 */
export async function notifyWhatsAppDeposit(userId: string, deposit: WalletDepositRecord): Promise<void> {
  try {
    // Only send Deposit Received once confirmed — never send unconfirmed "Deposit Detected"
    if (deposit.status !== 'confirmed') {
      return;
    }

    if (!shouldNotifyDepositOnce('whatsapp', deposit.id)) {
      return;
    }

    if (
      userId.startsWith('usr_dev_') ||
      userId.startsWith('usr_test_') ||
      userId.includes('mock') ||
      userId.includes('test_agent') ||
      userId.includes('buyer_test') ||
      userId.includes('seller_test')
    ) {
      return;
    }

    const isLive = process.env.NODE_ENV === 'production' || process.env.DATABASE_MODE === 'live';
    const gatewayUrl = (
      process.env.CORE_API_BASE_URL ||
      process.env.API_GATEWAY_URL ||
      process.env.PUBLIC_API_GATEWAY_URL ||
      (isLive ? 'https://api.sivantech.online' : 'https://api-staging.sivantech.online')
    ).replace(/\/$/, '');
    const defaultUrl = `${gatewayUrl}/api/whatsapp`;
    const rawWaUrl = process.env.WHATSAPP_NOTIFICATION_URL || process.env.WHATSAPP_BOT_URL || defaultUrl;
    if (!rawWaUrl) return;

    const secret = process.env.NOTIFY_SECRET || process.env.NOTIFICATION_SECRET || process.env.CORE_API_SECRET;
    if (!secret) return;

    const user = await db.findUserById(userId);
    let targetPhone = user?.whatsappNumber;
    if (!targetPhone) {
      const links = await db.listCustomerIdentityLinks();
      const activeWa = links
        .filter((l) => l.paymentUserId === userId && l.status === 'linked' && Boolean(l.whatsappNumber))
        .sort((a, b) => (b.linkedAt || b.createdAt || '').localeCompare(a.linkedAt || a.createdAt || ''));
      targetPhone = activeWa[0]?.whatsappNumber;
    }
    if (!targetPhone && user?.email && /^\+?\d{10,14}$/.test(user.email.split('@')[0])) {
      targetPhone = `+${user.email.split('@')[0].replace(/\D/g, '')}`;
    }
    if (!targetPhone) return;

    const prefs = await db.getUserPreferencesRecord(userId);
    if (prefs && (prefs as any).whatsappNotificationsEnabled === false) return;


    const recipientName = user?.fullName || (user?.username ? `@${user.username}` : (user?.email ? user.email : 'your account'));
    const amount = `${deposit.amount} ${deposit.asset.toUpperCase()}`;
    const network = humanNetwork(deposit.chain);

    let spendableFormatted = `$${Number(deposit.amount).toFixed(2)}`;
    try {
      const { getUnifiedBalance } = await import('../balances/unified-balance.service.js');
      const unified = await getUnifiedBalance(userId);
      const isNgn = deposit.asset.toLowerCase() === 'ngn';
      const assetBal = unified.balances.find((b) => b.asset.toLowerCase() === deposit.asset.toLowerCase());
      if (assetBal) {
        const val = Number(assetBal.spendable || 0);
        spendableFormatted = isNgn ? `₦${val.toLocaleString()}` : `$${val.toFixed(2)}`;
      }
    } catch {
      // fallback
    }

    const text = `✅ Deposit Received\n\n${amount} on ${network} has arrived for ${recipientName}.\n\nStatus: Confirmed\nSpendable Balance: ${spendableFormatted}\n\nWhat would you like to do?\n• Reply TRANSFER to send\n• Reply CASHOUT to withdraw to bank\n• Reply AGREEMENT to fund a Service agreement`;


    const formattedRecipient = targetPhone.startsWith('whatsapp:')
      ? targetPhone
      : `whatsapp:${targetPhone.startsWith('+') ? targetPhone : `+${targetPhone.replace(/\D/g, '')}`}`;

    const waNotifyUrl = rawWaUrl.endsWith('/api/notify') ? rawWaUrl : `${rawWaUrl.replace(/\/$/, '')}/api/notify`;
    const requestBody: Record<string, any> = {
      to: formattedRecipient,
      message: text,
      menuCard: {
        body: text,
        actions: [
          { id: 'act_transfer', title: '💸 Transfer', action: 'TRANSFER' },
          { id: 'act_cashout', title: '🏦 Cashout', action: 'CASHOUT' },
          { id: 'act_agreement', title: '🤝 Agreement', action: 'AGREEMENT' },
        ],
      },
    };

    const resp = await fetch(waNotifyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-notify-secret': secret,
        'x-target-service': 'whatsapp-bot',
      },
      body: JSON.stringify(requestBody),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error(`WhatsApp deposit notify failed [${resp.status}]: ${errText}`);
    } else {
      console.log(`WhatsApp deposit notify delivered successfully to ${formattedRecipient}`);
    }
  } catch (err: any) {
    console.error('WhatsApp deposit notification error:', err?.message || err);
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

    // Deliver WhatsApp notification if linked & enabled
    void notifyWhatsAppDeposit(deposit.userId, deposit);

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

/**
 * NGN DVA DEPOSIT NOTIFICATION — STANDALONE, DO NOT MERGE WITH CRYPTO PATH.
 *
 * Called directly from paystackWebhookHandler after a charge.success DVA event
 * is fully processed and the balance ledger has been credited. This function
 * has no dependency on WalletDepositRecord because NGN DVA deposits do not
 * produce one — they go through VirtualAccountTransactionRecord instead.
 *
 * notifyWhatsAppDeposit and notifyTelegramDeposit must NOT be called for NGN
 * DVA deposits. Those functions serve crypto wallet deposits exclusively.
 * Merging the two paths would either break the crypto notification format or
 * require NGN-specific conditionals inside the crypto function, both of which
 * are worse than this clean separation.
 *
 * Sender name and bank come from Paystack's authorization.sender_name and
 * authorization.sender_bank fields on the charge.success payload — real NIBSS
 * data, not inferred. They are optional; the notification degrades cleanly if
 * absent.
 */
export async function notifyNgnDvaDeposit(
  userId: string,
  grossNgn: number,
  reference: string,
  senderName?: string,
  senderBank?: string,
): Promise<void> {
  try {
    // Idempotency: fire once per Paystack reference across all channels
    if (!shouldNotifyDepositOnce('ngn_dva', reference)) return;

    // Skip synthetic and test users
    if (
      userId.startsWith('usr_dev_') ||
      userId.startsWith('usr_test_') ||
      userId.includes('mock') ||
      userId.includes('test_agent') ||
      userId.includes('buyer_test') ||
      userId.includes('seller_test')
    ) {
      return;
    }

    const isLive = process.env.NODE_ENV === 'production' || process.env.DATABASE_MODE === 'live';
    const gatewayUrl = (
      process.env.CORE_API_BASE_URL ||
      process.env.API_GATEWAY_URL ||
      process.env.PUBLIC_API_GATEWAY_URL ||
      (isLive ? 'https://api.sivantech.online' : 'https://api-staging.sivantech.online')
    ).replace(/\/$/, '');
    const secret = process.env.NOTIFY_SECRET || process.env.NOTIFICATION_SECRET || process.env.CORE_API_SECRET;
    if (!secret) return;

    const user = await db.findUserById(userId);
    if (!user) return;

    // Fetch total NGN spendable balance after the deposit has been credited to the ledger
    const amountFormatted = `₦${grossNgn.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    let spendableFormatted = amountFormatted;
    try {
      const { getUnifiedBalance } = await import('../balances/unified-balance.service.js');
      const unified = await getUnifiedBalance(userId);
      const ngnBal = unified.balances.find((b) => b.asset.toLowerCase() === 'ngn');
      if (ngnBal) {
        const val = Number(ngnBal.spendable || 0);
        spendableFormatted = `₦${val.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      }
    } catch {
      // fallback: show deposit amount as the balance estimate
    }

    // Build sender display — title-case name, short bank name only
    const toTitleCase = (str: string) =>
      str.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

    // Shorten bank name: strip long legal suffixes, keep recognisable short form
    const shortenBank = (bank: string): string => {
      // If the bank string already contains a short name in parentheses e.g.
      // "OPay Digital Services Limited (OPay)" — extract that inner short name
      const inner = bank.match(/\(([^)]+)\)\s*$/);
      if (inner) return inner[1].trim();
      // Otherwise strip common Nigerian legal suffixes
      return bank
        .replace(/\s*(Digital Services Limited|Digital Services|Financial Services Limited|Microfinance Bank|Commercial Bank|Bank Nigeria|Nigeria Limited|Limited)\s*/gi, '')
        .trim();
    };

    const senderDisplay = senderName ? toTitleCase(senderName) : '';
    const bankDisplay   = senderBank ? shortenBank(senderBank) : '';

    const fromLine = senderDisplay
      ? `From: ${senderDisplay}${bankDisplay ? ` (${bankDisplay})` : ''}\n`
      : '';

    const refLine = reference ? `Ref: ${reference}\n` : '';

    // Information body (used as the WhatsApp menuCard header and Telegram message)
    const bodyText =
      `✅ Deposit from Bank\n\n` +
      `${amountFormatted} has arrived.\n\n` +
      `${fromLine}` +
      `${refLine}` +
      `Balance: ${spendableFormatted}`;

    // Full prompt text (fallback for plain-text channels without button support)
    const promptText =
      `${bodyText}\n\n` +
      `Withdraw to Bank . Transfer . Pay Bills`;

    // ── WhatsApp ──────────────────────────────────────────────────────────────
    void (async () => {
      try {
        let targetPhone = user.whatsappNumber;
        if (!targetPhone) {
          const links = await db.listCustomerIdentityLinks();
          const activeWa = links
            .filter((l) => l.paymentUserId === userId && l.status === 'linked' && Boolean(l.whatsappNumber))
            .sort((a, b) => (b.linkedAt || b.createdAt || '').localeCompare(a.linkedAt || a.createdAt || ''));
          targetPhone = activeWa[0]?.whatsappNumber;
        }
        if (!targetPhone) return;

        const prefs = await db.getUserPreferencesRecord(userId);
        if (prefs && (prefs as any).whatsappNotificationsEnabled === false) return;

        const rawWaUrl =
          process.env.WHATSAPP_NOTIFICATION_URL ||
          process.env.WHATSAPP_BOT_URL ||
          `${gatewayUrl}/api/whatsapp`;
        const waNotifyUrl = rawWaUrl.endsWith('/api/notify')
          ? rawWaUrl
          : `${rawWaUrl.replace(/\/$/, '')}/api/notify`;

        const formattedPhone = targetPhone.startsWith('whatsapp:')
          ? targetPhone
          : `whatsapp:${targetPhone.startsWith('+') ? targetPhone : `+${targetPhone.replace(/\D/g, '')}`}`;

        const resp = await fetch(waNotifyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-notify-secret': secret,
            'x-target-service': 'whatsapp-bot',
          },
          body: JSON.stringify({
            to: formattedPhone,
            message: promptText,
            menuCard: {
              body: bodyText,
              actions: [
                { id: 'act_cashout', title: '🏧 Withdraw to Bank', action: 'CASHOUT' },
                { id: 'act_transfer', title: '💸 Transfer', action: 'TRANSFER' },
                { id: 'act_utility', title: '⚡ Pay Bills', action: 'UTILITY' },
              ],
            },
          }),
        });
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          console.error(`NGN DVA WhatsApp notify failed [${resp.status}]: ${errText}`);
        } else {
          console.log(`NGN DVA WhatsApp notify delivered to ${formattedPhone} (ref: ${reference})`);
        }
      } catch (err: any) {
        console.error('NGN DVA WhatsApp notification error:', err?.message || err);
      }
    })();

    // ── Telegram ──────────────────────────────────────────────────────────────
    void (async () => {
      try {
        let targetTelegramId: string | null = null;
        const links = await db.listCustomerIdentityLinks();
        const activeLinks = links
          .filter((l) => l.paymentUserId === userId && l.status === 'linked' && Boolean(l.telegramUserId))
          .sort((a, b) => (b.linkedAt || b.createdAt || '').localeCompare(a.linkedAt || a.createdAt || ''));

        if (activeLinks[0]?.telegramUserId) {
          targetTelegramId = activeLinks[0].telegramUserId;
        } else if (user.telegramUserId) {
          targetTelegramId = user.telegramUserId;
        }
        if (!targetTelegramId) return;

        // Verify this Telegram ID is still the current owner, not superseded by a newer link
        const allLinksForTg = links
          .filter((l) => l.telegramUserId === targetTelegramId && l.status === 'linked')
          .sort((a, b) => (b.linkedAt || b.createdAt || '').localeCompare(a.linkedAt || a.createdAt || ''));
        if (allLinksForTg.length > 0 && allLinksForTg[0].paymentUserId !== userId) return;

        const prefs = await db.getUserPreferencesRecord(userId);
        if (prefs && prefs.telegramNotificationsEnabled === false) return;

        const rawTgUrl =
          process.env.TELEGRAM_NOTIFICATION_URL ||
          `${gatewayUrl}/api/telegram`;
        const tgNotifyUrl = rawTgUrl.endsWith('/api/notify')
          ? rawTgUrl
          : `${rawTgUrl.replace(/\/$/, '')}/api/notify`;

        await fetch(tgNotifyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-notify-secret': secret,
            'x-target-service': 'telegram',
          },
          body: JSON.stringify({
            telegramId: targetTelegramId,
            message: promptText,
            keyboard: [
              [
                { text: '🏧 Withdraw to Bank', callback_data: 'v1:cashout' },
                { text: '💸 Transfer', callback_data: 'v1:transfer' },
              ],
              [
                { text: '⚡ Pay Bills', callback_data: 'v1:utility' },
                { text: '💰 View Balance', callback_data: 'v1:balance' },
              ],
            ],
          }),
        });
      } catch (err: any) {
        console.error('NGN DVA Telegram notification error:', err?.message || err);
      }
    })();
  } catch (err: any) {
    console.error('NGN DVA deposit notification error:', err?.message || err);
  }
}

/**
 * Dispatches an instant WhatsApp notification when a user's BVN is confirmed
 * by NIBSS and their dedicated Wema Bank virtual account is provisioned.
 */
export async function notifyDvaActivated(
  userId: string,
  account: {
    accountNumber: string;
    bankName: string;
    accountName: string;
  }
): Promise<void> {
  try {
    if (!shouldNotifyDepositOnce('dva_activated', account.accountNumber)) return;

    if (
      userId.startsWith('usr_dev_') ||
      userId.startsWith('usr_test_') ||
      userId.includes('mock') ||
      userId.includes('test_agent') ||
      userId.includes('buyer_test') ||
      userId.includes('seller_test')
    ) {
      return;
    }

    const isLive = process.env.NODE_ENV === 'production' || process.env.DATABASE_MODE === 'live';
    const gatewayUrl = (
      process.env.CORE_API_BASE_URL ||
      process.env.API_GATEWAY_URL ||
      process.env.PUBLIC_API_GATEWAY_URL ||
      (isLive ? 'https://api.sivantech.online' : 'https://api-staging.sivantech.online')
    ).replace(/\/$/, '');
    const secret = process.env.NOTIFY_SECRET || process.env.NOTIFICATION_SECRET || process.env.CORE_API_SECRET;
    if (!secret) return;

    const user = await db.findUserById(userId);
    if (!user) return;

    const bankName = account.bankName || 'Wema Bank';
    const bodyText =
      `🎉 Sivan Virtual Account Activated\n\n` +
      `Your BVN has been verified with NIBSS and your dedicated Nigerian bank account is ready.\n\n` +
      `• Bank . ${bankName}\n` +
      `• Account Number . ${account.accountNumber}\n` +
      `• Account Name . ${account.accountName}\n` +
      `• Status . Active (Instant Credit)\n\n` +
      `Transfer funds from any Nigerian bank app or USSD to instantly fund your Sivan spendable balance.`;

    const promptText = `${bodyText}\n\nType BALANCE to view balance or MENU for all options.`;

    // WhatsApp
    void (async () => {
      try {
        let targetPhone = user.whatsappNumber;
        if (!targetPhone) {
          const links = await db.listCustomerIdentityLinks();
          const activeWa = links
            .filter((l) => l.paymentUserId === userId && l.status === 'linked' && Boolean(l.whatsappNumber))
            .sort((a, b) => (b.linkedAt || b.createdAt || '').localeCompare(a.linkedAt || a.createdAt || ''));
          targetPhone = activeWa[0]?.whatsappNumber;
        }
        if (!targetPhone) return;

        const rawWaUrl =
          process.env.WHATSAPP_NOTIFICATION_URL ||
          process.env.WHATSAPP_BOT_URL ||
          `${gatewayUrl}/api/whatsapp`;
        const waNotifyUrl = rawWaUrl.endsWith('/api/notify')
          ? rawWaUrl
          : `${rawWaUrl.replace(/\/$/, '')}/api/notify`;

        const formattedPhone = targetPhone.startsWith('whatsapp:')
          ? targetPhone
          : `whatsapp:${targetPhone.startsWith('+') ? targetPhone : `+${targetPhone.replace(/\D/g, '')}`}`;

        const resp = await fetch(waNotifyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-notify-secret': secret,
            'x-target-service': 'whatsapp-bot',
          },
          body: JSON.stringify({
            to: formattedPhone,
            message: promptText,
            menuCard: {
              body: bodyText,
              actions: [
                { id: 'balance', title: '📊 View Balance', action: 'balance' },
                { id: 'menu', title: '⚡ Main Menu', action: 'menu' },
              ],
            },
          }),
        });
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          console.error(`DVA activation WhatsApp notify failed [${resp.status}]: ${errText}`);
        } else {
          console.log(`DVA activation WhatsApp notify delivered to ${formattedPhone}`);
        }
      } catch (err: any) {
        console.error('DVA activation WhatsApp notification error:', err?.message || err);
      }
    })();
  } catch (err: any) {
    console.error('DVA activation notification error:', err?.message || err);
  }
}
