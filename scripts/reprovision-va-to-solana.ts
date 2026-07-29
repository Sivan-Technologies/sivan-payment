/**
 * Repoint a Bridge virtual account's settlement from Base to Solana.
 *
 * Why this is possible at all: Bridge exposes
 *
 *   PUT /customers/{customerID}/virtual_accounts/{virtualAccountID}
 *
 * and UpdateVirtualAccountDestination accepts `payment_rail` and
 * `bridge_wallet_id`. The virtual account keeps its identity, so the BANK
 * DETAILS DO NOT CHANGE. Anyone who already has the account number keeps
 * using it; only where the converted stablecoin lands changes.
 *
 * What is NOT possible: wallets themselves are create-only. The spec has no
 * PUT/PATCH/DELETE on /customers/{id}/wallets/{id}, and a Base address cannot
 * become a Solana address in any case - different key formats entirely. So a
 * Solana wallet is created alongside the Base one and the VA is repointed at
 * it. The Base wallet stays, holding any funds already there.
 *
 * Ordering matters and is enforced below:
 *   1. create/find the Solana wallet FIRST
 *   2. only then repoint the VA
 * Doing it the other way round would leave the VA pointing at a wallet id
 * that does not exist yet, and deposits arriving in that window could fail.
 *
 * Safety: read-only unless --apply is passed. Without it the script reports
 * exactly what it would do and changes nothing.
 *
 * Usage:
 *   tsx scripts/reprovision-va-to-solana.ts                 # dry run, all customers
 *   tsx scripts/reprovision-va-to-solana.ts --customer=cus_x # dry run, one customer
 *   tsx scripts/reprovision-va-to-solana.ts --apply          # actually change it
 */

import { BridgeClient } from '../src/providers/bridge/bridge.client.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ONLY_CUSTOMER = args.find((a) => a.startsWith('--customer='))?.split('=')[1];

/** Solana carries both USDC and USDT and has the lowest fees. Base cannot hold USDT. */
const TARGET_CHAIN = 'solana';

interface VirtualAccount {
  id: string;
  customer_id?: string;
  status?: string;
  source_deposit_instructions?: {
    currency?: string;
    bank_name?: string;
    bank_account_number?: string;
  };
  destination?: {
    currency?: string;
    payment_rail?: string;
    bridge_wallet_id?: string;
    address?: string;
  };
  developer_fee_percent?: string;
}

interface BridgeWallet {
  id: string;
  chain: string;
  address: string;
}

function mask(value?: string) {
  if (!value) return 'n/a';
  return `••••${String(value).slice(-4)}`;
}

