import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

type Step = {
  name: string;
  cwd: string;
  command: string;
  required?: boolean;
  env?: Record<string, string>;
  skipIfMissing?: string;
};

type StepResult = {
  name: string;
  command: string;
  cwd: string;
  status: 'passed' | 'failed' | 'skipped';
  exitCode?: number | null;
  durationMs: number;
  startedAt: string;
  completedAt: string;
};

const paymentRoot = process.cwd();
const workspaceRoot = path.dirname(paymentRoot);
const adminHubRoot = process.env.ADMIN_HUB_ROOT || path.join(workspaceRoot, 'sivan-admin-hub');
const startedAt = new Date();

const baseEnv = {
  DATABASE_PROVIDER: 'json',
  EMAIL_PROVIDER: 'console',
  SUPPORT_UPLOAD_PROVIDER: 'mock',
  BRIDGE_MOCK_MODE: 'true',
  AUTH_DEV_SHOW_OTP: 'true',
  CUSTOMER_APP_URL: 'https://app.sivantech.online'
};

const paymentSteps: Step[] = [
  { name: 'Backend TypeScript typecheck', cwd: paymentRoot, command: 'npm run typecheck' },
  { name: 'Backend production build', cwd: paymentRoot, command: 'npm run build' },
  { name: 'Backend production dependency audit', cwd: paymentRoot, command: 'npm audit --omit=dev' },
  { name: 'Frontend dependency install', cwd: paymentRoot, command: 'npm --prefix frontend ci' },
  { name: 'Frontend production build', cwd: paymentRoot, command: 'npm --prefix frontend run build' },
  { name: 'Frontend production dependency audit', cwd: paymentRoot, command: 'npm --prefix frontend audit --omit=dev' },
  { name: 'Webhook signature verification', cwd: paymentRoot, command: 'npm run test:webhook-signature' },
  { name: 'Admin/payment controls E2E', cwd: paymentRoot, command: 'npm run test:controls' },
  { name: 'On-ramp order/reconciliation E2E', cwd: paymentRoot, command: 'npm run test:onramp' },
  { name: 'Support tickets + uploads E2E', cwd: paymentRoot, command: 'npm run test:support' },
  { name: 'User notification preferences E2E', cwd: paymentRoot, command: 'npm run test:preferences' },
  { name: 'Legal acceptance E2E', cwd: paymentRoot, command: 'npm run test:legal' },
  { name: 'Admin operations/hardening E2E', cwd: paymentRoot, command: 'npm run test:admin-ops' },
  { name: 'Shared identity / WhatsApp linking E2E', cwd: paymentRoot, command: 'npm run test:identity' },
  { name: 'Virtual account request/admin E2E', cwd: paymentRoot, command: 'npm run test:virtual-accounts' },
  { name: 'Bridge virtual account mapping coverage', cwd: paymentRoot, command: 'npm run test:bridge-virtual-accounts' },
  { name: 'Virtual account event/webhook ledger E2E', cwd: paymentRoot, command: 'npm run test:virtual-account-events' },
  { name: 'Reference reconciliation E2E', cwd: paymentRoot, command: 'npm run test:reference-reconciliation' },
  { name: 'Transaction timeline E2E', cwd: paymentRoot, command: 'npm run test:transaction-timeline' },
  { name: 'Support internal notes E2E', cwd: paymentRoot, command: 'npm run test:support-notes' },
  { name: 'System incidents E2E', cwd: paymentRoot, command: 'npm run test:system-incidents' },
  { name: 'Ace support triage E2E', cwd: paymentRoot, command: 'npm run test:ace-support' },
  { name: 'Ace WhatsApp support E2E', cwd: paymentRoot, command: 'npm run test:ace-whatsapp' },
  { name: 'Remote Sivan AI support integration E2E', cwd: paymentRoot, command: 'npm run test:sivan-ai-remote-support' },
  { name: 'NGN pipeline E2E', cwd: paymentRoot, command: 'npm run test:ngn-pipeline' },
  { name: 'Bridge customer import E2E', cwd: paymentRoot, command: 'npm run test:bridge-customer-import' },
  { name: 'Bridge KYC no-mock-fallback regression', cwd: paymentRoot, command: 'npm run test:bridge-kyc-no-mock-fallback' },
  { name: 'Internal balance transfer ledger E2E', cwd: paymentRoot, command: 'npm run test:balance-transfer' },
  { name: 'Supplier/cross-border payouts E2E', cwd: paymentRoot, command: 'npm run test:supplier-payments' },
  { name: 'Authenticator 2FA E2E', cwd: paymentRoot, command: 'npm run test:two-factor' },
  { name: 'R2/mock avatar upload E2E', cwd: paymentRoot, command: 'npm run test:avatar-upload' },
  { name: 'Sivan username identity E2E', cwd: paymentRoot, command: 'npm run test:username' },
  { name: 'Customer account recovery + email confirmation E2E', cwd: paymentRoot, command: 'npm run test:account-recovery' }
];

