/**
 * Multi-channel participant notifications for agreement lifecycle events.
 */
import { db } from '../database/json-database.js';
import type { ServiceAgreementRecord } from '../database/types.js';
import { resolveTelegramIdForAgreement, resolveWhatsAppPhoneForAgreement } from './agreement-identity.service.js';

function getNotifyConfig() {
  const isLive = process.env.NODE_ENV === 'production' || process.env.DATABASE_MODE === 'live';
  const gatewayUrl = (
    process.env.CORE_API_BASE_URL ||
    process.env.API_GATEWAY_URL ||
    process.env.PUBLIC_API_GATEWAY_URL ||
    (isLive ? 'https://api.sivantech.online' : 'https://api-staging.sivantech.online')
  ).replace(/\/$/, '');

  const telegramUrl = (process.env.TELEGRAM_NOTIFICATION_URL || `${gatewayUrl}/api/telegram`).replace(/\/$/, '');
  const whatsappUrl = (process.env.WHATSAPP_NOTIFICATION_URL || process.env.WHATSAPP_BOT_URL || `${gatewayUrl}/api/whatsapp`).replace(/\/$/, '');
  const secret = process.env.NOTIFY_SECRET || process.env.NOTIFICATION_SECRET || process.env.CORE_API_SECRET;
  return { telegramUrl, whatsappUrl, secret };
}

/**
 * Fire real-time notifications to the freelancer (seller) when a service agreement is created.
 * Also sends a confirmation receipt to the buyer.
 */
export async function notifyAgreementCreated(
  agreement: ServiceAgreementRecord
): Promise<void> {
  try {
    const { telegramUrl, whatsappUrl, secret } = getNotifyConfig();
    if (!secret) return;

    const buyerId = agreement.buyerUserId;
    const sellerId = agreement.sellerUserId;
    const titleSnip = (agreement.title || 'Service Agreement').slice(0, 50);
    const amountStr = `${agreement.amountUsdc} ${(agreement.currency || 'USDC').toUpperCase()}`;
    const networkLabel = agreement.network
      ? (agreement.network.charAt(0).toUpperCase() + agreement.network.slice(1))
      : 'Solana';
    const deadlineStr = agreement.deadlineDays ? `${agreement.deadlineDays} days` : 'Flexible';

    const sellerMsg =
      `🤝 New Service Agreement Received\n\n` +
      `You received a new service agreement from client:\n` +
      `"${titleSnip}"\n\n` +
      `• Amount: ${amountStr}\n` +
      `• Network: ${networkLabel}\n` +
      `• Delivery Deadline: ${deadlineStr}\n` +
      `• Ref: ${agreement.id}\n\n` +
      `Please review and accept the agreement to proceed.`;

    const sellerKeyboard = [
      [{ text: '✅ Accept Agreement', callback_data: `v1:accept:${agreement.id}` }],
      [{ text: '❌ Decline', callback_data: `v1:decline:${agreement.id}` }],
      [{ text: '📋 My Agreements', callback_data: 'v1:deals' }],
    ];

    // 1. Notify Seller via Telegram
    if (telegramUrl && sellerId) {
      void (async () => {
        try {
          const tgId = await resolveTelegramIdForAgreement(sellerId);
          await fetch(`${telegramUrl.replace(/\/$/, '')}/api/notify`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-notify-secret': secret,
              'x-target-service': 'telegram',
            },
            body: JSON.stringify({
              telegramId: tgId || undefined,
              phone: tgId ? undefined : sellerId,
              message: sellerMsg,
              keyboard: sellerKeyboard,
            }),
          });
        } catch (e) {
          console.warn('[agreement.notify] Telegram seller creation notification failed:', e);
        }
      })();
    }

    // 2. Notify Seller via WhatsApp
    if (whatsappUrl && sellerId) {
      void (async () => {
        try {
          const phone = await resolveWhatsAppPhoneForAgreement(sellerId);
          if (phone) {
            const waPhone = phone.startsWith('whatsapp:') ? phone : `whatsapp:${phone}`;
            await fetch(`${whatsappUrl.replace(/\/$/, '')}/api/notify`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-notify-secret': secret,
                'x-target-service': 'whatsapp-bot',
              },
              body: JSON.stringify({ to: waPhone, message: sellerMsg }),
            });
          }
        } catch (e) {
          console.warn('[agreement.notify] WhatsApp seller creation notification failed:', e);
        }
      })();
    }

    // 3. Notify Buyer confirmation via Telegram
    if (telegramUrl && buyerId) {
      void (async () => {
        try {
          const tgId = await resolveTelegramIdForAgreement(buyerId);
          if (tgId) {
            const buyerConfirmMsg =
              `📝 Service Agreement Sent\n\n` +
              `You sent a service agreement to freelancer:\n` +
              `"${titleSnip}"\n\n` +
              `• Amount: ${amountStr}\n` +
              `• Network: ${networkLabel}\n` +
              `• Ref: ${agreement.id}\n\n` +
              `Waiting for contractor acceptance before vault funding.`;
            await fetch(`${telegramUrl.replace(/\/$/, '')}/api/notify`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-notify-secret': secret },
              body: JSON.stringify({
                telegramId: tgId,
                message: buyerConfirmMsg,
                keyboard: [
                  [{ text: '🔍 View Status', callback_data: `v1:status:${agreement.id}` }],
                  [{ text: '📋 My Agreements', callback_data: 'v1:deals' }],
                ],
              }),
            });
          }
        } catch (e) {
          console.warn('[agreement.notify] Telegram buyer creation confirmation failed:', e);
        }
      })();
    }
  } catch (outerErr) {
    console.warn('[agreement.notify] notifyAgreementCreated outer error:', outerErr);
  }
}

