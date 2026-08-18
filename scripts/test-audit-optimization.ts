import dotenv from 'dotenv';
dotenv.config();

import { PostgresDatabase } from '../src/database/postgres-database.js';
import { createAuditLog, listAuditLogs } from '../src/audit/audit.service.js';

async function benchmark() {
  const db = new PostgresDatabase();
  console.log('================================================================');
  console.log('⚡ AUDIT LOG & QUERY OPTIMIZATION BENCHMARK');
  console.log('================================================================\n');

  // 1. Non-blocking Async Audit Writes
  console.log('🧪 Testing Audit Log Insertion Latency (50 items)...');
  const writeStart = performance.now();
  for (let i = 0; i < 50; i++) {
    await createAuditLog({
      actorType: 'system',
      actorId: 'bench-user',
      action: 'benchmark.test_event',
      resourceType: 'benchmark',
      resourceId: `bench_${i}`,
      severity: 'info',
      metadata: { userId: 'usr_bench', iteration: i },
    });
  }
  const writeDuration = performance.now() - writeStart;
  const avgWriteMs = (writeDuration / 50).toFixed(2);
  console.log(`✅ 50 Audit Logs Queued in ${writeDuration.toFixed(1)}ms (avg ${avgWriteMs}ms per write)`);

  // Ensure flush
  await db.flushAuditLogs();
  console.log('✅ Audit Queue Flushed to Postgres');

  // 2. Targeted Indexed Ledger Queries
  console.log('\n🧪 Testing Ledger Query Latency (listBalanceLedgerLogs)...');
  const ledgerStart = performance.now();
  const ledgerLogs = await db.listBalanceLedgerLogs('usr_bench');
  const ledgerDuration = performance.now() - ledgerStart;
  console.log(`✅ Ledger Query Completed in ${ledgerDuration.toFixed(1)}ms (${ledgerLogs.length} rows returned)`);

  // 3. Paginated Audit Log Queries
  console.log('\n🧪 Testing Paginated Audit Query Latency (listAuditLogs)...');
  const listStart = performance.now();
  const logs = await listAuditLogs(50);
  const listDuration = performance.now() - listStart;
  console.log(`✅ Paginated Audit Query Completed in ${listDuration.toFixed(1)}ms (${logs.length} rows returned)`);

  // 4. db.read() Snapshot Latency
  console.log('\n🧪 Testing db.read() Snapshot Latency...');
  const readStart = performance.now();
  const snapshot = await db.read();
  const readDuration = performance.now() - readStart;
  console.log(`✅ db.read() Snapshot Completed in ${readDuration.toFixed(1)}ms`);

  console.log('\n================================================================');
  console.log('📊 BENCHMARK SUMMARY:');
  console.log(`- Avg Audit Write Latency:     ${avgWriteMs} ms  (Target: < 5 ms)`);
  console.log(`- Ledger Query Latency:        ${ledgerDuration.toFixed(1)} ms  (Target: < 50 ms)`);
  console.log(`- Paginated Audit Read:        ${listDuration.toFixed(1)} ms  (Target: < 50 ms)`);
  console.log('================================================================\n');

  process.exit(0);
}

benchmark().catch((err) => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
