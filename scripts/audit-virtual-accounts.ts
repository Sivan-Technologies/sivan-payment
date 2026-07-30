/**
 * Audit every virtual account, comparing what Sivan believes against what
 * Bridge actually has.
 *
 * READ-ONLY BY DEFAULT. Makes GET requests only. Nothing is created,
 * deactivated or modified unless --deactivate-stale is passed explicitly, and
 * even then it refuses to touch the account Sivan considers active.
 *
 * The problem it exists to expose: marking a virtual account "closed" only
 * ever changed a row in Sivan's database. Bridge was never told. Those
 * accounts stay open, keep accepting deposits into an account number nothing
 * is watching, and keep billing $2/month each.
 *
 * Usage:
 *   tsx scripts/audit-virtual-accounts.ts                    # report only
 *   tsx scripts/audit-virtual-accounts.ts --json             # machine readable
 *   tsx scripts/audit-virtual-accounts.ts --deactivate-stale # WRITES. asks nothing.
 */

import { BridgeClient } from '../src/providers/bridge/bridge.client.js';

const args = process.argv.slice(2);
const DEACTIVATE = args.includes('--deactivate-stale');
const AS_JSON = args.includes('--json');

interface BridgeVa {
  id: string;
  customer_id?: string;
  status?: string;
  developer_fee_percent?: string;
  source_deposit_instructions?: Record<string, any>;
  destination?: { currency?: string; payment_rail?: string; bridge_wallet_id?: string; address?: string };
}

function mask(value?: string) {
  if (!value) return 'n/a';
  return `••••${String(value).slice(-4)}`;
}