const adminHubSteps: Step[] = [
  { name: 'Admin Hub dependency install', cwd: adminHubRoot, command: 'npm ci', skipIfMissing: path.join(adminHubRoot, 'package.json') },
  { name: 'Admin Hub TypeScript typecheck', cwd: adminHubRoot, command: 'npm run typecheck', skipIfMissing: path.join(adminHubRoot, 'package.json') },
  { name: 'Admin Hub production build', cwd: adminHubRoot, command: 'npm run build', skipIfMissing: path.join(adminHubRoot, 'package.json') },
  { name: 'Admin Hub production dependency audit', cwd: adminHubRoot, command: 'npm audit --omit=dev', skipIfMissing: path.join(adminHubRoot, 'package.json') }
];

async function main() {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  Sivan full platform E2E / deep regression suite');
  console.log('  Scope: payment backend, user frontend, admin hub, identity, recovery, rails');
  console.log('════════════════════════════════════════════════════════════\n');

  const steps = [...paymentSteps, ...adminHubSteps].map((step) => ({ ...step, required: step.required ?? true, env: { ...baseEnv, ...(step.env || {}) } }));
  const results: StepResult[] = [];

  for (const step of steps) {
    if (step.skipIfMissing && !(await exists(step.skipIfMissing))) {
      const now = new Date().toISOString();
      console.log(`\n↷ SKIP ${step.name} — missing ${step.skipIfMissing}`);
      results.push({ name: step.name, command: step.command, cwd: step.cwd, status: 'skipped', durationMs: 0, startedAt: now, completedAt: now });
      continue;
    }
    results.push(await runStep(step));
  }

  const completedAt = new Date();
  const failed = results.filter((result) => result.status === 'failed');
  const skipped = results.filter((result) => result.status === 'skipped');
  const passed = results.filter((result) => result.status === 'passed');
  const report = {
    ok: failed.length === 0,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    summary: {
      total: results.length,
      passed: passed.length,
      failed: failed.length,
      skipped: skipped.length
    },
    coverage: [
      'Backend typecheck/build/audit',
      'User frontend install/build/audit',
      'Admin Hub install/typecheck/build/audit',
      'Auth, legal acceptance, notification preferences',
      'Username, avatar upload, authenticator 2FA, 2FA recovery questions',
      'Customer Account Recovery, admin-started email change, user OTP confirmation, recovery-question reference, old-email alert audit',
      'Support tickets, support uploads, internal notes, Ace support triage',
      'WhatsApp shared identity linking/unlinking',
      'Off-ramp/admin controls, transaction timelines, reconciliation, webhook signature verification',
      'Virtual accounts, Bridge virtual-account mapping, virtual-account event ledger behavior',
      'One-time on-ramp order creation/sync/admin reconciliation',
      'Internal balance ledger transfer controls',
      'Supplier/cross-border payout risk controls and provider release path',
      'NGN pipeline and Bridge KYC no-mock-fallback regression'
    ],
    results
  };

  const reportPath = path.join(paymentRoot, '.data', 'full-platform-e2e-report.json');
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`  Result: ${report.ok ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`  Passed: ${passed.length} / ${results.length}`);
  if (failed.length) console.log(`  Failed: ${failed.map((item) => item.name).join(', ')}`);
  if (skipped.length) console.log(`  Skipped: ${skipped.map((item) => item.name).join(', ')}`);
  console.log(`  Report: ${path.relative(paymentRoot, reportPath)}`);
  console.log('════════════════════════════════════════════════════════════\n');

  if (failed.length) process.exit(1);
}

async function exists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function runStep(step: Step): Promise<StepResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const startedIso = new Date(started).toISOString();
    console.log('\n────────────────────────────────────────────────────────────');
    console.log(`▶ ${step.name}`);
    console.log(`  cwd: ${step.cwd}`);
    console.log(`  cmd: ${step.command}`);
    console.log('────────────────────────────────────────────────────────────');

    const child = spawn(step.command, {
      cwd: step.cwd,
      shell: true,
      stdio: 'inherit',
      env: { ...process.env, ...(step.env || {}) }
    });

    child.on('close', (exitCode) => {
      const completed = Date.now();
      const status = exitCode === 0 ? 'passed' : 'failed';
      console.log(`${status === 'passed' ? '✓' : '✗'} ${step.name} ${status} in ${Math.round((completed - started) / 1000)}s`);
      resolve({
        name: step.name,
        command: step.command,
        cwd: step.cwd,
        status,
        exitCode,
        durationMs: completed - started,
        startedAt: startedIso,
        completedAt: new Date(completed).toISOString()
      });
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
