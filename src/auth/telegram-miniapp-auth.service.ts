import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../database/json-database.js';
import { badRequest } from '../shared/errors.js';
import { id, nowIso } from '../shared/id.js';
import { signUserJwt } from './jwt.js';
import { activeLinkForTelegram } from '../identity/identity.service.js';

export interface TelegramMiniAppUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
}

export const telegramMiniAppAuthSchema = z.object({
  initData: z.string().min(1, 'initData is required'),
  phone: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  fullName: z.string().optional(),
});

export type TelegramMiniAppAuthInput = z.infer<typeof telegramMiniAppAuthSchema>;

/**
 * Extract candidate Telegram bot tokens from environment configuration.
 */
function getTelegramCandidateTokens(): string[] {
  const tokens: string[] = [];

  const primaryToken = process.env.TELEGRAM_BOT_TOKEN;
  if (primaryToken && primaryToken.trim()) tokens.push(primaryToken.trim());

  const stagingToken = process.env.TELEGRAM_STAGING_BOT_TOKEN;
  if (stagingToken && stagingToken.trim()) tokens.push(stagingToken.trim());

  // Dedicated staging bot token (@SivanStaging_Bot / @SivanAi_bot) from Telegram-layer
  const stagingBotToken = '8775192643:AAGys0QCU2liwaC9-l3Sz4-PmyEKSWT_tAo';
  tokens.push(stagingBotToken);

  const opsToken = process.env.TELEGRAM_OPS_ALERT_BOT_TOKEN || env.TELEGRAM_OPS_BOT_TOKEN;
  if (opsToken && opsToken.trim()) tokens.push(opsToken.trim());

  return Array.from(new Set(tokens));
}

/**
 * Cryptographically verifies Telegram WebApp initData HMAC-SHA256 signature.
 */
export async function validateTelegramInitData(
  initDataRaw: string,
  candidateTokens: string[] = getTelegramCandidateTokens()
): Promise<{ valid: boolean; user?: TelegramMiniAppUser; startParam?: string; error?: string }> {
  try {
    const params = new URLSearchParams(initDataRaw);
    const hash = params.get('hash');

    if (!hash) {
      return { valid: false, error: 'Missing hash parameter in initData' };
    }

    const entries: string[] = [];
    for (const [key, val] of params.entries()) {
      if (key !== 'hash') {
        entries.push(`${key}=${val}`);
      }
    }
    entries.sort((a, b) => a.localeCompare(b));
    const dataCheckString = entries.join('\n');

    let isSignatureValid = false;

    for (const botToken of candidateTokens) {
      const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
      const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

      const calcBuf = Buffer.from(calculatedHash.toLowerCase());
      const hashBuf = Buffer.from(hash.toLowerCase());

      if (calcBuf.length === hashBuf.length && crypto.timingSafeEqual(calcBuf, hashBuf)) {
        isSignatureValid = true;
        break;
      }
    }

    if (!isSignatureValid) {
      // Fallback: Query live Telegram microservice directly to verify against its loaded bot token
      try {
        const rawTgUrl = process.env.TELEGRAM_NOTIFICATION_URL || `${process.env.PAYMENT_API_BASE_URL || 'https://api-staging.sivantech.online'}/api/telegram`;
        const verifyEndpoint = `${rawTgUrl.replace(/\/+$/, '')}/verify-init-data`;

        const remoteRes = await fetch(verifyEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData: initDataRaw }),
        });

        if (remoteRes.ok) {
          const remoteJson = (await remoteRes.json()) as any;
          if (remoteJson?.valid && remoteJson?.user) {
            return {
              valid: true,
              user: remoteJson.user,
              startParam: remoteJson.startParam,
            };
          }
        }
      } catch (remoteErr) {
        console.warn('[telegram-auth] Remote bot initData verification fallback note:', remoteErr);
      }

      return { valid: false, error: 'Invalid HMAC signature for Telegram Mini App initData' };
    }

    const authDateStr = params.get('auth_date');
    if (authDateStr) {
      const authTimestamp = Number(authDateStr);
      if (!Number.isNaN(authTimestamp)) {
        const nowSec = Math.floor(Date.now() / 1000);
        if (nowSec - authTimestamp > 86400) {
          return { valid: false, error: 'Telegram Mini App session expired (auth_date older than 24 hours)' };
        }
      }
    }

    const userJson = params.get('user');
    let user: TelegramMiniAppUser | undefined;
    if (userJson) {
      try {
        user = JSON.parse(userJson) as TelegramMiniAppUser;
      } catch {
        return { valid: false, error: 'Malformed user payload in initData' };
      }
    }

    return {
      valid: true,
      user,
      startParam: params.get('start_param') || undefined,
    };
  } catch (err: any) {
    return { valid: false, error: err?.message || 'Failed to parse initData' };
  }
}

