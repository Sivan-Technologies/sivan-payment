import assert from 'node:assert/strict';
import { providerFloatRegistry } from '../src/monitoring/provider-float/float-registry.js';
import type { IProviderFloatAdapter, FloatBalanceResult } from '../src/monitoring/provider-float/float-adapter.interface.js';
import {
  getAdminFloatSettings,
  updateAdminFloatSettings,
  getLiveFloatTelemetry,
} from '../src/admin/admin-float-settings.service.js';
import { evaluateProviderFloats } from '../src/monitoring/provider-float/provider-float-monitor.service.js';

class MockTestFloatAdapter implements IProviderFloatAdapter {
  readonly providerId = 'mock_custom_payout';
  readonly providerName = 'Mock Custom Payout Rail';
  readonly category = 'payout' as const;
  readonly defaultCurrency = 'NGN' as const;

  currentBalance = 100000;

  isConfigured(): boolean {
    return true;
  }

  async fetchFloatBalance(): Promise<FloatBalanceResult> {
    return {
      providerId: this.providerId,
      providerName: this.providerName,
      category: this.category,
      currency: this.defaultCurrency,
      availableBalance: this.currentBalance,
      lastCheckedAt: new Date().toISOString(),
      status: 'healthy',
    };
  }
}

async function main() {
  console.log('[test-provider-float-monitor] Starting float monitoring tests...');

  // 1. Verify default adapters in registry
  const adapters = providerFloatRegistry.getAll();
  const ids = adapters.map((a) => a.providerId);
  console.log('[test-provider-float-monitor] Registered adapters:', ids);
  assert(ids.includes('paystack_payout'), 'Must have Paystack adapter registered');
  assert(ids.includes('vtu_utility'), 'Must have VTU utility adapter registered');
  assert(ids.includes('privy_celo_gas'), 'Must have gas relay adapter registered');
  assert(ids.includes('sivan_offramp_pool'), 'Must have offramp reserve adapter registered');

  // 2. Register mock custom adapter (verifies zero-code-change pluggability)
  const mockAdapter = new MockTestFloatAdapter();
  providerFloatRegistry.register(mockAdapter);
  assert(providerFloatRegistry.get('mock_custom_payout'), 'Custom adapter must be registered');

  // 3. Test settings management and threshold updates
  const initialSettings = await getAdminFloatSettings();
  assert(initialSettings.monitors.paystack_payout, 'Must have paystack monitor configured');
  assert.equal(initialSettings.monitors.paystack_payout.warningThreshold, 50000);
  assert.equal(initialSettings.monitors.paystack_payout.criticalThreshold, 10000);

  // Configure threshold for our mock adapter
  await updateAdminFloatSettings({
    monitors: {
      ...initialSettings.monitors,
      mock_custom_payout: {
        providerId: 'mock_custom_payout',
        name: 'Mock Custom Payout Rail',
        category: 'payout',
        currency: 'NGN',
        warningThreshold: 50000,
        criticalThreshold: 10000,
        enabled: true,
        alertCooldownMinutes: 60,
      },
    },
  }, { updatedBy: 'test_admin', reason: 'Add mock adapter threshold' });

  const updatedSettings = await getAdminFloatSettings();
  assert(updatedSettings.monitors.mock_custom_payout, 'Custom monitor must be saved in settings');

  // 4. Test telemetry when balance is healthy (100,000 NGN > 50,000 warning threshold)
  mockAdapter.currentBalance = 100000;
  let telemetry = await getLiveFloatTelemetry();
  let mockFloat = telemetry.floats.find((f) => f.providerId === 'mock_custom_payout');
  assert(mockFloat, 'Mock float must be in telemetry');
  assert.equal(mockFloat.alertLevel, 'ok');

  // 5. Test telemetry when balance drops into Warning zone (35,000 NGN < 50,000 warning)
  mockAdapter.currentBalance = 35000;
  telemetry = await getLiveFloatTelemetry();
  mockFloat = telemetry.floats.find((f) => f.providerId === 'mock_custom_payout');
  assert.equal(mockFloat?.alertLevel, 'warning', 'Should be warning when below 50,000');

  // Evaluate alerts
  const eval1 = await evaluateProviderFloats();
  console.log('[test-provider-float-monitor] Warning eval result:', eval1);
  assert(eval1.alertsTriggered >= 1, 'Should trigger warning alert');

  // Second evaluation immediately after must be throttled by cooldown
  const eval2 = await evaluateProviderFloats();
  console.log('[test-provider-float-monitor] Cooldown check eval result:', eval2);
  const mockSummary = eval2.summary.find((s) => s.providerId === 'mock_custom_payout');
  assert.equal(mockSummary?.level, 'warning');

  // 6. Test Critical Escalation (balance drops below 10,000 critical threshold: 5,000 NGN)
  mockAdapter.currentBalance = 5000;
  telemetry = await getLiveFloatTelemetry();
  mockFloat = telemetry.floats.find((f) => f.providerId === 'mock_custom_payout');
  assert.equal(mockFloat?.alertLevel, 'critical', 'Should be critical when below 10,000');

  // Should bypass cooldown due to emergency escalation
  const eval3 = await evaluateProviderFloats();
  console.log('[test-provider-float-monitor] Critical escalation eval result:', eval3);
  assert(eval3.alertsTriggered >= 1, 'Should immediately trigger critical alert on escalation');

  // 7. Test Refill Resolution (balance refilled back to 150,000 NGN)
  mockAdapter.currentBalance = 150000;
  telemetry = await getLiveFloatTelemetry();
  mockFloat = telemetry.floats.find((f) => f.providerId === 'mock_custom_payout');
  assert.equal(mockFloat?.alertLevel, 'ok');

  const eval4 = await evaluateProviderFloats();
  console.log('[test-provider-float-monitor] Refill resolution eval result:', eval4);
  assert(eval4.resolutionsTriggered >= 1, 'Should trigger refill resolution alert');

  console.log('✅ [test-provider-float-monitor] All provider float monitoring & alerting tests passed!');
}

main().catch((err) => {
  console.error('❌ [test-provider-float-monitor] Failed:', err);
  process.exit(1);
});