async function main() {
  const client = new BridgeClient();

  console.log(`\nVirtual account settlement: Base -> Solana`);
  console.log(APPLY ? 'MODE: APPLY (will make changes)\n' : 'MODE: DRY RUN (no changes)\n');

  // List across all customers, then filter. The per-customer endpoint needs a
  // customer id we may not have yet.
  const list = await client.request<{ count: number; data: VirtualAccount[] }>(
    '/virtual_accounts'
  );
  const all = Array.isArray(list?.data) ? list.data : [];
  console.log(`Found ${all.length} virtual account(s) on this Bridge account.\n`);

  if (!all.length) {
    console.log('Nothing to do.');
    return;
  }

  const candidates = all.filter((va) => {
    if (ONLY_CUSTOMER && va.customer_id !== ONLY_CUSTOMER) return false;
    const rail = String(va.destination?.payment_rail || '').toLowerCase();
    return rail !== TARGET_CHAIN;
  });

  for (const va of all) {
    const rail = String(va.destination?.payment_rail || 'unknown').toLowerCase();
    const flag = rail === TARGET_CHAIN ? 'already solana' : `-> needs move from ${rail}`;
    console.log(
      `  ${va.id}  ${va.source_deposit_instructions?.currency?.toUpperCase() || '???'}  ` +
      `acct ${mask(va.source_deposit_instructions?.bank_account_number)}  ` +
      `rail=${rail}  wallet=${mask(va.destination?.bridge_wallet_id)}  ${flag}`
    );
  }

  console.log(`\n${candidates.length} account(s) to repoint.\n`);
  if (!candidates.length) return;

  let changed = 0;
  let skipped = 0;

  for (const va of candidates) {
    const customerId = va.customer_id;
    if (!customerId) {
      console.log(`  SKIP ${va.id}: no customer_id on the record, cannot scope the update.`);
      skipped += 1;
      continue;
    }

    console.log(`\n${va.id} (customer ${customerId})`);

    // Step 1: the destination wallet must exist BEFORE the VA points at it.
    const wallets = await client.request<{ count: number; data: BridgeWallet[] }>(
      `/customers/${customerId}/wallets`
    );
    let solana = (wallets?.data || []).find(
      (w) => String(w.chain).toLowerCase() === TARGET_CHAIN
    );

    if (solana) {
      console.log(`  reusing Solana wallet ${solana.id} (${mask(solana.address)})`);
    } else if (!APPLY) {
      console.log(`  would create a Solana wallet for this customer`);
    } else {
      solana = await client.request<BridgeWallet>(`/customers/${customerId}/wallets`, {
        method: 'POST',
        // Deterministic: a retry must return the existing wallet rather than
        // provisioning (and billing for) a second one.
        idempotencyKey: `sivan-wallet-${customerId}-${TARGET_CHAIN}`,
        body: { chain: TARGET_CHAIN },
      });
      console.log(`  created Solana wallet ${solana.id} (${mask(solana.address)})`);
    }

    // Step 2: repoint the VA. Currency and fee are carried over explicitly;
    // omitting developer_fee_percent on an update risks resetting it to zero,
    // which is exactly the bug that made every VA earn nothing before.
    const destination = {
      currency: va.destination?.currency || 'usdc',
      payment_rail: TARGET_CHAIN,
      bridge_wallet_id: solana?.id ?? '(pending)',
    };

    const body: Record<string, unknown> = { destination };
    if (va.developer_fee_percent) body.developer_fee_percent = va.developer_fee_percent;

    if (!APPLY) {
      console.log(`  would PUT /customers/${customerId}/virtual_accounts/${va.id}`);
      console.log(`    ${JSON.stringify(body)}`);
      console.log(`  bank details unchanged: ${mask(va.source_deposit_instructions?.bank_account_number)}`);
      continue;
    }

    const updated = await client.request<VirtualAccount>(
      `/customers/${customerId}/virtual_accounts/${va.id}`,
      { method: 'PUT', body }
    );

    const newRail = String(updated?.destination?.payment_rail || '').toLowerCase();
    const newWallet = updated?.destination?.bridge_wallet_id;
    const feeKept = updated?.developer_fee_percent;

    if (newRail !== TARGET_CHAIN) {
      console.log(`  FAILED: rail is still "${newRail}"`);
      skipped += 1;
      continue;
    }
    if (newWallet !== solana?.id) {
      console.log(`  FAILED: wallet is ${newWallet}, expected ${solana?.id}`);
      skipped += 1;
      continue;
    }

    console.log(`  OK rail=${newRail} wallet=${mask(newWallet)} fee=${feeKept ?? 'none'}`);
    console.log(`  bank details unchanged: ${mask(updated?.source_deposit_instructions?.bank_account_number)}`);
    changed += 1;
  }

  console.log(`\n${APPLY ? 'Changed' : 'Would change'}: ${changed}   Skipped: ${skipped}\n`);
  if (!APPLY) console.log('Re-run with --apply to make these changes.\n');
}

main().catch((error) => {
  console.error('\nFAILED:', error?.message || error);
  if (error?.details) console.error(JSON.stringify(error.details, null, 2));
  process.exit(1);
});
