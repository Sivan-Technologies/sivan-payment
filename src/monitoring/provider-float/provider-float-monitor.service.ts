import { getLiveFloatTelemetry } from '../../admin/admin-float-settings.service.js';
import { createAuditLog } from '../../audit/audit.service.js';

interface ProviderAlertState {
  level: 'ok' | 'warning' | 'critical' | 'unreachable';
  lastSentAt: number;
}

const alertStateMap = new Map<string, ProviderAlertState>();

function chatTargets(): string[] {
  const targets = [
    process.env.TELEGRAM_OWNER_CHAT_ID,
    process.env.TELEGRAM_OPS_CHAT_ID,
    process.env.TELEGRAM_ADMIN_CHAT_ID,
  ].filter((id): id is string => Boolean(id && id.trim()));

  return Array.from(new Set(targets));
}

function botToken(): string {
  return (
    process.env.TELEGRAM_OPS_BOT_TOKEN ||
    process.env.TELEGRAM_BOT_TOKEN ||
    ''
  );
}

export async function sendTelegramFloatAlert(message: string): Promise<void> {
  const token = botToken();
  const targets = chatTargets();

  if (!token || targets.length === 0) {
    console.warn('[provider-float-monitor] Telegram ops credentials not configured, alert logged only.');
    return;
  }

  await Promise.all(
    targets.map((chatId) =>
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
      }).catch((err) => {
        console.warn(`[provider-float-monitor] Failed to dispatch Telegram alert to ${chatId}:`, err);
      })
    )
  );
}

export async function evaluateProviderFloats(): Promise<{
  checkedCount: number;
  alertsTriggered: number;
  resolutionsTriggered: number;
  summary: Array<{ providerId: string; balance: number; level: string }>;
}> {
  const { floats, settings } = await getLiveFloatTelemetry();
  let alertsTriggered = 0;
  let resolutionsTriggered = 0;
  const now = Date.now();
  const summary: Array<{ providerId: string; balance: number; level: string }> = [];

  for (const float of floats) {
    const { providerId, providerName, availableBalance, currency, alertLevel, thresholds } = float;
    summary.push({ providerId, balance: availableBalance, level: alertLevel });

    const state = alertStateMap.get(providerId) ?? { level: 'ok', lastSentAt: 0 };
    const cooldownMs = (settings.monitors[providerId]?.alertCooldownMinutes ?? 60) * 60 * 1000;

    // 1. Resolution / Refilled event (was low/critical, now back to healthy)
    if (alertLevel === 'ok' && (state.level === 'warning' || state.level === 'critical')) {
      resolutionsTriggered++;
      alertStateMap.set(providerId, { level: 'ok', lastSentAt: now });

      const text = [
        '🟢 *SIVAN AI . TREASURY FLOAT REFILLED*',
        '',
        `• *Provider:* \`${providerName}\``,
        `• *Current Balance:* \`${availableBalance.toLocaleString()} ${currency}\``,
        `• *Status:* RESTORED TO HEALTHY BUFFER`,
        '',
        `Operational buffer is confirmed safe. Automated services are fully unblocked.`,
        `• *Timestamp:* \`${new Date().toISOString()}\``,
      ].join('\n');

      console.info(`[provider-float-monitor] Provider ${providerId} refilled to ${availableBalance} ${currency}`);
      void sendTelegramFloatAlert(text);
      continue;
    }

    // 2. Alert conditions: Warning or Critical
    if (alertLevel === 'warning' || alertLevel === 'critical') {
      const isEscalation = state.level !== 'critical' && alertLevel === 'critical';
      const timeSinceLastAlert = now - state.lastSentAt;
      const cooldownPassed = isEscalation || (timeSinceLastAlert >= cooldownMs);

      if (cooldownPassed) {
        alertsTriggered++;
        alertStateMap.set(providerId, { level: alertLevel, lastSentAt: now });

        const emoji = alertLevel === 'critical' ? '🚨' : '⚠️';
        const severityTitle = alertLevel === 'critical' ? 'EMERGENCY . BUFFER EXHAUSTED' : 'LOW OPERATIONAL BUFFER';

        const text = [
          `${emoji} *SIVAN AI . TREASURY FLOAT ALERT*`,
          '',
          `• *Provider:* \`${providerName}\``,
          `• *Category:* \`${float.category.toUpperCase()}\``,
          `• *Current Balance:* \`${availableBalance.toLocaleString()} ${currency}\``,
          thresholds ? `• *Warning Threshold:* \`${thresholds.warning.toLocaleString()} ${currency}\`` : '',
          thresholds ? `• *Critical Threshold:* \`${thresholds.critical.toLocaleString()} ${currency}\`` : '',
          `• *Severity:* ${severityTitle}`,
          '',
          alertLevel === 'critical'
            ? `*Immediate Action Required:* Treasury pool is critically low. Payouts or customer vending will fail imminently unless funded immediately.`
            : `*Action Required:* Please top up float balance before high volume depletes the remaining buffer.`,
          '',
          `• *Timestamp:* \`${new Date().toISOString()}\``,
        ].filter(Boolean).join('\n');

        console.warn(`[provider-float-monitor] Alert triggered for ${providerId}: balance=${availableBalance} ${currency}, level=${alertLevel}`);
        void sendTelegramFloatAlert(text);

        void createAuditLog({
          actorType: 'system',
          action: 'monitoring.float_threshold_alert',
          resourceType: 'provider_float',
          resourceId: providerId,
          severity: alertLevel === 'critical' ? 'error' : 'warning',
          metadata: {
            providerId,
            availableBalance,
            currency,
            alertLevel,
            thresholds,
          },
        });
      }
    }
  }

  return {
    checkedCount: floats.length,
    alertsTriggered,
    resolutionsTriggered,
    summary,
  };
}