/**
 * Fire real-time notifications to the buyer when a service agreement is accepted by the contractor.
 * Alerts buyer that agreement is now awaiting funding and provides direct Pay now / Fund buttons.
 */
export async function notifyAgreementAccepted(
  agreement: ServiceAgreementRecord
): Promise<void> {
  try {
    const { telegramUrl, whatsappUrl, secret } = getNotifyConfig();
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
      [{ text: '⚡ Pay from Balance', callback_data: `v1:pay_balance:${agreement.id}` }],
      [{ text: '💳 Pay now / Options', callback_data: `v1:pay:${agreement.id}` }],
      [{ text: '🔍 View Status', callback_data: `v1:status:${agreement.id}` }],
      [{ text: '📋 My Agreements', callback_data: 'v1:deals' }],
    ];

    // 1. Notify Buyer via Telegram
    if (telegramUrl && buyerId) {
      void (async () => {
        try {
          const tgId = await resolveTelegramIdForAgreement(buyerId);
          const fallbackPhone = tgId ? undefined : ((await resolveWhatsAppPhoneForAgreement(buyerId)) || buyerId);
          const res = await fetch(`${telegramUrl.replace(/\/$/, '')}/api/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-notify-secret': secret },
            body: JSON.stringify({
              telegramId: tgId || undefined,
              phone: tgId ? undefined : fallbackPhone,
              message: buyerMsg,
              keyboard: telegramKeyboard,
            }),
          });
          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            console.warn(`[agreement.notify] Telegram buyer acceptance notification status ${res.status}:`, errText);
          } else {
            console.info(`[agreement.notify] Telegram buyer acceptance notification delivered for agreement ${agreement.id}`);
          }
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
            await fetch(`${whatsappUrl.replace(/\/$/, '')}/api/notify`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-notify-secret': secret,
                'x-target-service': 'whatsapp-bot',
              },
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
                  [{ text: '📋 My Agreements', callback_data: 'v1:deals' }],
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
 * Fire real-time notifications to the contractor and buyer when an agreement is funded.
 */
export async function notifyAgreementFunded(
  agreement: ServiceAgreementRecord
): Promise<void> {
  try {
    const { telegramUrl, whatsappUrl, secret } = getNotifyConfig();
    if (!secret) return;

    const buyerId = agreement.buyerUserId;
    const sellerId = agreement.sellerUserId;
    const titleSnip = (agreement.title || 'Service Agreement').slice(0, 50);
    const amountStr = `${agreement.amountUsdc} ${(agreement.currency || 'USDC').toUpperCase()}`;
    const networkLabel = agreement.network
      ? (agreement.network.charAt(0).toUpperCase() + agreement.network.slice(1))
      : 'Solana';

    const sellerMsg =
      `💰 Service Agreement Funded!\n\n` +
      `The client has locked ${amountStr} into the vault for:\n` +
      `"${titleSnip}"\n\n` +
      `• Network: ${networkLabel}\n` +
      `• Ref: ${agreement.id}\n\n` +
      `Funds are secured. You can now begin work and submit delivery once completed!`;

    const sellerKeyboard = [
      [{ text: '📦 Submit Delivery', callback_data: `v1:deliver:${agreement.id}` }],
      [{ text: '🔍 View Status', callback_data: `v1:status:${agreement.id}` }],
      [{ text: '📋 My Agreements', callback_data: 'v1:deals' }],
    ];

    // Notify Seller via Telegram
    if (telegramUrl && sellerId) {
      void (async () => {
        try {
          const tgId = await resolveTelegramIdForAgreement(sellerId);
          await fetch(`${telegramUrl.replace(/\/$/, '')}/api/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-notify-secret': secret },
            body: JSON.stringify({
              telegramId: tgId || undefined,
              phone: tgId ? undefined : sellerId,
              message: sellerMsg,
              keyboard: sellerKeyboard,
            }),
          });
        } catch (e) {
          console.warn('[agreement.notify] Telegram seller funding notification failed:', e);
        }
      })();
    }

    // Notify Seller via WhatsApp
    if (whatsappUrl && sellerId) {
      void (async () => {
        try {
          const phone = await resolveWhatsAppPhoneForAgreement(sellerId);
          if (phone) {
            const waPhone = phone.startsWith('whatsapp:') ? phone : `whatsapp:${phone}`;
            await fetch(`${whatsappUrl.replace(/\/$/, '')}/api/notify`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-notify-secret': secret,
                'x-target-service': 'whatsapp-bot',
              },
              body: JSON.stringify({ to: waPhone, message: sellerMsg }),
            });
          }
        } catch (e) {
          console.warn('[agreement.notify] WhatsApp seller funding notification failed:', e);
        }
      })();
    }

    // Notify Buyer confirmation via Telegram
    if (telegramUrl && buyerId) {
      void (async () => {
        try {
          const tgId = await resolveTelegramIdForAgreement(buyerId);
          if (tgId) {
            const buyerConfirmMsg =
              `🔒 Funds Locked in Vault\n\n` +
              `Your payment of ${amountStr} for "${titleSnip}" is secured in the vault.\n\n` +
              `The contractor has been notified to start work.\n` +
              `• Ref: ${agreement.id}`;
            await fetch(`${telegramUrl.replace(/\/$/, '')}/api/notify`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-notify-secret': secret },
              body: JSON.stringify({
                telegramId: tgId,
                message: buyerConfirmMsg,
                keyboard: [
                  [{ text: '🔍 View Status', callback_data: `v1:status:${agreement.id}` }],
                  [{ text: '📋 My Agreements', callback_data: 'v1:deals' }],
                ],
              }),
            });
          }
        } catch (e) {
          console.warn('[agreement.notify] Telegram buyer funding confirmation failed:', e);
        }
      })();
    }
  } catch (outerErr) {
    console.warn('[agreement.notify] notifyAgreementFunded outer error:', outerErr);
  }
}

