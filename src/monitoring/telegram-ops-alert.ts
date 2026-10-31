import { env } from '../config/env.js';

let lastAlertTimestamp = 0;
const DEBOUNCE_MS = 2500;

export function getTelegramOpsCredentials(): { token: string; chatId: string } {
  const token =
    env.TELEGRAM_OPS_BOT_TOKEN ||
    process.env.TELEGRAM_OPS_BOT_TOKEN ||
    process.env.TELEGRAM_BOT_TOKEN ||
    '';

  const chatId =
    env.TELEGRAM_OPS_CHAT_ID ||
    process.env.TELEGRAM_OPS_CHAT_ID ||
    process.env.TELEGRAM_CHANNEL_ID ||
    process.env.TELEGRAM_ADMIN_CHANNEL_ID ||
    process.env.TELEGRAM_ADMIN_CHAT_ID ||
    '';

  return { token, chatId };
}

/**
 * Low-level dispatch to Telegram Ops channel.
 */
export async function sendTelegramOpsMessage(
  text: string,
  parseMode: 'Markdown' | 'HTML' = 'Markdown'
): Promise<boolean> {
  try {
    const { token, chatId } = getTelegramOpsCredentials();
    if (!token || !chatId) return false;

    const targetUrl = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Dispatch operational error alerts directly to Telegram Ops / Admin debug chat.
 * Non-blocking, fails safe, and debounced to prevent spam storms.
 */
export async function notifyOpsTelegram(
  error: unknown,
  context: { requestId?: string; url?: string; method?: string } = {}
): Promise<void> {
  try {
    const { token, chatId } = getTelegramOpsCredentials();
    if (!token || !chatId) return;

    const now = Date.now();
    if (now - lastAlertTimestamp < DEBOUNCE_MS) return;
    lastAlertTimestamp = now;

    const err = error as Error & { code?: string; detail?: string; constraint?: string };
    const errName = err?.name || 'ServerError';
    const rawMessage = err?.message || String(error);
    const codeStr = err?.code ? ` (code: ${err.code})` : '';
    const constraintStr = err?.constraint ? `\nConstraint: \`${err.constraint}\`` : '';
    const detailStr = err?.detail ? `\nDetail: ${err.detail}` : '';

    const stack = (err?.stack || '') || (new Error().stack || '');
    const stackLines = stack.split('\n');
    const frame = stackLines.find((line) => {
      const isApp =
        line.includes('/src/') ||
        line.includes('src/') ||
        line.includes('/dist/') ||
        line.includes('dist/');
      const isExcluded =
        line.includes('node_modules') ||
        line.includes('telegram-ops-alert.');
      return isApp && !isExcluded;
    });

    let locationStr = '';
    let callerStr = '';
    if (frame) {
      const namedMatch = frame.match(/at\s+(?:async\s+)?([^\s(]+)\s+\((?:.*\/)?((?:src|dist)\/[^:]+):(\d+)(?::\d+)?\)/);
      if (namedMatch) {
        callerStr = namedMatch[1];
        locationStr = `${namedMatch[2]}:${namedMatch[3]}`;
      } else {
        const anonMatch = frame.match(/at\s+(?:.*\/)?((?:src|dist)\/[^:]+):(\d+)(?::\d+)?/);
        if (anonMatch) {
          callerStr = 'anonymous';
          locationStr = `${anonMatch[1]}:${anonMatch[2]}`;
        }
      }
    }

    const text = [
      `🚨 *SIVAN PAYMENT SERVER ERROR*`,
      `*Service:* \`sivan-payment\``,
      locationStr ? `*Location:* \`${locationStr}\`` : '',
      callerStr && callerStr !== 'anonymous' ? `*Caller:* \`${callerStr}()\`` : '',
      `*Error:* \`${errName}${codeStr}\``,
      `*Message:* \`${rawMessage.slice(0, 300)}\`${constraintStr}${detailStr}`,
      context.method && context.url ? `*Endpoint:* \`${context.method} ${context.url}\`` : '',
      context.requestId ? `*Request ID:* \`${context.requestId}\`` : '',
      `*Timestamp:* \`${new Date().toISOString()}\``,
    ]
      .filter(Boolean)
      .join('\n');

    await sendTelegramOpsMessage(text);
  } catch {
    // Non-blocking: alert failure must never disrupt application response
  }
}

/**
 * Dispatch web client errors from sivan-user-frontend to Telegram Ops.
 */
export async function notifyOpsClientError(payload: {
  message: string;
  route?: string;
  stack?: string;
  userAgent?: string;
  userId?: string;
  clientIp?: string;
}): Promise<void> {
  try {
    const text = [
      `🌐 *SIVAN WEB CLIENT ERROR*`,
      `*Service:* \`sivan-user-frontend\` (app.sivantech.online)`,
      payload.route ? `*Route:* \`${payload.route}\`` : '',
      payload.userId ? `*User ID:* \`${payload.userId}\`` : '',
      `*Error:* \`${payload.message.slice(0, 300)}\``,
      payload.clientIp ? `*Client IP:* \`${payload.clientIp}\`` : '',
      payload.userAgent ? `*User Agent:* \`${payload.userAgent.slice(0, 100)}\`` : '',
      payload.stack ? `*Stack Preview:*\n\`${payload.stack.slice(0, 250)}\`` : '',
      `*Timestamp:* \`${new Date().toISOString()}\``,
    ]
      .filter(Boolean)
      .join('\n');

    await sendTelegramOpsMessage(text);
  } catch {
    // Non-blocking
  }
}
