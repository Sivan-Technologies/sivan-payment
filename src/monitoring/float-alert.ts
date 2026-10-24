/**
 * PAGING A HUMAN WHEN OUR FLOAT RUNS DRY.
 *
 * An empty wallet at an aggregator is not a bug and not a customer problem:
 * it is a treasury problem, and it is the one utility failure that stops
 * revenue until a person moves money. It needs to reach someone directly.
 *
 * WHY THIS DOES NOT REUSE notifyOpsTelegram()
 *
 * That helper carries a single module-level `lastAlertTimestamp` shared by
 * every alert in the process, and drops anything sent within 2500ms of the
 * previous one. That is the right behaviour for crash storms and the wrong
 * behaviour here: an unrelated 500 landing a second earlier would silently
 * swallow the one alert that actually needs a human. It also formats its
 * payload as a stack trace, which is noise for a funding problem.
 *
 * So this has its own throttle, keyed per provider and service rather than
 * globally, and a much longer window - the float does not refill on its own,
 * so repeating the same page every few seconds would only train the reader to
 * ignore it.
 */

/** Keyed per provider+service so an airtime outage cannot mask a data outage. */
const lastSentAt = new Map<string, number>();
const REPEAT_WINDOW_MS = 15 * 60 * 1000;

function chatTargets(): string[] {
  /**
   * The ops channel plus a direct message, because a channel is somewhere you
   * look and a DM is something that reaches you. Both are environment driven:
   * a chat id is an account identifier and does not belong in the repository.
   */
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

/**
 * Tell the operator the float is empty. Never throws and never blocks the
 * request: a failed alert must not turn one problem into two.
 */
export async function alertFloatExhausted(input: {
  provider: string;
  service: string;
  upstreamMessage: string;
  failedOverTo?: string | null;
}): Promise<void> {
  try {
    const key = `${input.provider}:${input.service}`;
    const now = Date.now();
    const previous = lastSentAt.get(key) ?? 0;
    if (now - previous < REPEAT_WINDOW_MS) return;
    lastSentAt.set(key, now);

    // Always on the server log, even with no Telegram configured, so the
    // record of the outage does not depend on a messaging integration.
    console.error(
      `[float-exhausted] provider="${input.provider}" service="${input.service}" upstream="${input.upstreamMessage}"` +
        (input.failedOverTo ? ` failedOverTo="${input.failedOverTo}"` : ' no fallback available')
    );

    const token = botToken();
    const targets = chatTargets();
    if (!token || targets.length === 0) return;

    const text = [
      '🔴 *UTILITY FLOAT EXHAUSTED*',
      '',
      `*Provider:* \`${input.provider}\``,
      `*Service:* \`${input.service}\``,
      input.failedOverTo
        ? `*Fallback:* \`${input.failedOverTo}\` is serving this traffic for now.`
        : '*Fallback:* none configured. This service is DOWN for customers.',
      '',
      `_Upstream said:_ \`${input.upstreamMessage.slice(0, 200)}\``,
      '',
      'Fund the provider wallet to restore service. Customers are being told the',
      'purchase could not be completed and that nothing was deducted.',
      `*Time:* \`${new Date().toISOString()}\``,
    ].join('\n');

    await Promise.all(
      targets.map((chatId) =>
        fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
        }).catch(() => undefined)
      )
    );
  } catch {
    // Alerting is best effort by design.
  }
}

/** Test seam: the throttle is process-local state. */
export function __resetFloatAlertThrottle(): void {
  lastSentAt.clear();
}