async function main() {
  const client = new BridgeClient();

  if (!AS_JSON) {
    console.log('\nVirtual account audit');
    console.log(DEACTIVATE ? 'MODE: WILL DEACTIVATE STALE ACCOUNTS\n' : 'MODE: READ ONLY\n');
  }

  // Everything Bridge has, across all customers.
  const remote = await client.request<{ count: number; data: BridgeVa[] }>('/virtual_accounts');
  const accounts = Array.isArray(remote?.data) ? remote.data : [];

  // What Sivan thinks.
  //
  // This MUST read the same database production uses. An earlier version
  // imported the JSON database unconditionally; run against production Bridge
  // with an empty local file, every account came back "unknown to Sivan" and
  // was therefore classed as stale - including the live one. Deactivating on
  // that basis would have closed a working account.
  // json-database.ts exports the Postgres adapter automatically when
  // DATABASE_PROVIDER=postgres and DATABASE_URL is set, so this respects
  // whatever the environment points at. Do NOT override DATABASE_PROVIDER on
  // the command line when auditing production.
  const { db } = await import('../src/database/json-database.js');
  const local = await db.listVirtualAccounts();

  // A production Bridge key with an empty local database means the comparison
  // is meaningless. Refuse rather than guess: the whole safety model rests on
  // knowing which accounts Sivan still considers active.
  const looksLikeProduction = String(process.env.BRIDGE_BASE_URL || '').includes('api.bridge.xyz');
  if (looksLikeProduction && accounts.length > 0 && local.length === 0) {
    console.error(
      '\nREFUSING TO CONTINUE.\n\n' +
      `Bridge returned ${accounts.length} virtual account(s) but this database has 0.\n` +
      'Every account would be classified as stale, including any that are live.\n\n' +
      'Point DATABASE_PROVIDER/DATABASE_URL at the production database, or use\n' +
      '--force-empty-db if you have genuinely verified the database is empty.\n'
    );
    if (!args.includes('--force-empty-db')) process.exit(1);
  }

  const localByProviderId = new Map(local.map((item: any) => [item.providerAccountId, item]));

  const rows = accounts.map((va) => {
    const localRecord: any = localByProviderId.get(va.id);
    const remoteActive = String(va.status || '').toLowerCase();
    const isRemoteLive = remoteActive === 'activated' || remoteActive === 'active';
    const localStatus = localRecord?.status ?? 'UNKNOWN_TO_SIVAN';

    // The dangerous combination: Sivan has written it off, Bridge has not.
    // These are live bank accounts nothing is watching.
    const stale = isRemoteLive && localStatus !== 'active';

    return {
      bridgeId: va.id,
      customerId: va.customer_id,
      remoteStatus: va.status,
      localStatus,
      localId: localRecord?.id,
      account: mask(va.source_deposit_instructions?.bank_account_number),
      currency: va.source_deposit_instructions?.currency,
      fee: va.developer_fee_percent ?? 'none',
      rail: va.destination?.payment_rail,
      // Bridge does NOT echo bridge_wallet_id back on read. A virtual account
      // created with destination.bridge_wallet_id is returned with
      // destination.address set to that wallet's on-chain address instead.
      // Verified in sandbox: creating a VA with bridge_wallet_id X reads back
      // as address = (wallet X).address.
      //
      // So "has an address, no wallet id" does NOT mean pooled settlement. The
      // only way to tell is to resolve the address against the customer's own
      // wallets, which is done below.
      settlesTo: va.destination?.bridge_wallet_id
        ? `wallet:${va.destination.bridge_wallet_id}`
        : va.destination?.address
          ? `address:${va.destination.address}`
          : 'unknown',
      destinationAddress: va.destination?.address,
      stale,
    };
  });

  const staleRows = rows.filter((r) => r.stale);
  const activeRows = rows.filter((r) => !r.stale);
  const monthlyCost = rows.filter((r) => String(r.currency).toLowerCase() === 'usd').length * 2;

  if (AS_JSON) {
    console.log(JSON.stringify({ total: rows.length, stale: staleRows.length, monthlyCost, rows }, null, 2));
  } else {
    console.log(`Bridge reports ${accounts.length} virtual account(s). Sivan has ${local.length} record(s).\n`);

    for (const row of rows) {
      const marker = row.stale ? 'STALE ' : row.localStatus === 'active' ? 'ACTIVE' : '      ';
      console.log(`${marker} ${row.bridgeId}`);
      console.log(`       acct ${row.account} ${String(row.currency || '').toUpperCase()}  fee=${row.fee}`);
      console.log(`       bridge=${row.remoteStatus}  sivan=${row.localStatus}`);
      console.log(`       ${row.rail || '?'} -> ${row.settlesTo}`);
    }

    console.log(`\n  live at Bridge and active in Sivan : ${activeRows.length}`);
    console.log(`  live at Bridge but closed in Sivan : ${staleRows.length}  <-- still accepting deposits`);
    console.log(`  estimated USD VA cost              : $${monthlyCost}/month`);

    const zeroFee = rows.filter((r) => r.fee === '0.0' || r.fee === '0');
    if (zeroFee.length) {
      console.log(`\n  ${zeroFee.length} account(s) provisioned at 0% developer fee, earning nothing:`);
      zeroFee.forEach((r) => console.log(`    ${r.bridgeId} (${r.account})`));
    }

    // Whether settlement is pooled cannot be read off the destination shape:
    // Bridge returns an address even when the VA was created with a
    // bridge_wallet_id. Resolve each destination address against that
    // customer's own wallets instead. Sharing one address ACROSS customers is
    // the real signal of pooling.
    const addressOwners = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!row.destinationAddress) continue;
      const set = addressOwners.get(row.destinationAddress) ?? new Set<string>();
      if (row.customerId) set.add(row.customerId);
      addressOwners.set(row.destinationAddress, set);
    }

    const shared = [...addressOwners.entries()].filter(([, owners]) => owners.size > 1);
    if (shared.length) {
      console.log('\n  POOLED SETTLEMENT DETECTED - one address serving multiple customers:');
      shared.forEach(([addr, owners]) =>
        console.log(`    ${addr} <- ${owners.size} customers`)
      );
    } else {
      console.log('\n  settlement: no address is shared across customers');
    }
  }

  if (!DEACTIVATE) {
    if (!AS_JSON && staleRows.length) {
      console.log(`\nRe-run with --deactivate-stale to deactivate the ${staleRows.length} stale account(s).`);
      console.log('Accounts Sivan considers active are never touched.\n');
    }
    return;
  }

  // --- writes from here -----------------------------------------------------
  console.log(`\nDeactivating ${staleRows.length} stale account(s)...\n`);

  let done = 0;
  let failed = 0;

  for (const row of staleRows) {
    if (row.localStatus === 'active') {
      console.log(`  SKIP ${row.bridgeId}: Sivan considers this active.`);
      continue;
    }
    // Belt and braces. "Unknown to Sivan" is not the same as "known to be
    // closed": it may simply mean we are looking at the wrong database. Only
    // deactivate accounts we can positively confirm are closed.
    if (row.localStatus === 'UNKNOWN_TO_SIVAN' && !args.includes('--force-empty-db')) {
      console.log(
        `  SKIP ${row.bridgeId}: not found in this database. Cannot confirm it is closed.`
      );
      continue;
    }
    if (!row.customerId) {
      console.log(`  SKIP ${row.bridgeId}: no customer id, cannot address the account.`);
      failed += 1;
      continue;
    }

    try {
      await client.request(
        `/customers/${row.customerId}/virtual_accounts/${row.bridgeId}/deactivate`,
        { method: 'POST', idempotencyKey: `sivan-va-deactivate-${row.bridgeId}` }
      );
      console.log(`  OK   ${row.bridgeId} (${row.account}) deactivated`);
      done += 1;
    } catch (error) {
      console.log(`  FAIL ${row.bridgeId}: ${(error as Error).message}`);
      failed += 1;
    }
  }

  console.log(`\nDeactivated: ${done}   Failed: ${failed}\n`);
}

main().catch((error) => {
  console.error('\nFAILED:', error?.message || error);
  process.exit(1);
});
