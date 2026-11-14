import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../database/json-database.js';
import { badRequest } from '../shared/errors.js';
import { id, nowIso } from '../shared/id.js';
import { signUserJwt } from './jwt.js';

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
});

/**
 * Extract candidate Telegram bot tokens from environment configuration.
 */
function getTelegramCandidateTokens(): string[] {
  const tokens: string[] = [];

  // Dedicated TMA or standard Telegram bot token
  const primaryToken = process.env.TELEGRAM_BOT_TOKEN;
  if (primaryToken && primaryToken.trim()) tokens.push(primaryToken.trim());

  const stagingToken = process.env.TELEGRAM_STAGING_BOT_TOKEN;
  if (stagingToken && stagingToken.trim()) tokens.push(stagingToken.trim());

  const opsToken = process.env.TELEGRAM_OPS_ALERT_BOT_TOKEN || env.TELEGRAM_OPS_BOT_TOKEN;
  if (opsToken && opsToken.trim()) tokens.push(opsToken.trim());

  return Array.from(new Set(tokens));
}

/**
 * Cryptographically verifies Telegram WebApp initData HMAC-SHA256 signature.
 *
 * Implements Telegram's official cryptographic data-check-string verification:
 * 1. Parse query string and extract received 'hash'.
 * 2. Alphabetically sort all other key-value pairs as 'key=value\n'.
 * 3. Secret key = HMAC_SHA256("WebAppData", botToken).
 * 4. Calculated hash = HMAC_SHA256(secretKey, dataCheckString).hex().
 * 5. Constant-time compare calculated hash with received hash.
 * 6. Enforce anti-replay check (auth_date within 24 hours).
 */
export function validateTelegramInitData(
  initDataRaw: string,
  candidateTokens: string[] = getTelegramCandidateTokens()
): { valid: boolean; user?: TelegramMiniAppUser; startParam?: string; error?: string } {
  try {
    const params = new URLSearchParams(initDataRaw);
    const hash = params.get('hash');

    if (!hash) {
      return { valid: false, error: 'Missing hash parameter in initData' };
    }

    // Build data-check-string from all parameters except 'hash', sorted alphabetically
    const entries: string[] = [];
    for (const [key, val] of params.entries()) {
      if (key !== 'hash') {
        entries.push(`${key}=${val}`);
      }
    }
    entries.sort((a, b) => a.localeCompare(b));
    const dataCheckString = entries.join('\n');

    let isSignatureValid = false;

    // Verify against candidate bot tokens
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
      return { valid: false, error: 'Invalid HMAC signature for Telegram Mini App initData' };
    }

    // Anti-replay protection: check auth_date within 24 hours (86,400 seconds)
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

    // Parse user object
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
 */
export async function authenticateTelegramMiniApp(initDataRaw: string) {
  const validation = validateTelegramInitData(initDataRaw);
  if (!validation.valid || !validation.user) {
    throw badRequest(validation.error || 'Invalid Telegram authentication payload');
  }

  const tgUser = validation.user;
  const cleanTelegramId = String(tgUser.id);
  const now = nowIso();

  // 1. Resolve existing user by telegramUserId
  let user: any = await db.findUserByTelegramUserId(cleanTelegramId);

  // 2. Check customer_identity_links fallback if available
  if (!user && (db as any).findUserByTelegramId) {
    user = await (db as any).findUserByTelegramId(cleanTelegramId);
  }

  // 3. Check placeholder email fallback
  if (!user) {
    user = await db.findUserByEmail(`${cleanTelegramId}@sivantech.online`);
  }

  // 4. If user not found, create new Sivan account for this Telegram identity
  if (!user) {
    const fullName =
      [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ').trim() ||
      tgUser.username ||
      'Sivan User';

    user = await db.insertUserRecord({
      id: id('usr'),
      email: `${cleanTelegramId}@sivantech.online`,
      fullName,
      telegramUserId: cleanTelegramId,
      telegramUsername: tgUser.username || undefined,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    // Keep user's telegram username and metadata up to date
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

    if (needsUpdate) {
      updates.updatedAt = now;
      user = await db.updateUserRecord(updates);
    }
  }

  // 5. Issue authenticated user JWT
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
    },
    startParam: validation.startParam,
  };
}
