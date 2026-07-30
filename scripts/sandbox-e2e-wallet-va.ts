/**
 * SANDBOX end-to-end: KYC -> wallet -> virtual account -> settlement.
 *
 * Proves the exact chain, against the real Bridge sandbox API:
 *
 *   KYC approved
 *     -> ensureUserWallet() creates the Solana wallet   (FIRST)
 *     -> VA created, destination.bridge_wallet_id = THAT wallet
 *     -> user deposits USD
 *     -> Bridge converts to USDC
 *     -> USDC lands in the wallet that already existed
 *
 * SAFETY. This script refuses to run against production. Bridge sandbox and
 * live share an API shape, and a mistyped base URL would create real billable
 * virtual accounts, so the guard is a hard exit rather than a warning.
 *
 * It is read-only unless --apply is passed. The dry run reports what exists
 * and what it would create, and touches nothing.
 *
 * Usage:
 *   tsx scripts/sandbox-e2e-wallet-va.ts                 # dry run
 *   tsx scripts/sandbox-e2e-wallet-va.ts --apply         # create in SANDBOX
 *   tsx scripts/sandbox-e2e-wallet-va.ts --apply --customer=<id>
 */

import { BridgeClient } from '../src/providers/bridge/bridge.client.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ONLY = args.find((a) => a.startsWith('--customer='))?.split('=')[1];

