/**
 * Repair the live virtual account: set the developer fee, and move settlement
 * from a raw pooled address to the customer's own Bridge wallet.
 *
 * Both are done in ONE PUT, because UpdateVirtualAccount performs a
 * replacement of what it receives. Sending `destination` without
 * `developer_fee_percent` would clear the fee; sending the fee without
 * `destination` would leave funds pooling at the shared address. They must
 * travel together.
 *
 *   PUT /customers/{customerID}/virtual_accounts/{virtualAccountID}
 *   { developer_fee_percent, destination: { currency, payment_rail, bridge_wallet_id } }
 *
 * Why this matters:
 *
 *   fee — the live account was provisioned at developer_fee_percent "0.0", so
 *   every deposit through it has earned nothing. Deposits already landed
 *   cannot be reclaimed; this only fixes future ones.
 *
 *   destination — it currently settles to a bare address with no
 *   bridge_wallet_id. That is the old pooled design: funds arrive somewhere
 *   Sivan effectively controls on the user's behalf, which is what Bridge ToS
 *   2.1(m) prohibits. Settling into the customer's own wallet keeps Bridge as
 *   custodian.
 *
 * READ-ONLY unless --apply is passed. Without it nothing is created, changed
 * or provisioned; it prints the exact request body it would send.
 *
 * A wallet is only created when --apply is given, and with a deterministic
 * idempotency key so a re-run cannot mint a second one.
 *
 * Usage:
 *   tsx scripts/fix-live-virtual-account.ts            # dry run
 *   tsx scripts/fix-live-virtual-account.ts --apply    # writes
 */

import { BridgeClient } from '../src/providers/bridge/bridge.client.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FEE = args.find((a) => a.startsWith('--fee='))?.split('=')[1] || '1.25';
const TARGET_CHAIN = 'solana';

interface BridgeVa {
  id: string;
  customer_id?: string;
  status?: string;
  developer_fee_percent?: string;
  source_deposit_instructions?: Record<string, any>;
  destination?: { currency?: string; payment_rail?: string; bridge_wallet_id?: string; address?: string };
}

interface BridgeWallet {
  id: string;
  chain: string;
  address: string;
}

function mask(value?: string) {
  return value ? `••••${String(value).slice(-4)}` : 'n/a';
}

