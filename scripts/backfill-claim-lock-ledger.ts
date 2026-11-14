/**
 * Backfill ledger entries for transit claims that were locked on chain before
 * the lock was mirrored into the balance ledger.
 *
 * Those claims sent real funds to the transit vault but wrote nothing to the
 * ledger, and available balance is replayed from the ledger alone. The senders
 * are therefore still credited for money that has already left the chain.
 *
 * Idempotent. createBalanceLedgerEntry deduplicates on transferId plus kind,
 * so running this twice does not debit anyone twice. Run it against the same
 * environment the claims live in:
 *
 *   npx tsx scripts/backfill-claim-lock-ledger.ts
 */
import { ClaimService } from '../src/claims/claim.service.js';

async function main() {
  console.log('Backfilling ledger entries for on-chain transit claim locks...\n');

  const result = await ClaimService.backfillLockLedger();

  console.log(`  claims scanned        : ${result.scanned}`);
  console.log(`  locks mirrored        : ${result.mirrored}`);
  console.log(`  refunds mirrored      : ${result.refunded}`);
  console.log(`  skipped, no chain tx  : ${result.skippedNoChainTx}`);
  console.log('\nAlready-mirrored claims are deduplicated, so re-running is safe.');
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