/**
 * Fire real-time notification to the buyer when delivery has been submitted.
 */
export async function notifyAgreementDelivered(
  agreement: ServiceAgreementRecord
): Promise<void> {
  try {
    const { telegramUrl, whatsappUrl, secret } = getNotifyConfig();
    if (!secret) return;

    const buyerId = agreement.buyerUserId;
    const sellerId = agreement.sellerUserId;
    const titleSnip = (agreement.title || 'Service Agreement').slice(0, 50);
    const amountStr = `${agreement.amountUsdc} ${(agreement.currency || 'USDC').toUpperCase()}`;

    const buyerMsg =
      `📦 Delivery Submitted!\n\n` +
      `The contractor has submitted delivery for:\n` +
      `"${titleSnip}"\n\n` +
      `• Amount: ${amountStr}\n` +
      `• Ref: ${agreement.id}\n\n` +
      `Please review the completed work and release the funds to finish the agreement.`;

    const buyerKeyboard = [
      [{ text: '💸 Release Funds', callback_data: `v1:release:${agreement.id}` }],
      [{ text: '⚠️ Raise Dispute', callback_data: `v1:dispute:${agreement.id}` }],
      [{ text: '🔍 View Status', callback_data: `v1:status:${agreement.id}` }],
    ];

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
              keyboard: buyerKeyboard,
            }),
          });
        } catch (e) {
          console.warn('[agreement.notify] Telegram buyer delivery notification failed:', e);
        }
      })();
    }

    if (whatsappUrl && buyerId) {
      void (async () => {
        try {
          const phone = await resolveWhatsAppPhoneForAgreement(buyerId);
          if (phone) {
            const waPhone = phone.startsWith('whatsapp:') ? phone : `whatsapp:${phone}`;
            await fetch(`${whatsappUrl.replace(/\/$/, '')}/api/notify`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-notify-secret': secret,
                'x-target-service': 'whatsapp-bot',
              },
              body: JSON.stringify({ to: waPhone, message: buyerMsg }),
            });
          }
        } catch (e) {
          console.warn('[agreement.notify] WhatsApp buyer delivery notification failed:', e);
        }
      })();
    }

    // Confirmation to seller
    if (telegramUrl && sellerId) {
      void (async () => {
        try {
          const tgId = await resolveTelegramIdForAgreement(sellerId);
          if (tgId) {
            await fetch(`${telegramUrl.replace(/\/$/, '')}/api/notify`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-notify-secret': secret },
              body: JSON.stringify({
                telegramId: tgId,
                message: `✅ Delivery Submitted\n\nYou submitted delivery for "${titleSnip}". Waiting for client review and release.\n\n• Ref: ${agreement.id}`,
                keyboard: [
                  [{ text: '🔍 View Status', callback_data: `v1:status:${agreement.id}` }],
                  [{ text: '📋 My Agreements', callback_data: 'v1:deals' }],
                ],
              }),
            });
          }
        } catch (e) {
          console.warn('[agreement.notify] Telegram seller delivery confirmation failed:', e);
        }
      })();
    }
  } catch (outerErr) {
    console.warn('[agreement.notify] notifyAgreementDelivered outer error:', outerErr);
  }
}