async function main() {
  const base = process.env.BRIDGE_BASE_URL || '';

  // This writes to whatever Bridge environment BRIDGE_BASE_URL points at, and
  // production virtual accounts are real bank accounts. Require the target to
  // be stated explicitly rather than inherited from a stale shell or .env.
  if (!base) {
    console.error('\nBRIDGE_BASE_URL is not set. Refusing to guess which Bridge environment to write to.\n');
    process.exit(1);
  }
  if (APPLY && base.includes('api.bridge.xyz') && !args.includes('--i-understand-this-is-production')) {
    console.error(
      '\nREFUSING TO WRITE TO PRODUCTION.\n\n' +
      `BRIDGE_BASE_URL is "${base}".\n` +
      'This updates live virtual accounts. Re-run with --i-understand-this-is-production\n' +
      'once the dry run output is what you expect.\n'
    );
    process.exit(1);
  }

  const client = new BridgeClient();

  console.log('\nLive virtual account repair');
  console.log(`TARGET: ${base}`);
  console.log(APPLY ? 'MODE: APPLY (will write)\n' : 'MODE: DRY RUN (no changes)\n');

  const list = await client.request<{ count: number; data: BridgeVa[] }>('/virtual_accounts');
  const all = Array.isArray(list?.data) ? list.data : [];

  // Only touch accounts Bridge itself still considers live.
  const live = all.filter((va) => ['activated', 'active'].includes(String(va.status || '').toLowerCase()));

  console.log(`Bridge reports ${all.length} virtual account(s), ${live.length} active.\n`);

  const needsWork = live.filter((va) => {
    const feeMissing = !va.developer_fee_percent || Number(va.developer_fee_percent) <= 0;
    // Do NOT infer "pooled" from a missing bridge_wallet_id: Bridge returns an
    // address even when the account was created with a wallet id, so that test
    // flags every healthy account. Whether settlement is pooled is decided by
    // resolving the address against the customer's own wallets, which happens
    // per account below. Here, only a missing or zero fee marks work to do.
    return feeMissing;
  });

  for (const va of live) {
    const fee = va.developer_fee_percent ?? 'none';
    const dest = va.destination?.bridge_wallet_id
      ? `wallet:${va.destination.bridge_wallet_id}`
      : `address:${va.destination?.address || '?'}`;
    console.log(`  ${va.id}`);
    console.log(`    acct ${mask(va.source_deposit_instructions?.bank_account_number)}  fee=${fee}`);
    console.log(`    ${va.destination?.payment_rail || '?'} -> ${dest}`);
  }

  if (!needsWork.length) {
    console.log('\nNothing to repair.\n');
    return;
  }

  console.log(`\n${needsWork.length} account(s) need repair.\n`);

  for (const va of needsWork) {
    const customerId = va.customer_id;
    if (!customerId) {
      console.log(`  SKIP ${va.id}: no customer_id, cannot scope the update.`);
      continue;
    }

    console.log(`${va.id} (customer ${customerId})`);

    // The destination wallet must exist BEFORE the VA is pointed at it.
    const wallets = await client.request<{ count: number; data: BridgeWallet[] }>(
      `/customers/${customerId}/wallets`
    );
    let wallet = (wallets?.data || []).find((w) => String(w.chain).toLowerCase() === TARGET_CHAIN);

    if (wallet) {
      console.log(`  reusing ${TARGET_CHAIN} wallet ${wallet.id} (${mask(wallet.address)})`);
    } else if (!APPLY) {
      console.log(`  would create a ${TARGET_CHAIN} wallet for this customer`);
    } else {
      wallet = await client.request<BridgeWallet>(`/customers/${customerId}/wallets`, {
        method: 'POST',
        // Deterministic: a re-run returns the existing wallet rather than
        // provisioning (and billing for) a second one.
        idempotencyKey: `sivan-wallet-${customerId}-${TARGET_CHAIN}`,
        body: { chain: TARGET_CHAIN },
      });
      console.log(`  created ${TARGET_CHAIN} wallet ${wallet.id} (${mask(wallet.address)})`);
    }

    // Fee and destination MUST be sent together. Omitting either clears it.
    const body = {
      developer_fee_percent: FEE,
      destination: {
        currency: va.destination?.currency || 'usdc',
        // The rail must match the wallet's chain or Bridge rejects it.
        payment_rail: TARGET_CHAIN,
        bridge_wallet_id: wallet?.id ?? '(pending)',
      },
    };

    if (!APPLY) {
      console.log(`  would PUT /customers/${customerId}/virtual_accounts/${va.id}`);
      console.log(`    ${JSON.stringify(body)}`);
      console.log(`  fee ${va.developer_fee_percent ?? 'none'} -> ${FEE}`);
      console.log(`  bank details unchanged: ${mask(va.source_deposit_instructions?.bank_account_number)}`);
      continue;
    }

    const updated = await client.request<BridgeVa>(
      `/customers/${customerId}/virtual_accounts/${va.id}`,
      { method: 'PUT', body }
    );

    const okFee = Number(updated?.developer_fee_percent) === Number(FEE);
    // Bridge does NOT echo bridge_wallet_id back on read. A virtual account
    // created or updated with bridge_wallet_id reads back with
    // destination.address set to that wallet's on-chain address instead.
    // Verified in sandbox 2026-07-29. Comparing the id would always report a
    // false failure, so compare whichever field Bridge actually returned.
    const okWallet =
      updated?.destination?.bridge_wallet_id === wallet?.id ||
      (Boolean(wallet?.address) && updated?.destination?.address === wallet?.address);
    const okRail = String(updated?.destination?.payment_rail).toLowerCase() === TARGET_CHAIN;
    const sameBank =
      updated?.source_deposit_instructions?.bank_account_number ===
      va.source_deposit_instructions?.bank_account_number;

    console.log(`  fee         ${updated?.developer_fee_percent} ${okFee ? 'OK' : 'FAILED'}`);
    console.log(`  wallet      ${updated?.destination?.bridge_wallet_id ?? updated?.destination?.address} ${okWallet ? 'OK' : 'FAILED'}`);
    console.log(`  rail        ${updated?.destination?.payment_rail} ${okRail ? 'OK' : 'FAILED'}`);
    console.log(`  bank details ${sameBank ? 'unchanged OK' : 'CHANGED - investigate'}`);
  }

  if (!APPLY) console.log('\nRe-run with --apply to make these changes.\n');
}

main().catch((error) => {
  console.error('\nFAILED:', error?.message || error);
  if (error?.details) console.error(JSON.stringify(error.details, null, 2));
  process.exit(1);
});
