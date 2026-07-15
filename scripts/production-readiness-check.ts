import { env } from '../src/config/env.js';
type Check = { name: string; ok: boolean; detail?: unknown; severity?: 'pass' | 'warn' | 'fail' };

const liveBackend = process.env.LIVE_API_BASE_URL || 'https://sivan-payments-api-live.onrender.com';
const testBackend = process.env.TEST_API_BASE_URL || 'https://sivan-payments-api-test.onrender.com';
const liveUserApp = process.env.LIVE_USER_APP_URL || 'https://app.sivantech.online';
const testUserApp = process.env.TEST_USER_APP_URL || 'https://sivan-payments-user-test.vercel.app';
const adminApp = process.env.ADMIN_APP_URL || 'https://sivan-payment.vercel.app';
const homepage = process.env.HOMEPAGE_URL || 'https://www.sivantech.online';

const checks: Check[] = [];

await checkBackend('live backend', liveBackend, liveUserApp);
await checkBackend('test backend', testBackend, testUserApp);
await checkFrontend('live user app', liveUserApp, ['/', '/dashboard', '/buy', '/withdraw', '/settings', '/help']);
await checkFrontend('test user app', testUserApp, ['/', '/dashboard', '/buy', '/withdraw', '/settings', '/help']);
await checkFrontend('admin app', adminApp, ['/', '/support', '/controls']);
await checkFrontend('homepage legal', homepage, ['/legal/terms', '/legal/privacy', '/legal/risk-disclosure', '/legal/aml-kyc', '/legal/wrong-network']);
checkLocalEnvReadiness();

const failed = checks.filter((check) => !check.ok && check.severity !== 'warn');
const warnings = checks.filter((check) => !check.ok && check.severity === 'warn');
console.log(JSON.stringify({
  ok: failed.length === 0,
  summary: {
    total: checks.length,
    passed: checks.filter((check) => check.ok).length,
    warnings: warnings.length,
    failed: failed.length
  },
  checks
}, null, 2));

if (failed.length) process.exit(1);

async function checkBackend(name: string, baseUrl: string, origin: string) {
  const health = await fetchJson(`${baseUrl}/health`);
  record(`${name} /health`, health.ok, health.detail);

  const db = await fetchJson(`${baseUrl}/health/db`);
  record(`${name} /health/db`, db.ok, db.detail);

  const fees = await fetchJson(`${baseUrl}/api/onramp/fees`);
  record(`${name} on-ramp fees`, fees.ok && Boolean((fees.detail as any)?.body?.data?.percent), fees.detail);

  const controls = await fetchJson(`${baseUrl}/api/offramp/controls`);
  const networks = (controls.detail as any)?.body?.data?.sourceNetworks ?? [];
  const avalanche = networks.find((item: any) => item.network === 'avalanche_c_chain');
  const nonAvalancheEnabled = networks.filter((item: any) => item.network !== 'avalanche_c_chain' && item.enabled);
  record(`${name} controls Avalanche-first`, controls.ok && avalanche?.enabled === true && nonAvalancheEnabled.length === 0, {
    avalancheEnabled: avalanche?.enabled,
    nonAvalancheEnabled: nonAvalancheEnabled.map((item: any) => item.network)
  });

  const cors = await fetch(`${baseUrl}/health`, { headers: { Origin: origin } }).catch((error) => error);
  if (cors instanceof Error) {
    record(`${name} CORS check`, false, cors.message);
  } else {
    const allowOrigin = cors.headers.get('access-control-allow-origin');
    record(`${name} CORS allows ${origin}`, cors.ok && (allowOrigin === origin || allowOrigin === '*'), { status: cors.status, allowOrigin });
  }
}

async function checkFrontend(name: string, baseUrl: string, routes: string[]) {
  for (const route of routes) {
    const res = await fetch(`${baseUrl}${route}`).catch((error) => error);
    if (res instanceof Error) {
      record(`${name} ${route}`, false, res.message);
    } else {
      record(`${name} ${route}`, res.ok, { status: res.status });
    }
  }
}

function checkLocalEnvReadiness() {
  const requiredBackend = ['DATABASE_PROVIDER', 'DATABASE_URL', 'ADMIN_API_KEY', 'USER_JWT_SECRET', 'SENTRY_DSN', 'BRIDGE_API_KEY', 'BRIDGE_WEBHOOK_PUBLIC_KEY', 'CORS_ORIGIN'];
  const envObject = env as unknown as Record<string, unknown>;
  const missingBackend = requiredBackend.filter((key) => !envObject[key]);
  record('local backend env completeness for Render', missingBackend.length === 0, { missing: missingBackend }, missingBackend.length ? 'warn' : 'pass');

  const manualMonitoring = [
    'Sentry project exists for backend and user frontend',
    'Sentry alert rule: any production error > 0 in 5 minutes notifies ops',
    'Sentry alert rule: transaction failure spike / webhook 400 spike notifies ops',
    'Render health checks enabled on /health',
    'Render deploy notifications enabled',
    'Vercel deployment failure notifications enabled'
  ];
  record('manual monitoring alert checklist', false, { mustConfirmInDashboards: manualMonitoring }, 'warn');
}

async function fetchJson(url: string) {
  try {
    const res = await fetch(url);
    const text = await res.text();
    let detail: unknown = text;
    try { detail = text ? JSON.parse(text) : {}; } catch {}
    return { ok: res.ok, detail: { status: res.status, body: detail } };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function record(name: string, ok: boolean, detail?: unknown, severity: 'pass' | 'warn' | 'fail' = ok ? 'pass' : 'fail') {
  checks.push({ name, ok, detail, severity });
}
