/**
 * FUND STAGING WALLETS & DVAs (50,000 NGN TEST CREDIT)
 *
 * Backfills the 50,000 NGN welcome test credit facility for all test users
 * with assigned virtual accounts on staging.
 *
 * Strictly blocked in production.
 */

import { backfillStagingDvaTestCredits, grantStagingDvaTestCredit } from '../src/virtual-accounts/service/paystackDvaService.js';
import { db } from '../src/database/json-database.js';
import { isPaystackLive } from '../src/config/paystackConfig.js';

async function main() {
  console.log('\n==================================================');
  console.log('🔷 SIVAN AI . STAGING TEST CREDIT BACKFILL FACILITY');
  console.log('==================================================\n');

  if (isPaystackLive() || process.env.APP_ENV === 'production') {
    console.error('❌ SAFETY REFUSAL: Cannot execute test credit facility in production mode.');
    process.exit(1);
  }

  const accounts = await db.listVirtualAccounts();
  console.log(`Found ${accounts.length} virtual account records in staging database.\n`);

  const result = await backfillStagingDvaTestCredits();
  console.log(`Funded users count: ${result.funded.length}`);
  if (result.funded.length > 0) {
    for (const id of result.funded) {
      console.log(`  ✅ Credited 50,000 NGN to user: ${id}`);
    }
  }

  console.log(`Skipped (already funded / not ready): ${result.skipped.length}`);
  console.log('\n==================================================');
  console.log('✅ Staging test credit facility execution complete.');
  console.log('==================================================\n');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error during test credit execution:', err);
    process.exit(1);
  });
