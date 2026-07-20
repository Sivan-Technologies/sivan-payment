import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '../src/database/json-database.js';
import { env } from '../src/config/env.js';
import { nowIso } from '../src/shared/id.js';
import { applyBridgeVirtualAccountEvent } from '../src/virtual-accounts/service/virtual-account-events.service.js';
import type { VirtualAccountRecord } from '../src/virtual-accounts/types/virtual-account.types.js';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  console.log(`✓ ${message}`);
}

async function main() {
  const dbPath = path.isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : path.join(process.cwd(), env.DATABASE_FILE);
  await fs.rm(dbPath, { force: true });
  const now = nowIso();
  await db.upsertVirtualAccountRecord({
    id: 'va_internal_test',
    userId: 'usr_test',
    customerId: 'cus_test',
    provider: 'bridge',
    providerAccountId: 'va_bridge_test',
    currency: 'usd',
    country: 'US',
    bankName: 'Lead Bank',
    accountNumberMasked: '••••0000',
    routingNumberMasked: '••••9644',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  } as VirtualAccountRecord);

  await applyBridgeVirtualAccountEvent({
    event_id: 'wh_va_funds_received',
    event_category: 'virtual_account',
    event_type: 'virtual_account_event.created',
    event_object_id: 'va_event_1',
    event_object: {
      id: 'va_event_1',
      customer_id: 'bridge_customer',
      virtual_account_id: 'va_bridge_test',
      type: 'funds_received',
      amount: '120.0',
      currency: 'usd',
      subtotal_amount: '120.0',
      deposit_id: 'deposit_123',
      created_at: now,
      source: { payment_rail: 'ach_push', trace_number: '111222333444555', sender_name: 'Ada Lovelace' },
    },
  });

  let data = await db.read();
  assert(data.virtualAccountEvents.length === 1, 'funds_received event is stored');
  assert(data.virtualAccountTransactions.length === 1, 'funds_received creates transaction');
  assert(data.virtualAccountTransactions[0].status === 'funds_received', 'transaction status is funds_received');
  assert(data.virtualAccountTransactions[0].paymentRail === 'ach_push', 'payment rail stored');

  await applyBridgeVirtualAccountEvent({
    event_id: 'wh_va_payment_processed',
    event_category: 'virtual_account',
    event_type: 'virtual_account_event.updated',
    event_object_id: 'va_event_2',
    event_object: {
      id: 'va_event_2',
      customer_id: 'bridge_customer',
      virtual_account_id: 'va_bridge_test',
      type: 'payment_processed',
      amount: '116.55',
      currency: 'usd',
      subtotal_amount: '120.0',
      destination_tx_hash: '0xdeadbeef',
      deposit_id: 'deposit_123',
      created_at: now,
      source: { payment_rail: 'ach_push', trace_number: '111222333444555', sender_name: 'Ada Lovelace' },
      receipt: { final_amount: '116.55', destination_tx_hash: '0xdeadbeef' },
    },
  });

  data = await db.read();
  assert(data.virtualAccountEvents.length === 2, 'payment_processed event is stored');
  assert(data.virtualAccountTransactions.length === 1, 'same deposit updates existing transaction');
  assert(data.virtualAccountTransactions[0].status === 'completed', 'transaction becomes completed');
  assert(data.virtualAccountTransactions[0].destinationTxHash === '0xdeadbeef', 'destination tx hash is stored');
  assert(Boolean(data.virtualAccountTransactions[0].completedAt), 'completedAt is set');

  console.log('\n✅ Virtual account event processing test passed');
}

main().catch((error) => { console.error(error); process.exit(1); });
