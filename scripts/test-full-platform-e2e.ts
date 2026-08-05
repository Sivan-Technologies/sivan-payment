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
  /**
   * False only for advisory steps. `required` was declared on Step from the
   * start and NEVER READ - any non-zero exit was treated as a hard failure -
   * so an advisory step was silently impossible. Carried onto the result so
   * the summary can tell "this broke the build" from "this wants attention".
   */
  required?: boolean;
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
  /**
   * FRONTEND DEPS FIRST, BEFORE THE BACKEND TYPECHECK. Order matters here.
   *
   * `npm run typecheck` runs tsconfig.scripts.json as well as the API build,
   * and the scripts config deliberately sees frontend source - the test suites
   * assert against the real frontend modules rather than a stale copy. Those
   * modules import react, qrcode-generator and others that live in
   * frontend/node_modules.
   *
   * With the install further down the list, this step failed on any clean
   * checkout with a wall of TS2307 "Cannot find module 'react'" - and passed
   * on any machine that had run the frontend once, which is why it survived
   * local runs and only broke in CI. Reproduced by moving frontend/node_modules
   * aside and re-running.
   */
  { name: 'Frontend dependency install', cwd: paymentRoot, command: 'npm --prefix frontend ci' },
  { name: 'Backend TypeScript typecheck', cwd: paymentRoot, command: 'npm run typecheck' },
  { name: 'Backend production build', cwd: paymentRoot, command: 'npm run build' },
  /**
   * ADVISORY, NOT BLOCKING - and that is a deliberate, temporary decision.
   *
   * 9 advisories, all transitive under @solana/spl-token and @solana/web3.js:
   *   high     bigint-buffer   buffer overflow in toBigIntLE()
   *   moderate uuid            missing bounds check in v3/v5/v6
   *   (+ fast-uri host confusion, which npm audit fix DOES resolve)
   *
   * The two that remain are only fixable by a SemVer-MAJOR change to
   * @solana/spl-token, which is the library that builds every SPL transfer -
   * the code path that moves real user money on Solana. I ran `npm audit fix`
   * and it broke the backend typecheck outright (TS7006 in
   * payment-controls.service.ts), so it is not a drop-in.
   *
   * Blocking every deploy on an advisory we cannot safely clear days before
   * launch would mean either a rushed SDK migration on the money path, or -
   * far more likely - someone deleting this step. Left reporting, so it stays
   * visible in every CI run, and tracked as real work rather than pretended
   * away.
   *
   * TODO(post-launch): upgrade @solana/spl-token, re-run the Solana transfer
   * suites against devnet, then make this blocking again.
   */
  { name: 'Backend production dependency audit (advisory)', cwd: paymentRoot, command: 'npm audit --omit=dev', required: false },
  /**
   * ESLint, with react-hooks/rules-of-hooks as an ERROR.
   *
   * Ahead of the build on purpose: a hook-order violation typechecks and
   * builds perfectly - React error #310 reached a user's browser that way -
   * so the build passing tells you nothing about it. Lint is the only step
   * that can catch it, so it should be the one that fails first and fastest.
   *
   * --max-warnings is a ratchet at the count that existed when linting was
   * introduced. Errors always fail; NEW warnings fail too, so the debt can be
   * paid down but not added to.
   */
  { name: 'Frontend lint (react-hooks rules-of-hooks)', cwd: paymentRoot, command: 'npm --prefix frontend run lint:ci' },
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
  { name: 'PAJ NGN provider adapter E2E', cwd: paymentRoot, command: 'npm run test:paj-ngn-provider' },
  { name: 'Bridge customer import E2E', cwd: paymentRoot, command: 'npm run test:bridge-customer-import' },
  { name: 'Bridge KYC no-mock-fallback regression', cwd: paymentRoot, command: 'npm run test:bridge-kyc-no-mock-fallback' },
  { name: 'Internal balance transfer ledger E2E', cwd: paymentRoot, command: 'npm run test:balance-transfer' },
  { name: 'Supplier/cross-border payouts E2E', cwd: paymentRoot, command: 'npm run test:supplier-payments' },
  { name: 'Authenticator 2FA E2E', cwd: paymentRoot, command: 'npm run test:two-factor' },
  { name: 'R2/mock avatar upload E2E', cwd: paymentRoot, command: 'npm run test:avatar-upload' },
  { name: 'Sivan username identity E2E', cwd: paymentRoot, command: 'npm run test:username' },
  { name: 'Customer account recovery + email confirmation E2E', cwd: paymentRoot, command: 'npm run test:account-recovery' },

  // ───────────────────────────────────────────────────────────────────────────
  // SEVENTY-NINE SUITES THAT WERE NEVER RUN BY ANYTHING.
  //
  // This file drives the ONLY CI job (.github/workflows/ci.yml runs
  // test:full-platform-e2e and nothing else). It listed 28 suites. package.json
  // defines 108. So 79 suites - roughly 2,000 assertions, including several
  // written specifically to stop a production incident recurring - existed
  // purely as commands a human could choose to type.
  //
  // Among the unreachable ones: test:react-hook-order, added after React error
  // #310 took the Receive screen to a blank error boundary in production. The
  // guard against that recurring has never once run automatically.
  //
  // A test nobody runs is worse than no test. It reads as coverage in review,
  // it makes the suite count look healthy, and it silently rots - which is
  // exactly what happened. Wiring these up immediately exposed two suites that
  // had already gone stale against deliberate product changes:
  //
  //   test:breet-identity   demanded the /transactions/:id path that Breet
  //                         404s for a real trade id, after the provider was
  //                         corrected to /trades/sell/:id (d8a6422).
  //   test:receive-no-mock  demanded provider === 'bridge' after the active
  //                         provider was deliberately moved to Privy, because
  //                         Bridge cannot issue wallets to NGN bank-verified
  //                         users (63ddb53). It failed, skipped its live
  //                         checks, and reported 1 of 3 while verifying almost
  //                         nothing.
  //
  // Both were failing on a clean checkout of main before this change. Both are
  // fixed in the same commit.
  //
  // Grouped only for readability; every one is required. If a suite here is
  // genuinely not worth blocking a deploy, delete it rather than leave it
  // unreferenced.
  // ───────────────────────────────────────────────────────────────────────────

  // ---- Money in: deposits detected, recorded, shown and announced ----
  { name: 'Deposit idempotency (at-least-once delivery)', cwd: paymentRoot, command: 'npm run test:deposit-idempotency' },
  { name: 'Deposit detection (balance diff)', cwd: paymentRoot, command: 'npm run test:deposit-detection' },
  { name: 'Deposit notification (exactly once, honest wording)', cwd: paymentRoot, command: 'npm run test:deposit-notification' },

  // ---- Balances and wallets ----
  { name: 'Unified balance', cwd: paymentRoot, command: 'npm run test:unified-balance' },
  { name: 'Wallet chain family (base/ethereum share a key)', cwd: paymentRoot, command: 'npm run test:wallet-chain-family' },
  { name: 'Base wallet sends', cwd: paymentRoot, command: 'npm run test:base-wallet-sends' },
  { name: 'Wallet controls', cwd: paymentRoot, command: 'npm run test:wallet-controls' },
  { name: 'Wallet gate and CORS', cwd: paymentRoot, command: 'npm run test:wallet-gate-and-cors' },
  { name: 'Wallet health signals', cwd: paymentRoot, command: 'npm run test:wallet-health' },
  { name: 'Wallet isolation between users', cwd: paymentRoot, command: 'npm run test:wallet-isolation' },
  { name: 'Mock wallet guard', cwd: paymentRoot, command: 'npm run test:mock-wallet-guard' },
  /**
   * The ONE suite that must not inherit baseEnv.
   *
   * baseEnv sets BRIDGE_MOCK_MODE=true for every step, which is right for the
   * other 100-odd - they need a mock Bridge to run without credentials. This
   * suite exists to assert the opposite: that a production configuration
   * cannot resolve a mock provider, and its first check is literally
   * "BRIDGE_MOCK_MODE is false".
   *
   * So the shared environment made it fail by contradicting its entire
   * premise. Overridden here rather than weakening the assertion, because the
   * assertion is the point: a mock address belongs to nobody and anything sent
   * to one is gone.
   */
  { name: 'No mock provider in production', cwd: paymentRoot, command: 'npm run test:no-mock-in-production', env: { BRIDGE_MOCK_MODE: 'false' } },
  { name: 'Privy wallet provisioning', cwd: paymentRoot, command: 'npm run test:privy-provisioning' },
  { name: 'Privy wallets', cwd: paymentRoot, command: 'npm run test:privy-wallets' },
  { name: 'Delegated signing capability', cwd: paymentRoot, command: 'npm run test:delegated-capability' },
  { name: 'Wallet reprovision approval', cwd: paymentRoot, command: 'npm run test:reprovision-approval' },
  { name: 'NGN wallet provisioning', cwd: paymentRoot, command: 'npm run test:ngn-wallet-provisioning' },
  { name: 'Bridge wallet E2E', cwd: paymentRoot, command: 'npm run test:bridge-wallet-e2e' },

  // ---- Transfers: the path that lost money before ----
  { name: 'Transfer confirmation (nothing could finish a send)', cwd: paymentRoot, command: 'npm run test:transfer-confirmation' },
  { name: 'Transfer confirm dialog', cwd: paymentRoot, command: 'npm run test:transfer-confirm' },
  { name: 'Wallet error honesty (no 500 that blames the user)', cwd: paymentRoot, command: 'npm run test:wallet-error-honesty' },
  { name: 'Transfer fee curve', cwd: paymentRoot, command: 'npm run test:transfer-fee-policy' },
  { name: 'Transfer fee ledger (money must balance)', cwd: paymentRoot, command: 'npm run test:transfer-fee-ledger' },
  { name: 'Transfer fee end-to-end (admin control is live)', cwd: paymentRoot, command: 'npm run test:transfer-fee-e2e' },
  { name: 'Transfer response deadline', cwd: paymentRoot, command: 'npm run test:transfer-response-deadline' },
  { name: 'Transfer toast honesty', cwd: paymentRoot, command: 'npm run test:transfer-toast-honesty' },
  { name: 'Transfer ordering', cwd: paymentRoot, command: 'npm run test:transfer-order' },
  { name: 'Solana transfer', cwd: paymentRoot, command: 'npm run test:solana-transfer' },
  { name: 'No pooled settlement', cwd: paymentRoot, command: 'npm run test:no-pooled-settlement' },
  { name: 'Rail separation', cwd: paymentRoot, command: 'npm run test:rail-separation' },

  // ---- NGN rail ----
  { name: 'Breet + identity toggle', cwd: paymentRoot, command: 'npm run test:breet-identity' },
  { name: 'Breet E2E', cwd: paymentRoot, command: 'npm run test:breet-e2e' },
  { name: 'Breet flagged trades', cwd: paymentRoot, command: 'npm run test:breet-flagged' },
  { name: 'Breet webhook verification', cwd: paymentRoot, command: 'npm run test:breet-webhook-verification' },
  { name: 'NGN margin', cwd: paymentRoot, command: 'npm run test:ngn-margin' },
  { name: 'NGN network pipeline', cwd: paymentRoot, command: 'npm run test:ngn-network-pipeline' },
  { name: 'NGN payout accounts', cwd: paymentRoot, command: 'npm run test:ngn-payout-accounts' },
  { name: 'NGN deposit instruction', cwd: paymentRoot, command: 'npm run test:ngn-deposit-instruction' },
  { name: 'NGN transfer cancellation E2E', cwd: paymentRoot, command: 'npm run test:ngn-cancel-e2e' },
  { name: 'Off-ramp minimum (gas-priced floor)', cwd: paymentRoot, command: 'npm run test:offramp-minimum' },
  { name: 'Off-ramp autosettlement', cwd: paymentRoot, command: 'npm run test:offramp-autosettlement' },
  { name: 'Autosettlement', cwd: paymentRoot, command: 'npm run test:autosettlement' },
  { name: 'Settlement reconciliation', cwd: paymentRoot, command: 'npm run test:settlement-reconciliation' },
  { name: 'Bank name match', cwd: paymentRoot, command: 'npm run test:name-match' },
  { name: 'Bank auto-approve', cwd: paymentRoot, command: 'npm run test:bank-autoapprove' },
  { name: 'Bank match session', cwd: paymentRoot, command: 'npm run test:bank-match-session' },
  { name: 'Session auto-approve', cwd: paymentRoot, command: 'npm run test:session-autoapprove' },

  // ---- KYC, limits and country gating ----
  { name: 'KYC policy', cwd: paymentRoot, command: 'npm run test:kyc-policy' },
  { name: 'KYC ledger', cwd: paymentRoot, command: 'npm run test:kyc-ledger' },
  { name: 'KYC NGN gate', cwd: paymentRoot, command: 'npm run test:kyc-ngn-gate' },
  { name: 'KYC handoff', cwd: paymentRoot, command: 'npm run test:kyc-handoff' },
  { name: 'Admin verification limits', cwd: paymentRoot, command: 'npm run test:admin-verification-limits' },
  { name: 'Verification path', cwd: paymentRoot, command: 'npm run test:verification-path' },
  { name: 'Verification summary', cwd: paymentRoot, command: 'npm run test:verification-summary' },
  { name: 'User country', cwd: paymentRoot, command: 'npm run test:user-country' },
  { name: 'OTP cooldown', cwd: paymentRoot, command: 'npm run test:otp-cooldown' },

  // ---- Fees and virtual accounts ----
  { name: 'Fee API E2E', cwd: paymentRoot, command: 'npm run test:fee-api-e2e' },
  { name: 'On-ramp fee policy', cwd: paymentRoot, command: 'npm run test:onramp-fee-policy' },
  { name: 'Virtual account fee', cwd: paymentRoot, command: 'npm run test:virtual-account-fee' },
  { name: 'Virtual account fee limits', cwd: paymentRoot, command: 'npm run test:va-fee-limits' },
  { name: 'Virtual account reprovision', cwd: paymentRoot, command: 'npm run test:va-reprovision' },

  // ---- Frontend behaviour ----
  { name: 'React hook order (guards React #310)', cwd: paymentRoot, command: 'npm run test:react-hook-order' },
  { name: 'Unified activity feed', cwd: paymentRoot, command: 'npm run test:activity-feed' },
  { name: 'Activity chain marks', cwd: paymentRoot, command: 'npm run test:activity-network-logo' },
  { name: 'Dashboard KPIs', cwd: paymentRoot, command: 'npm run test:dashboard-kpis' },
  { name: 'Dashboard notice', cwd: paymentRoot, command: 'npm run test:dashboard-notice' },
  { name: 'Dashboard setup card', cwd: paymentRoot, command: 'npm run test:dashboard-setup-card' },
  { name: 'Receive screen', cwd: paymentRoot, command: 'npm run test:receive-screen' },
  { name: 'Receive QR decodes to the real address', cwd: paymentRoot, command: 'npm run test:receive-qr-decode' },
  { name: 'Receive never shows a mock address', cwd: paymentRoot, command: 'npm run test:receive-no-mock' },
  { name: 'Block explorer links', cwd: paymentRoot, command: 'npm run test:block-explorer' },
  { name: 'Bank picker', cwd: paymentRoot, command: 'npm run test:bank-picker' },
  { name: 'Buy gate', cwd: paymentRoot, command: 'npm run test:buy-gate' },
  { name: 'Console clean (no leaked logging)', cwd: paymentRoot, command: 'npm run test:console-clean' },

  // ---- Whole-system and safety nets ----
  { name: 'Full system', cwd: paymentRoot, command: 'npm run test:full-system' },
  { name: 'Failure paths', cwd: paymentRoot, command: 'npm run test:failure-paths' },
  { name: 'No internal leaks', cwd: paymentRoot, command: 'npm run test:no-internal-leaks' },
  { name: 'Hot path reads', cwd: paymentRoot, command: 'npm run test:hot-path-reads' },
  { name: 'Operational health', cwd: paymentRoot, command: 'npm run test:operational-health' },
  { name: 'Webhook body parsing (crashed production once)', cwd: paymentRoot, command: 'npm run test:webhook-body-parsing' },
  { name: 'Database migrations', cwd: paymentRoot, command: 'npm run test:migrations' },
  { name: 'Watchdog', cwd: paymentRoot, command: 'npm run test:watchdog' },
  { name: 'Build isolation (API must not compile frontend source)', cwd: paymentRoot, command: 'npm run test:build-isolation' },
  { name: 'Lint hook guard (react-hooks is on and blocking)', cwd: paymentRoot, command: 'npm run test:lint-hooks' },
  { name: 'CI coverage (no suite may be orphaned)', cwd: paymentRoot, command: 'npm run test:ci-coverage' }
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
  const allFailed = results.filter((result) => result.status === 'failed');
  // Advisory steps report but do not block. Everything defaults to required,
  // so opting out is a visible `required: false` in the step definition.
  const failed = allFailed.filter((result) => result.required !== false);
  const advisory = allFailed.filter((result) => result.required === false);
  const skipped = results.filter((result) => result.status === 'skipped');
  const passed = results.filter((result) => result.status === 'passed');
  const report = {
    ok: failed.length === 0,
    advisoryFailures: advisory.map((item) => item.name),
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
      'NGN pipeline, PAJ provider adapter, and Bridge KYC no-mock-fallback regression'
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
  if (advisory.length) console.log(`  Advisory (not blocking): ${advisory.map((item) => item.name).join(', ')}`);
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
      const required = step.required !== false;
      const mark = status === 'passed' ? '✓' : required ? '✗' : '⚠';
      const suffix = status === 'failed' && !required ? ' (advisory - not blocking)' : '';
      console.log(`${mark} ${step.name} ${status}${suffix} in ${Math.round((completed - started) / 1000)}s`);
      resolve({
        name: step.name,
        command: step.command,
        cwd: step.cwd,
        status,
        required,
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
