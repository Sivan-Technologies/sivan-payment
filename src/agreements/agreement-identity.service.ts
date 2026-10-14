/**
 * Resolves the canonical user identity behind a service agreement party:
 * buyer UUID, Telegram id and WhatsApp phone.
 *
 * Extracted verbatim from agreement.service.ts as part of the god-service
 * split (FUTURE_BUILD_GOD_SERVICE_SPLIT.md Part 2). No logic changes.
 */
import { db } from '../database/json-database.js';
import type { ServiceAgreementRecord, UserRecord } from '../database/types.js';

/**
 * Resolve a buyerUserId that may carry a channel prefix (whatsapp:, telegram:, tg:)
 * to the underlying payments UUID so that findUserWalletForNetwork can match the
 * correct row in payments_user_wallets.  Raw UUID strings are returned unchanged.
 *
 * Without this, agreements created from WhatsApp or Telegram channels store the
 * raw phone / Telegram ID as buyer_user_id, and the wallet lookup silently returns
 * undefined — causing the release transfer to either skip the debit entirely or
 * execute as a no-op circular transfer from the fee wallet.
 */
export async function resolveBuyerUUID(rawBuyerUserId: string): Promise<string> {
  const raw = String(rawBuyerUserId || '').trim();
  if (!raw) return raw;

  // Already a UUID-style payments ID — nothing to resolve
  if (raw.startsWith('usr_') || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return raw;
  }

  try {
    let user: UserRecord | undefined;

    // 1. Telegram prefix: tg:123456 or telegram:123456
    if (raw.startsWith('tg:') || raw.startsWith('telegram:')) {
      const telegramId = raw.replace(/^(tg:|telegram:)/i, '').trim();
      user = await (db as any).findUserByTelegramUserId?.(telegramId);
      if (!user) user = await db.findUserByTarget(telegramId);
    }

    // 2. WhatsApp prefix: whatsapp:+2349...
    if (!user && raw.startsWith('whatsapp:')) {
      const phone = raw.slice('whatsapp:'.length).trim();
      user = await db.findUserByWhatsappNumber(raw);
      if (!user) user = await db.findUserByWhatsappNumber(phone);
      if (!user) {
        const digits = phone.replace(/\D/g, '');
        user = await db.findUserByWhatsappNumber(`+${digits}`);
      }
    }

    // 3. Fallback: generic target / identity-link lookup
    if (!user) user = await db.findUserByTarget(raw);

    if (user?.id) {
      return user.id;
    }
  } catch (lookupErr) {
    console.warn('[agreement.resolveBuyerUUID] lookup note:', lookupErr);
  }

  // Return the original value so existing fallback paths still apply
  return raw;
}

// ─── Cross-channel cancellation notifier ─────────────────────────────────────

/**
 * Fires a real-time push notification to the counterparty (and optionally the
 * actor) across Telegram and WhatsApp when an agreement is cancelled or
 * declined from any channel (Web App, API, bot, etc.).
 *
 * Runs fire-and-forget — never throws so it cannot break the main state
 * transition that called it.
/**
 * Helper: resolve Telegram chat ID for a target identifier (payment userId, phone, telegram username, or direct telegram ID).
 */
export async function resolveTelegramIdForAgreement(target: string): Promise<string | null> {
  if (!target) return null;
  const raw = String(target).trim();

  // 1. Direct Telegram ID format: e.g. "tg:123456", "telegram:123456", or raw digits (6-12 digits)
  if (raw.startsWith('tg:') || raw.startsWith('telegram:')) {
    const parsed = raw.replace(/^(tg:|telegram:)/i, '').trim();
    if (/^\d{6,12}$/.test(parsed)) return parsed;
  }
  if (/^\d{6,12}$/.test(raw)) {
    return raw;
  }

  // 2. Check CustomerIdentityLinks in DB
  const links = await db.listCustomerIdentityLinks();
  const cleanTarget = raw.toLowerCase().replace(/^@/, '');
  const digits = raw.replace(/\D/g, '');

  const match = links
    .filter((l) => {
      if (l.status !== 'linked' || !l.telegramUserId) return false;
      if (l.paymentUserId === raw) return true;
      if (l.telegramUserId === raw) return true;
      if (l.telegramUsername && l.telegramUsername.toLowerCase().replace(/^@/, '') === cleanTarget) return true;
      if (digits && digits.length >= 10 && l.whatsappNumber) {
        const linkDigits = l.whatsappNumber.replace(/\D/g, '');
        if (linkDigits === digits || linkDigits.endsWith(digits) || digits.endsWith(linkDigits)) return true;
      }
      return false;
    })
    .sort((a, b) => (b.linkedAt || b.createdAt || '').localeCompare(a.linkedAt || a.createdAt || ''));

  if (match[0]?.telegramUserId) return match[0].telegramUserId;

  // 3. Check UserRecord in DB
  const user = (await db.findUserById(raw)) ||
               (await db.findUserByWhatsappNumber(raw)) ||
               (await db.findUserByTarget(raw)) ||
               (await db.findUserByUsername(cleanTarget));

  if (user) {
    if (user.telegramUserId) return user.telegramUserId;
    const userLinks = links
      .filter((l) => l.paymentUserId === user.id && l.status === 'linked' && Boolean(l.telegramUserId))
      .sort((a, b) => (b.linkedAt || b.createdAt || '').localeCompare(a.linkedAt || a.createdAt || ''));
    if (userLinks[0]?.telegramUserId) return userLinks[0].telegramUserId;
  }

  return null;
}

/**
 * Helper: resolve WhatsApp phone for a target identifier.
 */
export async function resolveWhatsAppPhoneForAgreement(target: string): Promise<string | null> {
  if (!target) return null;
  const raw = String(target).trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 10 && (raw.startsWith('+') || raw.startsWith('234') || raw.startsWith('0') || raw.startsWith('whatsapp:'))) {
    return raw.replace(/^whatsapp:/, '');
  }

  const user = (await db.findUserById(raw)) ||
               (await db.findUserByWhatsappNumber(raw)) ||
               (await db.findUserByTarget(raw));
  if (user?.whatsappNumber) return user.whatsappNumber;

  const links = await db.listCustomerIdentityLinks();
  const match = links
    .filter((l) => (l.paymentUserId === raw || l.paymentUserId === user?.id) && l.status === 'linked' && Boolean(l.whatsappNumber))
    .sort((a, b) => (b.linkedAt || b.createdAt || '').localeCompare(a.linkedAt || a.createdAt || ''));
  return match[0]?.whatsappNumber || null;
}