/**
 * Authenticates a Telegram user via Mini App initData, linking or creating their Sivan account.
 * Supports updating verified mobile phone number and legal bank account names.
 */
export async function authenticateTelegramMiniApp(input: TelegramMiniAppAuthInput) {
  const validation = await validateTelegramInitData(input.initData);
  if (!validation.valid || !validation.user) {
    throw badRequest(validation.error || 'Invalid Telegram authentication payload');
  }

  const tgUser = validation.user;
  const cleanTelegramId = String(tgUser.id);
  const now = nowIso();

  // Normalize incoming phone number if provided
  let normalizedPhone: string | undefined;
  if (input.phone) {
    const rawClean = input.phone.replace(/^whatsapp:\+?/, '').replace(/^\+/, '').replace(/\D/g, '').trim();
    if (rawClean.length >= 10) {
      normalizedPhone = `+${rawClean}`;
    }
  }

  // Derive candidate legal name
  const suppliedName = (
    input.fullName ||
    [input.firstName, input.lastName].filter(Boolean).join(' ') ||
    ''
  ).trim();

  // 1. Resolve existing user via customer_identity_links (authoritative bot pairing record)
  let user: any = null;
  const link = await activeLinkForTelegram(cleanTelegramId).catch(() => null);
  if (link?.paymentUserId) {
    user = await db.findUserById(link.paymentUserId);
  }

  // 2. Resolve existing user by telegramUserId column
  if (!user) {
    user = await db.findUserByTelegramUserId(cleanTelegramId);
  }

  // 3. Fallback: check if existing user exists by verified phone
  if (!user && normalizedPhone) {
    user = await db.findUserByWhatsappNumber(normalizedPhone);
  }

  // 4. Fallback: check placeholder email
  if (!user) {
    user = await db.findUserByEmail(`${cleanTelegramId}@sivantech.online`);
  }

  // 5. Create or update user record
  if (!user) {
    const fullName =
      suppliedName ||
      [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ').trim() ||
      tgUser.username ||
      'Sivan User';

    user = await db.insertUserRecord({
      id: id('usr'),
      email: `${cleanTelegramId}@sivantech.online`,
      fullName,
      whatsappNumber: normalizedPhone,
      telegramUserId: cleanTelegramId,
      telegramUsername: tgUser.username || undefined,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    let needsUpdate = false;
    const updates = { ...user };

    if (!user.telegramUserId) {
      updates.telegramUserId = cleanTelegramId;
      needsUpdate = true;
    }
    if (tgUser.username && user.telegramUsername !== tgUser.username) {
      updates.telegramUsername = tgUser.username;
      needsUpdate = true;
    }
    const resolvedPhone = normalizedPhone || user.whatsappNumber || link?.whatsappNumber;
    if (resolvedPhone && user.whatsappNumber !== resolvedPhone) {
      updates.whatsappNumber = resolvedPhone;
      needsUpdate = true;
    }
    if (suppliedName && (!user.fullName || user.fullName === 'Sivan User' || user.fullName !== suppliedName)) {
      updates.fullName = suppliedName;
      needsUpdate = true;
    }

    if (needsUpdate) {
      updates.updatedAt = now;
      user = await db.updateUserRecord(updates);
    }
  }

  // Check if onboarding is required (needs phone and legal full name confirmed)
  const hasPhone = Boolean(user.whatsappNumber || link?.whatsappNumber || normalizedPhone);
  const hasName = Boolean(user.fullName && user.fullName !== 'Sivan User' && user.fullName.length >= 2);
  const requiresOnboarding = !hasPhone || !hasName;

  // 6. Issue authenticated user JWT
  const token = signUserJwt({
    userId: user.id,
    email: user.email,
  });

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      username: user.username,
      telegramUserId: user.telegramUserId,
      phone: user.whatsappNumber,
    },
    requiresOnboarding,
    startParam: validation.startParam,
  };
}
