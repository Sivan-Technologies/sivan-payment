import { spawnSync } from 'node:child_process';

interface TestSuite {
  name: string;
  command: string;
  env?: Record<string, string>;
}

const TEST_SUITES: TestSuite[] = [
  {
    name: 'Build Isolation & Type Checks',
    command: 'tsx scripts/test-build-isolation.ts',
  },
  {
    name: 'Webhook Signature Verification',
    command: 'tsx scripts/test-webhook-signature.ts',
  },
  {
    name: 'Fee & Schema Invariants',
    command: 'tsx scripts/test-fee-and-schema-invariants.ts',
  },
  {
    name: 'User Username Management & Resolution',
    command: 'tsx scripts/test-username.ts',
    env: {
      DATABASE_PROVIDER: 'json',
      DATABASE_FILE: '.data/test-username.json',
      EMAIL_PROVIDER: 'console',
      SUPPORT_UPLOAD_PROVIDER: 'mock',
      BRIDGE_MOCK_MODE: 'true',
    },
  },
  {
    name: 'Balance Transfer Ledger & Controls',
    command: 'tsx scripts/test-balance-transfer.ts',
    env: {
      DATABASE_PROVIDER: 'json',
      DATABASE_FILE: '.data/test-balance-transfer.json',
      EMAIL_PROVIDER: 'console',
      SUPPORT_UPLOAD_PROVIDER: 'mock',
      ADMIN_API_KEY: 'balance-admin-key',
      BALANCE_TRANSFERS_ENABLED: 'false',
    },
  },
  {
    name: 'Deposit Confirmation & Webhook Processing',
    command: 'tsx scripts/test-deposit-confirmation.ts',
    env: {
      DATABASE_PROVIDER: 'json',
      DATABASE_FILE: '.data/test-deposit-confirmation.json',
      EMAIL_PROVIDER: 'console',
      SUPPORT_UPLOAD_PROVIDER: 'mock',
      WALLET_PROVIDER: 'mock',
    },
  },
  {
    name: 'Wallet Controls & Isolation',
    command: 'tsx scripts/test-wallet-controls.ts',
    env: {
      DATABASE_PROVIDER: 'json',
      DATABASE_FILE: '.data/test-wallet-controls.json',
      EMAIL_PROVIDER: 'console',
      APP_ENV: 'development',
    },
  },
  {
    name: 'User Preferences & Settings Policy',
    command: 'tsx scripts/test-user-preferences.ts',
    env: {
      DATABASE_PROVIDER: 'json',
      DATABASE_FILE: '.data/test-preferences.json',
      EMAIL_PROVIDER: 'console',
      BRIDGE_MOCK_MODE: 'true',
    },
  },
  {
    name: 'System Incidents & Admin Health Tracking',
    command: 'tsx scripts/test-system-incidents.ts',
    env: {
      DATABASE_PROVIDER: 'json',
      DATABASE_FILE: '.data/test-system-incidents.json',
      EMAIL_PROVIDER: 'console',
      SUPPORT_UPLOAD_PROVIDER: 'mock',
      BRIDGE_MOCK_MODE: 'true',
    },
  },
  {
    name: 'Legal Terms Acceptance & User Audit Verification',
    command: 'tsx scripts/test-legal-acceptance.ts',
    env: {
      DATABASE_PROVIDER: 'json',
      DATABASE_FILE: '.data/test-legal.json',
      EMAIL_PROVIDER: 'console',
      BRIDGE_MOCK_MODE: 'true',
    },
  },
];

function runMasterTestRunner() {
  console.log('\n==================================================');
  console.log('🚀 SIVAN PAYMENT - MASTER TEST SUITE RUNNER');
  console.log('==================================================\n');

  const startTime = Date.now();
  let passedCount = 0;
  let failedCount = 0;

  for (const suite of TEST_SUITES) {
    console.log(`▶ Running Suite: ${suite.name}...`);
    const envVars = {
      ...process.env,
      ...(suite.env || {}),
    };

    const result = spawnSync('npx', suite.command.split(' '), {
      cwd: process.cwd(),
      env: envVars,
      stdio: 'inherit',
    });

    if (result.status === 0) {
      passedCount++;
      console.log(`\n✅ PASSED: ${suite.name}\n`);
    } else {
      failedCount++;
      console.log(`\n❌ FAILED: ${suite.name} (Exit code: ${result.status})\n`);
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('==================================================');
  console.log('📊 MASTER TEST SUMMARY');
  console.log('==================================================');
  console.log(`Total Suites: ${TEST_SUITES.length}`);
  console.log(`Passed:       ${passedCount}`);
  console.log(`Failed:       ${failedCount}`);
  console.log(`Duration:     ${durationSec}s`);
  console.log('==================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runMasterTestRunner();