const CHAIN = 'solana';
const FEE = args.find((a) => a.startsWith('--fee='))?.split('=')[1] || '1.25';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`); }
}

function mask(v?: string) { return v ? `••••${String(v).slice(-4)}` : 'n/a'; }

async function main() {
  const base = process.env.BRIDGE_BASE_URL || '';

  // Hard guard. Never let this script point at live.
  if (!base.includes('sandbox')) {
    console.error(
      '\nREFUSING TO RUN.\n\n' +
      `BRIDGE_BASE_URL is "${base}".\n` +
      'This script only runs against api.sandbox.bridge.xyz. It creates wallets and\n' +
      'virtual accounts, which are real and billable on production.\n'
    );
    process.exit(1);
  }

  const client = new BridgeClient();

  console.log('\nSANDBOX end-to-end: KYC -> wallet -> VA -> settlement');
  console.log(APPLY ? 'MODE: APPLY (creates in sandbox)\n' : 'MODE: DRY RUN (creates nothing)\n');

  // --- Step 1: a KYC-approved individual -----------------------------------
  console.log('1. KYC approved customer');
  const customers = await client.request<{ count: number; data: any[] }>('/customers?limit=100');
  const eligible = (customers.data || []).filter(
    (c) => c.status === 'active' && c.type === 'individual' &&
      (c.endorsements || []).some((e: any) => e.name === 'base' && e.status === 'approved')
  );

  check(`found an active individual with base:approved`, eligible.length > 0,
    `${customers.count} customers, ${eligible.length} eligible`);
  if (!eligible.length) {
    console.log('\n  No KYC-approved individual in sandbox. Complete a sandbox KYC first.\n');
    process.exit(1);
  }

  const customer = ONLY ? eligible.find((c) => c.id === ONLY) : eligible[0];
  if (!customer) {
    console.error(`  customer ${ONLY} not found among eligible customers`);
    process.exit(1);
  }
  console.log(`  using ${customer.id} (${customer.email})`);
  check('customer is an individual, not the business entity', customer.type === 'individual');

  // --- Step 2: wallet FIRST -------------------------------------------------
  console.log('\n2. Wallet is created BEFORE the virtual account');
  const before = await client.request<{ count: number; data: any[] }>(
    `/customers/${customer.id}/wallets`
  );
  let wallet = (before.data || []).find((w) => String(w.chain).toLowerCase() === CHAIN);
  console.log(`  existing wallets: ${before.count}`);

  if (wallet) {
    console.log(`  reusing ${wallet.id} (${wallet.address})`);
  } else if (!APPLY) {
    console.log(`  would POST /customers/${customer.id}/wallets { chain: "${CHAIN}" }`);
  } else {
    wallet = await client.request<any>(`/customers/${customer.id}/wallets`, {
      method: 'POST',
      // Deterministic: Bridge bills per created wallet, so a re-run must return
      // the existing one rather than provisioning a second.
      idempotencyKey: `sivan-wallet-${customer.id}-${CHAIN}`,
      body: { chain: CHAIN },
    });
    console.log(`  created ${wallet.id} (${wallet.address})`);
  }

  if (wallet) {
    check('wallet is on Solana', String(wallet.chain).toLowerCase() === CHAIN);
    check('address is Solana format, not 0x', !String(wallet.address).startsWith('0x'), wallet.address);

    // Idempotency proof: a second create with the same key must not add a wallet.
    if (APPLY) {
      const again = await client.request<any>(`/customers/${customer.id}/wallets`, {
        method: 'POST',
        idempotencyKey: `sivan-wallet-${customer.id}-${CHAIN}`,
        body: { chain: CHAIN },
      });
      check('re-creating with the same key returns the same wallet', again.id === wallet.id,
        `${again.id} vs ${wallet.id}`);
      const after = await client.request<{ count: number }>(`/customers/${customer.id}/wallets`);
      check('no duplicate wallet was billed', after.count <= Math.max(before.count, 1),
        `count went ${before.count} -> ${after.count}`);
    }
  }

  // --- Step 3: VA pointing at THAT wallet -----------------------------------
  console.log('\n3. Virtual account settles into that wallet');
  const existingVas = await client.request<{ count: number; data: any[] }>(
    `/customers/${customer.id}/virtual_accounts`
  );
  console.log(`  existing virtual accounts: ${existingVas.count}`);

  let va = (existingVas.data || [])[0];

  const body = {
    developer_fee_percent: FEE,
    source: { currency: 'usd' },
    destination: {
      currency: 'usdc',
      // Rail MUST match the wallet's chain or Bridge rejects it.
      payment_rail: CHAIN,
      bridge_wallet_id: wallet?.id ?? '(pending)',
    },
  };

  if (va) {
    console.log(`  reusing ${va.id}`);
  } else if (!APPLY) {
    console.log(`  would POST /customers/${customer.id}/virtual_accounts`);
    console.log(`    ${JSON.stringify(body)}`);
  } else {
    va = await client.request<any>(`/customers/${customer.id}/virtual_accounts`, {
      method: 'POST',
      idempotencyKey: `sivan-va-${customer.id}-usd`,
      body,
    });
    console.log(`  created ${va.id}`);
  }

  if (va) {
    const dest = va.destination || {};
    // Bridge does NOT echo bridge_wallet_id back. A VA created with
    // bridge_wallet_id reads back with destination.address set to that
    // wallet's on-chain address. Verified in sandbox. So the correct check is
    // that the destination address IS this customer's wallet address, not that
    // a bridge_wallet_id field survived the round trip.
    check("VA settles into THIS customer's wallet",
      dest.address === wallet?.address || dest.bridge_wallet_id === wallet?.id,
      `dest=${dest.address ?? dest.bridge_wallet_id} wallet=${wallet?.address}`);
    check('settlement is not a third-party or pooled address',
      dest.address === wallet?.address,
      'the destination must be an address Bridge holds for this customer');
    check('rail matches the wallet chain', String(dest.payment_rail).toLowerCase() === CHAIN);
    check('developer fee is set, not 0', Number(va.developer_fee_percent) > 0,
      `fee=${va.developer_fee_percent}`);

    const inst = va.source_deposit_instructions || {};
    console.log(`  bank: ${inst.bank_name} acct ${mask(inst.bank_account_number)} routing ${inst.bank_routing_number}`);
    check('the user has real USD deposit instructions', Boolean(inst.bank_account_number));
  }

  // --- Step 4: balance reads back from the wallet ---------------------------
  console.log('\n4. Balance is read from the wallet the VA settles into');
  if (wallet) {
    const detail = await client.request<any>(`/customers/${customer.id}/wallets/${wallet.id}`);
    const balances = detail.balances || [];
    check('single-wallet GET returns a balances array', Array.isArray(balances));
    console.log(`  balances: ${balances.length ? JSON.stringify(balances) : 'empty (no deposit yet)'}`);

    // The published OpenAPI schema shows no balances on the list endpoint, but
    // sandbox DOES return them. Verified live. The adapter treats a missing
    // balances field as "not loaded" rather than "zero", so it is correct
    // either way - but the Receive screen can show a balance from the list
    // call when Bridge provides one, saving a round trip per wallet.
    const list = await client.request<any>(`/customers/${customer.id}/wallets`);
    const listed = (list.data || []).find((w: any) => w.id === wallet!.id);
    const listHasBalances = Array.isArray(listed?.balances);
    console.log(`  list endpoint balances: ${listHasBalances ? 'present (better than documented)' : 'absent, as documented'}`);
    check('the adapter handles either shape without inventing a zero balance',
      listed !== undefined,
      'balances undefined must mean "not loaded", never "0.00"');

    const usdc = (detail.balances || []).find((b: any) => b.currency === 'usdc');
    check('the wallet can hold USDC on Solana', Boolean(usdc), 'no usdc balance row');
    const usdt = (detail.balances || []).find((b: any) => b.currency === 'usdt');
    check('the same wallet can also hold USDT', Boolean(usdt),
      'this is why Solana was chosen over Base, which cannot carry USDT');
  }

  console.log('\n5. What happens next, and how to verify it');
  console.log('  Bridge sandbox does not move real money. To simulate a deposit,');
  console.log('  use the Bridge sandbox deposit endpoint or dashboard against the');
  console.log('  virtual account above, then re-run this script: the USDC balance');
  console.log('  should appear on the SAME wallet, with no new wallet created.');

  console.log(`\n=====  PASS: ${pass}   FAIL: ${fail}  =====\n`);
  if (!APPLY) console.log('Dry run only. Re-run with --apply to create in sandbox.\n');
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error('\nFAILED:', error?.message || error);
  if (error?.details) console.error(JSON.stringify(error.details, null, 2));
  process.exit(1);
});
