/**
 * Multi-channel participant notifications for agreement lifecycle events.
 *
 * Extracted verbatim from agreement.service.ts as part of the god-service
 * split (FUTURE_BUILD_GOD_SERVICE_SPLIT.md Part 2). No logic changes.
 */
import { db } from '../database/json-database.js';
import type { ServiceAgreementRecord, UserRecord } from '../database/types.js';
import { resolveTelegramIdForAgreement, resolveWhatsAppPhoneForAgreement } from './agreement-identity.service.js';

/**
 * Fire real-time notifications to the buyer when a service agreement is accepted by the contractor.
 * Alerts buyer that agreement is now awaiting funding and provides direct Pay now / Fund buttons.
 */
export async function notifyAgreementAccepted(
  agreement: ServiceAgreementRecord
): Promise<void> {
  try {
    const telegramUrl = process.env.TELEGRAM_NOTIFICATION_URL;
    const whatsappUrl = process.env.WHATSAPP_NOTIFICATION_URL;
    const secret = process.env.NOTIFY_SECRET || process.env.NOTIFICATION_SECRET;

    if (!secret) return;

    const buyerId = agreement.buyerUserId;
    const sellerId = agreement.sellerUserId;
    const titleSnip = (agreement.title || 'Service Agreement').slice(0, 50);
    const amountStr = `${agreement.amountUsdc} ${(agreement.currency || 'USDC').toUpperCase()}`;
    const networkLabel = agreement.network
      ? (agreement.network.charAt(0).toUpperCase() + agreement.network.slice(1))
      : 'Solana';

    const buyerMsg =
      `✅ Service Agreement Accepted!\n\n` +
      `The contractor has accepted your service agreement:\n` +
      `"${titleSnip}"\n\n` +
      `• Amount: ${amountStr}\n` +
      `• Network: ${networkLabel}\n` +
      `• Ref: ${agreement.id}\n\n` +
      `Your agreement is now ready to be funded. Tap Pay now below to lock funds in the multi-chain vault and start delivery.`;

    const telegramKeyboard = [
      [{ text: '💳 Pay now', callback_data: `v1:pay:${agreement.id}` }],
      [{ text: '🔍 View Status', callback_data: `v1:status:${agreement.id}` }],
      [{ text: '📋 My Agreements', callback_data: 'action:deals' }],
    ];

    // 1. Notify Buyer via Telegram
    if (telegramUrl && buyerId) {
      void (async () => {
        try {
          const tgId = await resolveTelegramIdForAgreement(buyerId);
          await fetch(`${telegramUrl.replace(/\/$/, '')}/api/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-notify-secret': secret },
            body: JSON.stringify({
              telegramId: tgId || undefined,
              phone: tgId ? undefined : buyerId,
              message: buyerMsg,
              keyboard: telegramKeyboard,
            }),
          });
        } catch (e) {
          console.warn('[agreement.notify] Telegram buyer acceptance notification failed:', e);
        }
      })();
    }

    // 2. Notify Buyer via WhatsApp
    if (whatsappUrl && buyerId) {
      void (async () => {
        try {
          const phone = await resolveWhatsAppPhoneForAgreement(buyerId);
          if (phone) {
            const waPhone = phone.startsWith('whatsapp:') ? phone : `whatsapp:${phone}`;
            await fetch(`${whatsappUrl.replace(/\/$/, '')}/api/send`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-notify-secret': secret },
              body: JSON.stringify({ to: waPhone, message: buyerMsg }),
            });
          }
        } catch (e) {
          console.warn('[agreement.notify] WhatsApp buyer acceptance notification failed:', e);
        }
      })();
    }

    // 3. Notify Seller confirmation via Telegram
    if (telegramUrl && sellerId) {
      void (async () => {
        try {
          const tgId = await resolveTelegramIdForAgreement(sellerId);
          if (tgId) {
            const sellerConfirmMsg =
              `✅ Agreement Accepted\n\n` +
              `You have accepted the service agreement:\n` +
              `"${titleSnip}"\n\n` +
              `• Amount: ${amountStr}\n` +
              `• Ref: ${agreement.id}\n\n` +
              `Waiting for client to fund the vault before delivery begins.`;
            await fetch(`${telegramUrl.replace(/\/$/, '')}/api/notify`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-notify-secret': secret },
              body: JSON.stringify({
                telegramId: tgId,
                message: sellerConfirmMsg,
                keyboard: [
                  [{ text: '🔍 View Status', callback_data: `v1:status:${agreement.id}` }],
                  [{ text: '📋 My Agreements', callback_data: 'action:deals' }],
                ],
              }),
            });
          }
        } catch (e) {
          console.warn('[agreement.notify] Telegram seller confirmation failed:', e);
        }
      })();
    }
  } catch (outerErr) {
    console.warn('[agreement.notify] notifyAgreementAccepted outer error:', outerErr);
  }
}

/**
 * Fire real-time cancellation push notifications to both counterparty and actor
 * via Telegram bot and WhatsApp bot.
 *
 * @param agreement  The already-updated (cancelled/declined) agreement record.
 * @param actorRole  'buyer' | 'seller' — who performed the action.
 * @param action     'cancelled' | 'declined' — for message wording.
 * @param reason     Optional free-text reason supplied by the actor.
 */
export async function notifyAgreementCancellation(
  agreement: ServiceAgreementRecord,
  actorRole: 'buyer' | 'seller',
  action: 'cancelled' | 'declined',
  reason?: string | null
): Promise<void> {
  try {
    const telegramUrl = process.env.TELEGRAM_NOTIFICATION_URL;
    const whatsappUrl = process.env.WHATSAPP_NOTIFICATION_URL;
    const secret = process.env.NOTIFY_SECRET || process.env.NOTIFICATION_SECRET;

    if (!secret) return;

    // Determine who to notify: the counterparty of whoever acted.
    const counterpartyId =
      actorRole === 'seller' ? agreement.buyerUserId : agreement.sellerUserId;
    const actorId =
      actorRole === 'seller' ? agreement.sellerUserId : agreement.buyerUserId;

    const actionLabel = action === 'declined' ? 'declined' : 'cancelled';
    const actorLabel = actorRole === 'seller' ? 'The contractor' : 'The client';
    const emoji = action === 'declined' ? '❌' : '🚫';

    const shortId = String(agreement.id).slice(-8).toUpperCase();
    const titleSnip = (agreement.title || 'Service Agreement').slice(0, 50);
    const reasonLine = reason ? `\n\nReason: ${reason.trim()}` : '';

    // Message shown to the counterparty
    const counterpartyMsg =
      `${emoji} Service Agreement ${actionLabel.charAt(0).toUpperCase() + actionLabel.slice(1)}\n\n` +
      `${actorLabel} has ${actionLabel} the service agreement:\n` +
      `"${titleSnip}"` +
      reasonLine +
      `\n\nRef: ${agreement.id}\nNo funds have been charged.\n\nYou can start a new agreement anytime.`;

    const replyKeyboard = [
      [{ text: '📋 My Agreements', callback_data: 'action:deals' }],
      [{ text: '💰 Portfolio Balance', callback_data: 'action:balance' }],
      [{ text: '🏠 Main Menu', callback_data: 'action:menu' }],
    ];

    // Notify counterparty via Telegram
    if (telegramUrl && counterpartyId) {
      void (async () => {
        try {
          const tgId = await resolveTelegramIdForAgreement(counterpartyId);
          await fetch(`${telegramUrl.replace(/\/$/, '')}/api/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-notify-secret': secret },
            body: JSON.stringify({
              telegramId: tgId || undefined,
              phone: tgId ? undefined : counterpartyId,
              message: counterpartyMsg,
              keyboard: replyKeyboard,
            }),
          });
        } catch (e) {
          console.warn('[agreement.notify] Telegram counterparty notification failed:', e);
        }
      })();
    }

    // Notify actor via Telegram (confirmation to the one who cancelled/declined)
    if (telegramUrl && actorId) {
      void (async () => {
        try {
          const tgId = await resolveTelegramIdForAgreement(actorId);
          if (tgId) {
            const actorConfirmMsg =
              `${emoji} Agreement ${actionLabel.charAt(0).toUpperCase() + actionLabel.slice(1)}\n\n` +
              `You have ${actionLabel} the service agreement:\n` +
              `"${titleSnip}"` +
              reasonLine +
              `\n\nRef: ${agreement.id}`;
            await fetch(`${telegramUrl.replace(/\/$/, '')}/api/notify`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-notify-secret': secret },
              body: JSON.stringify({
                telegramId: tgId,
                message: actorConfirmMsg,
                keyboard: replyKeyboard,
              }),
            });
          }
        } catch (e) {
          console.warn('[agreement.notify] Telegram actor confirmation failed:', e);
        }
      })();
    }

    // Notify counterparty via WhatsApp
    if (whatsappUrl && counterpartyId) {
      void (async () => {
        try {
          const phone = await resolveWhatsAppPhoneForAgreement(counterpartyId);
          if (phone) {
            const waPhone = phone.startsWith('whatsapp:') ? phone : `whatsapp:${phone}`;
            await fetch(`${whatsappUrl.replace(/\/$/, '')}/api/send`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-notify-secret': secret },
              body: JSON.stringify({ to: waPhone, message: counterpartyMsg }),
            });
          }
        } catch (e) {
          console.warn('[agreement.notify] WhatsApp counterparty notification failed:', e);
        }
      })();
    }
  } catch (outerErr) {
    console.warn('[agreement.notify] notifyAgreementCancellation outer error:', outerErr);
  }
}
