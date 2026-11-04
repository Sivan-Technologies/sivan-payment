import assert from 'node:assert/strict';
import { db } from '../src/database/json-database.js';
import { createAuditLog, archiveExpiredAuditLogs, listArchivedAuditLogs, getAuditArchiveStatus, listAuditLogs } from '../src/audit/audit.service.js';

async function main() {
  console.log('[test-audit-archival] Starting audit log archival test...');

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  // 1. Create a recent audit log (1 day ago)
  const recentLog = await createAuditLog({
    actorType: 'user',
    actorId: 'usr_recent_1',
    action: 'wallet.balance_viewed',
    resourceType: 'wallet',
    resourceId: 'wal_1',
    createdAt: new Date(now - 1 * dayMs).toISOString(),
    metadata: { test: true },
  });

  // 2. Create an expired audit log (95 days ago)
  const expiredLog = await createAuditLog({
    actorType: 'admin',
    actorId: 'adm_old_1',
    action: 'admin.settings_viewed',
    resourceType: 'system_setting',
    resourceId: 'sett_1',
    createdAt: new Date(now - 95 * dayMs).toISOString(),
    metadata: { test: true },
  });

  // 3. Create an expired financial balance ledger entry (100 days ago)
  const testUserId = 'usr_ledger_continuity_test';
  const oldLedgerLog = await createAuditLog({
    actorType: 'system',
    actorId: 'system',
    action: 'balance.ledger_entry',
    resourceType: 'balance',
    resourceId: 'bal_1',
    createdAt: new Date(now - 100 * dayMs).toISOString(),
    metadata: {
      userId: testUserId,
      entryId: 'ent_continuity_1',
      type: 'credit',
      amount: '50.00',
      currency: 'usdc',
    },
  });

  // Check initial counts
  const beforeStats = await getAuditArchiveStatus();
  console.log('[test-audit-archival] Stats before archival:', beforeStats);
  assert(beforeStats.activeCount >= 3, 'Should have at least 3 active audit logs');

  // 4. Run archival with 90-day threshold
  const outcome = await archiveExpiredAuditLogs(90);
  console.log('[test-audit-archival] Archival outcome:', outcome);
  assert(outcome.archivedCount >= 2, `Expected at least 2 logs archived, got ${outcome.archivedCount}`);

  // 5. Verify active audit logs no longer contain the expired logs
  const activeLogs = await listAuditLogs(500);
  const activeIds = new Set(activeLogs.map((l: any) => l.id));
  assert(activeIds.has(recentLog.id), 'Recent log must still be in active audit logs');
  assert(!activeIds.has(expiredLog.id), 'Expired admin log must be removed from active audit logs');
  assert(!activeIds.has(oldLedgerLog.id), 'Expired ledger log must be removed from active audit logs');

  // 6. Verify archived audit logs contain the expired logs
  const archivedLogs = await listArchivedAuditLogs({ limit: 100 });
  const archivedIds = new Set(archivedLogs.map((l) => l.id));
  assert(archivedIds.has(expiredLog.id), 'Expired admin log must exist in archive');
  assert(archivedIds.has(oldLedgerLog.id), 'Expired ledger log must exist in archive');

  const sampleArchived = archivedLogs.find((l) => l.id === expiredLog.id);
  assert(sampleArchived?.archivedAt, 'Archived log must carry archivedAt timestamp');

  // 7. HIGHEST PRIORITY TEST: Financial Ledger Integrity Continuity
  // listBalanceLedgerLogs must still return the 100-day-old ledger entry even though it was archived!
  const userLedger = await db.listBalanceLedgerLogs(testUserId);
  assert.equal(userLedger.length, 1, 'Ledger logs must include archived entries so historical balances never truncate');
  assert.equal(userLedger[0].id, oldLedgerLog.id, 'Returned ledger entry must match old archived entry');
  assert.equal((userLedger[0].metadata as any)?.entryId, 'ent_continuity_1');

  // 8. Verify stats after archival
  const afterStats = await getAuditArchiveStatus();
  console.log('[test-audit-archival] Stats after archival:', afterStats);
  assert(afterStats.archiveCount >= 2, 'Archive count should be at least 2');

  console.log('✅ [test-audit-archival] All tests passed! Banking compliance audit archival and ledger continuity verified.');
}

main().catch((err) => {
  console.error('❌ [test-audit-archival] Failed:', err);
  process.exit(1);
});
