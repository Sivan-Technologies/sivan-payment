import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env.staging') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import assert from 'assert';
import { NombaUtilityProvider } from '../src/ngn/provider/nomba-utility.provider.js';
import {
  getUtilityProvider,
  getUtilityRouting,
  providerServes,
  listUtilityProviderCapabilities,
} from '../src/ngn/provider/utility-registry.js';
import { resolveProviderPlanCode } from '../src/ngn/service/utility-data-plans.service.js';

async function run() {
  console.log('Testing Nomba Utility Provider & Fallback Integration...\n');

  // 1. Nomba provider instantiation & capabilities
  const nomba = new NombaUtilityProvider();
  assert.strictEqual(nomba.name, 'nomba');
  assert.deepStrictEqual(nomba.supports, ['electricity', 'cable_tv', 'airtime', 'data']);
  console.log('✓ NombaUtilityProvider supports: [electricity, cable_tv, airtime, data]');

  // 2. Registry verification
  const regNomba = getUtilityProvider('nomba');
  assert.ok(regNomba, 'Nomba should be registered in utility registry');
  assert.strictEqual(providerServes(regNomba, 'airtime'), true);
  assert.strictEqual(providerServes(regNomba, 'data'), true);
  assert.strictEqual(providerServes(regNomba, 'electricity'), true);
  assert.strictEqual(providerServes(regNomba, 'cable_tv'), true);
  console.log('✓ Registry capability checks: Nomba serves airtime, data, electricity, cable_tv');

  // 3. Routing hierarchy verification
  const routing = getUtilityRouting();
  console.log('\nActive Default Utility Routing:');
  console.log('Airtime chain:', routing.routes.airtime);
  console.log('Data chain:', routing.routes.data);
  console.log('Electricity chain:', routing.routes.electricity);
  console.log('Cable TV chain:', routing.routes.cable_tv);

  assert.strictEqual(routing.routes.airtime[0], 'smeapi', 'Airtime primary must be smeapi');
  assert.ok(routing.routes.airtime.includes('nomba'), 'Airtime chain must include nomba fallback');
  assert.strictEqual(routing.failover.airtime, true, 'Airtime failover must be enabled');

  assert.strictEqual(routing.routes.data[0], 'smeapi', 'Data primary must be smeapi');
  assert.ok(routing.routes.data.includes('nomba'), 'Data chain must include nomba fallback');
  assert.strictEqual(routing.failover.data, true, 'Data failover must be enabled');

  assert.strictEqual(routing.routes.electricity[0], 'nomba', 'Electricity primary must be nomba');
  assert.strictEqual(routing.routes.cable_tv[0], 'nomba', 'Cable TV primary must be nomba');
  console.log('✓ Routing matrix correctly prioritizes SME API with Nomba fallback for Telco, and Nomba primary for Bills');

  // 4. Data plan resolution for Nomba fallback
  const mockSmePlan = {
    id: 'plan_mtn_1gb',
    bundleSize: '1GB',
    amountNgn: 430,
    costPriceNgn: 380,
    markupNgn: 50,
    network: 'mtn',
    isActive: true,
    planCode: 'DATA_MTN_1GB',
    providerPlanCodes: {
      smeapi: '2',
    },
    updatedAt: new Date().toISOString(),
    updatedBy: 'admin',
  };

  const nombaResolvedCode = resolveProviderPlanCode(mockSmePlan, 'nomba');
  assert.strictEqual(nombaResolvedCode, '1GB', 'Nomba should resolve bundleSize for dynamic catalog matching');
  console.log('✓ Dynamic plan code resolver safely handles Nomba fallback without pre-mapping requirement');

  // 5. Capabilities list check
  const capabilities = listUtilityProviderCapabilities();
  const nombaCap = capabilities.find((c) => c.name === 'nomba');
  assert.ok(nombaCap, 'Nomba capability record should exist');
  assert.strictEqual(nombaCap.configured, true, 'Nomba should be credentialed and configured');
  console.log('✓ Provider capabilities list shows Nomba configured and ready');

  console.log('\nAll Nomba utility integration tests PASSED successfully!');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
