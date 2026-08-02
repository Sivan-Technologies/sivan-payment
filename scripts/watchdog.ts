/**
 * External watchdog. Polls the APIs and alerts to Telegram when money stops
 * moving.
 *
 * WHY SELF-HOSTED RATHER THAN UPTIMEROBOT
 *
 * Three reasons, in order of weight:
 *
 *   1. UptimeRobot's free tier is 5-minute checks and, since October 2024, is
 *      restricted to personal non-commercial use. Sivan is a payments
 *      company. The paid tier that gives 1-minute checks and SMS starts at
 *      about $7/month.
 *   2. A generic uptime monitor can only see the status code. This reads the
 *      body, so the alert says "3 transfers stuck in flight - check the Breet
 *      webhook log" rather than "site down".
 *   3. The delivery chain already exists here.
 *
 * WHERE THIS MUST RUN
 *
 * NOT on the machine it watches. A watchdog on the same box cannot tell you
 * the box is down, which is the exact scenario external monitoring exists
 * for. Run it on the AWS instance and point it at the Render/API hosts, or
 * vice versa - different infrastructure from the thing being watched.
 *
 * Pair it with ONE free external check (UptimeRobot free, Better Stack's ten
 * free monitors) pointed at the watchdog's own heartbeat, as a dead-man's
 * switch. That is a single monitor, not a monitoring strategy, and it stays
 * inside any free tier.
 *
 * Run: npm run watchdog          (continuous)
 *      npm run watchdog -- --once  (single pass, for cron or a smoke test)
 */

import 'dotenv/config';

const TARGETS = (process.env.WATCHDOG_TARGETS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const BOT_TOKEN = process.env.WATCHDOG_TELEGRAM_BOT_TOKEN ?? '';
const CHAT_ID = process.env.WATCHDOG_TELEGRAM_CHAT_ID ?? '';
const INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_SECONDS ?? 60) * 1000;
/** A single slow response is not an outage. Two in a row usually is. */
const FAILURES_BEFORE_ALERT = Number(process.env.WATCHDOG_FAILURES_BEFORE_ALERT ?? 2);
const HTTP_TIMEOUT_MS = Number(process.env.WATCHDOG_TIMEOUT_SECONDS ?? 25) * 1000;

type State = 'ok' | 'warn' | 'critical' | 'unreachable';

interface TargetState {
  /** What was last ALERTED, not what was last seen. Drives de-duplication. */
  alertedState: State;
  consecutiveFailures: number;
}

const states = new Map<string, TargetState>();

function stateOf(url: string): TargetState {
  let entry = states.get(url);
  if (!entry) {
    entry = { alertedState: 'ok', consecutiveFailures: 0 };
    states.set(url, entry);
  }
  return entry;
}

async function sendTelegram(text: string): Promise<boolean> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('[watchdog] TELEGRAM NOT CONFIGURED - alert not delivered:\n' + text);
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        // HTML rather than Markdown: an unescaped underscore in a signal name
        // like transfers_stuck_in_flight breaks Markdown parsing and Telegram
        // rejects the whole message.
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        text: text.slice(0, 3900),
      }),
    });
    if (!res.ok) {
      console.error(`[watchdog] telegram ${res.status}: ${await res.text().catch(() => '')}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[watchdog] telegram threw:', (error as Error).message);
    return false;
  }
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface ProbeResult {
  state: State;
  httpStatus?: number;
  problems: string[];
  error?: string;
}

/** Read one target's operational health. Exported so a test can drive it. */
export async function probe(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {

    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/health/operational`, {
      signal: controller.signal,
    });
    const body: any = await res.json().catch(() => null);

    // A 404 means the endpoint is not deployed. That is NOT healthy - it is a
    // stale deploy, which is one of the exact incidents this exists to catch,
    // and it must not read as "no problems found".
    if (res.status === 404) {
      return { state: 'critical', httpStatus: 404, problems: ['/health/operational is not deployed on this service (stale build?)'] };
    }
    if (!body || !Array.isArray(body.signals)) {
      return { state: 'unreachable', httpStatus: res.status, problems: [], error: 'unparseable response' };
    }

    const bad = body.signals.filter((s: any) => s.severity !== 'ok');
    return {
      state: body.status as State,
      httpStatus: res.status,
      problems: bad.map((s: any) => `[${s.severity}] ${s.name}: ${s.detail}`),
    };
  } catch (error) {
    return { state: 'unreachable', problems: [], error: (error as Error).message };
  } finally {
    // Always clear it. A leaked abort timer keeps the process alive and, over
    // a long-running watchdog, accumulates one handle per pass.
    clearTimeout(timer);
  }
}

