import dotenv from 'dotenv';
dotenv.config({ path: '.env.staging' });
dotenv.config({ path: '.env-sandbox' });
dotenv.config();

import { getActiveBankingRailName, getBankingRailAdapter } from '../src/banking-rail/banking-rail-registry.js';

async function main() {
  console.log('==============================================');
  console.log('SIVAN AI . ACTIVE BANKING RAIL VERIFICATION');
  console.log('==============================================');

  const activeRail = getActiveBankingRailName();
  console.log(`Active Banking Rail Name: [${activeRail}]`);

  if (activeRail !== 'nomba') {
    console.error(`FAILURE: Expected active rail to be 'nomba', got '${activeRail}'`);
    process.exit(1);
  }

  const adapter = getBankingRailAdapter();
  console.log(`Resolved Adapter Class:   ${adapter.constructor.name}`);
  console.log(`Adapter Rail Name:        ${adapter.name}`);
  console.log(`Is Configured:            ${adapter.isConfigured()}`);

  if (adapter.name !== 'nomba') {
    console.error(`FAILURE: Resolved adapter is not nomba!`);
    process.exit(1);
  }

  console.log('\n--- Testing Virtual Account Generation via Active Rail Adapter ---');
  const dummyUserId = `usr_test_${Date.now()}`;
  const va = await adapter.assignVirtualAccount(`NOMBA_CUS_${dummyUserId}`);
  console.log('Virtual Account Created Successfully:');
  console.log(JSON.stringify(va, null, 2));

  console.log('\n==============================================');
  console.log('VERIFICATION COMPLETE: NOMBA IS ACTIVE & WORKING!');
  console.log('==============================================');
}

main().catch((err) => {
  console.error('Fatal error during active rail verification:', err);
  process.exit(1);
});

