import * as Sentry from '@sentry/node';
import { env } from '../src/config/env.js';

type Check = { name: string; ok: boolean; severity: 'pass' | 'warn' | 'fail'; detail?: unknown };
const checks: Check[] = [];

const urls = {
  liveBackend: 'https://sivan-payments-api-live.onrender.com',
  testBackend: 'https://sivan-payments-api-test.onrender.com',
  liveUser: 'https://app.sivantech.online',
  testUser: 'https://sivan-payments-user-test.vercel.app',
  admin: 'https://sivan-payment.vercel.app'
};

await checkHealth(`${urls.liveBackend}/health`, 'Render live backend health');
await checkHealth(`${urls.testBackend}/health`, 'Render test backend health');
await checkFrontendSentry(urls.liveUser, 'Vercel live user frontend Sentry bundle');
await checkFrontendSentry(urls.testUser, 'Vercel test user frontend Sentry bundle');
await checkFrontendSentry(urls.admin, 'Vercel admin frontend Sentry bundle');
await sendSentrySmokeEvent();
checkDashboardApiTokens();

const failed = checks.filter((item) => !item.ok && item.severity === 'fail');
console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
if (failed.length) process.exit(1);

async function checkHealth(url: string, name: string) {
  try {
    const res = await fetch(url);
    record(name, res.ok, res.ok ? 'pass' : 'fail', { status: res.status });
  } catch (error) { record(name, false, 'fail', error instanceof Error ? error.message : String(error)); }
}

async function checkFrontendSentry(baseUrl: string, name: string) {
  try {
    const html = await (await fetch(baseUrl)).text();
    const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]).slice(0, 3);
    let bundle = '';
    for (const script of scripts) {
      const full = script.startsWith('http') ? script : `${baseUrl.replace(/\/$/, '')}${script}`;
      bundle += await (await fetch(full)).text();
    }
    const hasSentryDsn = bundle.includes('sentry.io') || bundle.includes('ingest.');
    record(name, hasSentryDsn, hasSentryDsn ? 'pass' : 'warn', { scripts, hasSentryDsn });
  } catch (error) { record(name, false, 'warn', error instanceof Error ? error.message : String(error)); }
}

async function sendSentrySmokeEvent() {
  if (!env.SENTRY_DSN) return record('Sentry backend smoke event', false, 'warn', 'SENTRY_DSN missing');
  Sentry.init({ dsn: env.SENTRY_DSN, environment: env.SENTRY_ENVIRONMENT || env.APP_ENV, tracesSampleRate: 0, release: `monitoring-smoke-${Date.now()}` });
  const eventId = Sentry.captureMessage('Sivan monitoring smoke test - non-error', 'info');
  const flushed = await Sentry.flush(5000);
  record('Sentry backend smoke event accepted', Boolean(eventId) && flushed, Boolean(eventId) && flushed ? 'pass' : 'fail', { eventId, flushed, environment: env.SENTRY_ENVIRONMENT || env.APP_ENV });
}

function checkDashboardApiTokens() {
  const required = ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT', 'RENDER_API_KEY', 'VERCEL_TOKEN'];
  const missing = required.filter((key) => !process.env[key]);
  record('Dashboard alert-rule API verification', missing.length === 0, 'warn', missing.length ? { missing, note: 'Cannot programmatically confirm Sentry/Render/Vercel alert rules without dashboard/API tokens. Manual dashboard confirmation still required.' } : { note: 'Tokens available; extend script to query provider alert APIs.' });
}

function record(name: string, ok: boolean, severity: 'pass' | 'warn' | 'fail', detail?: unknown) { checks.push({ name, ok, severity, detail }); }