/**
 * Decide whether to alert, and de-duplicate.
 *
 * THE DE-DUPLICATION IS THE POINT. A stuck transfer that messages every
 * minute all night gets muted, and a muted channel is worse than no channel -
 * it looks like coverage and provides none. Alert on TRANSITION only: once
 * when it breaks, once when it recovers.
 *
 * Pure and exported so the behaviour is testable without waiting real minutes.
 */
export function decideAlert(
  previous: TargetState,
  observed: State
): { alert: boolean; kind: 'down' | 'recovered' | null; nextState: TargetState } {
  const isBad = observed === 'critical' || observed === 'unreachable';

  if (isBad) {
    const failures = previous.consecutiveFailures + 1;
    // Flap suppression: one timeout on a cold Render dyno is not an incident.
    if (failures < FAILURES_BEFORE_ALERT) {
      return { alert: false, kind: null, nextState: { ...previous, consecutiveFailures: failures } };
    }
    if (previous.alertedState === observed) {
      // Already told them. Saying it again every minute is how alerting dies.
      return { alert: false, kind: null, nextState: { alertedState: observed, consecutiveFailures: failures } };
    }
    return { alert: true, kind: 'down', nextState: { alertedState: observed, consecutiveFailures: failures } };
  }

  // Healthy now. Only announce if we had previously alerted - otherwise every
  // startup would send a "recovered" for a system that was never down.
  const wasAlerted = previous.alertedState === 'critical' || previous.alertedState === 'unreachable';
  return {
    alert: wasAlerted,
    kind: wasAlerted ? 'recovered' : null,
    nextState: { alertedState: 'ok', consecutiveFailures: 0 },
  };
}

function formatDown(url: string, result: ProbeResult): string {
  const lines = [
    `🔴 <b>Sivan alert</b>`,
    `<code>${escapeHtml(url)}</code>`,
    '',
    result.state === 'unreachable'
      ? `Unreachable: ${escapeHtml(result.error ?? 'no response')}`
      : `HTTP ${result.httpStatus} — status <b>${result.state}</b>`,
  ];
  if (result.problems.length) {
    lines.push('');
    // The detail is the whole value over a generic uptime ping: it says what
    // to go and look at.
    for (const problem of result.problems) lines.push(`• ${escapeHtml(problem)}`);
  }
  lines.push('', new Date().toISOString());
  return lines.join('\n');
}

function formatRecovered(url: string): string {
  return `🟢 <b>Sivan recovered</b>\n<code>${escapeHtml(url)}</code>\n\n${new Date().toISOString()}`;
}

async function runOnce(): Promise<number> {
  let problems = 0;
  for (const url of TARGETS) {
    const result = await probe(url);
    const previous = stateOf(url);
    const decision = decideAlert(previous, result.state);
    states.set(url, decision.nextState);

    const label = `${result.state.toUpperCase().padEnd(11)} ${url}`;
    if (result.state === 'ok') console.log(`[watchdog] ${label}`);
    else {
      problems += 1;
      console.error(`[watchdog] ${label} ${result.problems.join(' | ') || result.error || ''}`);
    }

    if (decision.alert && decision.kind === 'down') await sendTelegram(formatDown(url, result));
    if (decision.alert && decision.kind === 'recovered') await sendTelegram(formatRecovered(url));
  }
  return problems;
}

async function main() {
  if (!TARGETS.length) {
    console.error('WATCHDOG_TARGETS is empty. Set it to a comma-separated list of API base URLs.');
    process.exit(1);
  }
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('WARNING: WATCHDOG_TELEGRAM_BOT_TOKEN / _CHAT_ID unset. Problems will log but NOT alert.');
  }

  const once = process.argv.includes('--once');
  console.log(`[watchdog] watching ${TARGETS.length} target(s) every ${INTERVAL_MS / 1000}s${once ? ' (single pass)' : ''}`);

  if (once) {
    const problems = await runOnce();
    process.exit(problems > 0 ? 1 : 0);
  }

  // Sequential, not setInterval: an interval can overlap itself when a target
  // is slow, and overlapping passes double-count consecutive failures.
  for (;;) {
    await runOnce().catch((error) => console.error('[watchdog] pass threw:', error?.message));
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

// Only run when this file is the entrypoint. `includes('watchdog')` also
// matched test-watchdog.ts, so importing probe() for a test booted the whole
// polling loop and exited on missing config before a single assertion ran.
const entry = process.argv[1] ?? '';
if (/(^|[/\\])watchdog\.(ts|js)$/.test(entry)) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