/**
 * Fire real-time notification to the contractor when funds have been released.
 */
export async function notifyAgreementReleased(
  agreement: ServiceAgreementRecord
): Promise<void> {
  try {
    const { telegramUrl, whatsappUrl, secret } = getNotifyConfig();
    if (!secret) return;

    const buyerId = agreement.buyerUserId;
    const sellerId = agreement.sellerUserId;
    const titleSnip = (agreement.title || 'Service Agreement').slice(0, 50);
    const netAmount = agreement.sellerNetAmountUsdc ?? agreement.amountUsdc;
    const currency = (agreement.currency || 'USDC').toUpperCase();
    const amountStr = `${netAmount} ${currency}`;

    const sellerMsg =
      `🎉 Payment Released!\n\n` +
      `${amountStr} has been released and credited to your Sivan balance for:\n` +
      `"${titleSnip}"\n\n` +
      `• Ref: ${agreement.id}\n\n` +
      `Thank you for delivering with Sivan!`;

    const sellerKeyboard = [
      [{ text: '💰 Check Balance', callback_data: 'v1:balance' }],
      [{ text: '📋 My Agreements', callback_data: 'v1:deals' }],
      [{ text: '🏠 Main Menu', callback_data: 'v1:menu' }],
    ];

    if (telegramUrl && sellerId) {
      void (async () => {
        try {
          const tgId = await resolveTelegramIdForAgreement(sellerId);
          await fetch(`${telegramUrl.replace(/\/$/, '')}/api/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-notify-secret': secret },
            body: JSON.stringify({
              telegramId: tgId || undefined,
              phone: tgId ? undefined : sellerId,
              message: sellerMsg,
              keyboard: sellerKeyboard,
            }),
          });
        } catch (e) {
          console.warn('[agreement.notify] Telegram seller release notification failed:', e);
        }
      })();
    }

    if (whatsappUrl && sellerId) {
      void (async () => {
        try {
          const phone = await resolveWhatsAppPhoneForAgreement(sellerId);
          if (phone) {
            const waPhone = phone.startsWith('whatsapp:') ? phone : `whatsapp:${phone}`;
            await fetch(`${whatsappUrl.replace(/\/$/, '')}/api/notify`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-notify-secret': secret,
                'x-target-service': 'whatsapp-bot',
              },
              body: JSON.stringify({ to: waPhone, message: sellerMsg }),
            });
          }
        } catch (e) {
          console.warn('[agreement.notify] WhatsApp seller release notification failed:', e);
        }
      })();
    }

    // Confirmation to buyer
    if (telegramUrl && buyerId) {
      void (async () => {
        try {
          const tgId = await resolveTelegramIdForAgreement(buyerId);
          if (tgId) {
            await fetch(`${telegramUrl.replace(/\/$/, '')}/api/notify`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-notify-secret': secret },
              body: JSON.stringify({
                telegramId: tgId,
                message: `✅ Service Agreement Completed\n\nYou released payment for "${titleSnip}". Agreement is now complete.\n\n• Ref: ${agreement.id}`,
                keyboard: [
                  [{ text: '📋 My Agreements', callback_data: 'v1:deals' }],
                  [{ text: '🏠 Main Menu', callback_data: 'v1:menu' }],
                ],
              }),
            });
          }
        } catch (e) {
          console.warn('[agreement.notify] Telegram buyer release confirmation failed:', e);
        }
      })();
    }
  } catch (outerErr) {
    console.warn('[agreement.notify] notifyAgreementReleased outer error:', outerErr);
  }
}

/**
 * Fire real-time cancellation push notifications to both counterparty and actor
 * via Telegram bot and WhatsApp bot.
 */
export async function notifyAgreementCancellation(
  agreement: ServiceAgreementRecord,
  actorRole: 'buyer' | 'seller',
  action: 'cancelled' | 'declined',
  reason?: string | null
): Promise<void> {
  try {
    const { telegramUrl, whatsappUrl, secret } = getNotifyConfig();
    if (!secret) return;

    // Determine who to notify: the counterparty of whoever acted.
    const counterpartyId =
      actorRole === 'seller' ? agreement.buyerUserId : agreement.sellerUserId;
    const actorId =
      actorRole === 'seller' ? agreement.sellerUserId : agreement.buyerUserId;

    const actionLabel = action === 'declined' ? 'declined' : 'cancelled';
    const actorLabel = actorRole === 'seller' ? 'The contractor' : 'The client';
    const emoji = action === 'declined' ? '❌' : '🚫';

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
      [{ text: '📋 My Agreements', callback_data: 'v1:deals' }],
      [{ text: '💰 Portfolio Balance', callback_data: 'v1:balance' }],
      [{ text: '🏠 Main Menu', callback_data: 'v1:menu' }],
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
            await fetch(`${whatsappUrl.replace(/\/$/, '')}/api/notify`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-notify-secret': secret,
                'x-target-service': 'whatsapp-bot',
              },
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
