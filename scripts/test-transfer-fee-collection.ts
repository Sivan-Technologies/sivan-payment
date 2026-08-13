/**
 * THE TRANSFER FEE MUST ACTUALLY MOVE.
 *
 * Asked directly: "the fee I'm charging for the transfer - which wallet is it
 * sent to?" The answer was: none. The chain moved `amount - fee` to the
 * recipient, the ledger wrote a `kind: 'fee'` entry, and the fee itself simply
 * stayed in the sending user's own Privy wallet. Sivan's books recorded
 * revenue that had never left the customer's custody, a few cents at a time
 * across every user, with no balance to reconcile against and no way to spend
 * it.
 *
 * A separate sweep job was the obvious fix and the wrong one: a whole extra
 * transaction per user means paying gas twice to recover a $0.25 fee. Solana
 * bills per SIGNATURE, not per instruction, so the fee rides along as a second
 * instruction in the transaction that was already being paid for.
 *
 * These assertions run the REAL builder and decode the REAL transaction it
 * produces, rather than trusting a returned flag. A flag can be right while
 * the bytes are wrong, and the bytes are what moves money.
 */
import assert from 'node:assert/strict';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { buildSplTransfer, SOLANA_USDC_MINTS } from '../src/wallets/solana/spl-transfer.js';

const checks: Array<[string, () => Promise<void> | void]> = [];
function test(name: string, fn: () => Promise<void> | void) { checks.push([name, fn]); }

const USER = 'HN7cABqLq46Es1jh92dQQpXBoUn3xSzXk1uMv6d3sB2';
const RECIPIENT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const FEE_WALLET = 'Faj6u5v1phTw1zwsKUPiqB82idj3wdn8JCSm3Un4KFEu';
const MINT = SOLANA_USDC_MINTS.mainnet;

/**
 * Stubs the on-chain existence check by replacing global fetch.
 *
 * solana-rpc.ts calls the global directly and takes no injection seam, and I
 * am not adding one to production code for a test's benefit. Swapping the
 * global keeps these offline and deterministic - no live RPC, no rate limits,
 * no flakiness - while still exercising the REAL builder end to end.
 *
 * `present` is the set of token accounts that exist on this imaginary chain.
 */
const realFetch = globalThis.fetch;
function useRpc(present: Set<string>) {
  globalThis.fetch = (async (_url: any, init?: any) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    const account = body?.params?.[0];
    const exists = present.has(account);
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: exists ? { lamports: 2039280, data: ['', 'base64'] } : null } }),
      text: async () => '',
    } as any;
  }) as any;
}
function restoreRpc() { globalThis.fetch = realFetch; }

const ata = (owner: string) => getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(owner), true).toBase58();

const USER_ATA = ata(USER);
const RECIP_ATA = ata(RECIPIENT);
const FEE_ATA = ata(FEE_WALLET);

/** All three token accounts exist - the normal steady state once set up. */
const allPresent = () => new Set([USER_ATA, RECIP_ATA, FEE_ATA]);

/** Decode the built transaction and count SPL transfer instructions. */
function decode(base64: string) {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64, 'base64'));
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const ixs = tx.message.compiledInstructions.map((ix) => ({
    programId: keys[ix.programIdIndex],
    accounts: ix.accountKeyIndexes.map((i) => keys[i]),
    // transferChecked: [source, mint, destination, owner]; amount is a u64 LE
    // at byte 1 of the data, after the single-byte discriminator.
    destination: keys[ix.accountKeyIndexes[2]],
    amount: ix.data.length >= 9 ? Buffer.from(ix.data).readBigUInt64LE(1) : 0n,
    discriminator: ix.data[0],
  }));
  return { keys, ixs };
}

const TRANSFER_CHECKED = 12;

// ───────────────────────────────── the fee reaches the fee wallet

test('the fee is a second instruction in the SAME transaction', async () => {
  useRpc(allPresent());
  const built = await buildSplTransfer({
    fromOwner: USER, toOwner: RECIPIENT, mint: MINT, amount: '9.75', production: true,
    feeCollection: { owner: FEE_WALLET, amount: '0.25' },
  });
  assert.equal(built.collectsFee, true, built.feeSkippedReason);
  assert.equal(built.instructionCount, 2, 'expected recipient + fee in one transaction');
});

test('the amounts are exactly right, decoded from the real bytes', async () => {
  useRpc(allPresent());
  const built = await buildSplTransfer({
    fromOwner: USER, toOwner: RECIPIENT, mint: MINT, amount: '9.75', production: true,
    feeCollection: { owner: FEE_WALLET, amount: '0.25' },
  });
  const { ixs } = decode(built.transactionBase64);
  const transfers = ixs.filter((i) => i.discriminator === TRANSFER_CHECKED);
  assert.equal(transfers.length, 2);

  const toRecipient = transfers.find((i) => i.destination === RECIP_ATA);
  const toFee = transfers.find((i) => i.destination === FEE_ATA);
  assert.ok(toRecipient, 'no instruction pays the recipient');
  assert.ok(toFee, 'no instruction pays the fee wallet');

  // USDC has 6 decimals. 9.75 -> 9_750_000, 0.25 -> 250_000.
  assert.equal(toRecipient!.amount, 9_750_000n);
  assert.equal(toFee!.amount, 250_000n);
  // And they sum to the gross the user authorised.
  assert.equal(toRecipient!.amount + toFee!.amount, 10_000_000n);
});

test('the fee goes to the fee wallet TOKEN account, not the wallet address', async () => {
  // Sending SPL tokens to a bare wallet address puts them somewhere
  // unspendable. The builder derives the ATA itself so a caller cannot pass
  // the wrong destination.
  useRpc(allPresent());
  const built = await buildSplTransfer({
    fromOwner: USER, toOwner: RECIPIENT, mint: MINT, amount: '9.75', production: true,
    feeCollection: { owner: FEE_WALLET, amount: '0.25' },
  });
  const { ixs, keys } = decode(built.transactionBase64);
  const toFee = ixs.filter((i) => i.discriminator === TRANSFER_CHECKED).find((i) => i.destination === FEE_ATA);
  assert.ok(toFee, 'fee did not go to the derived token account');
  assert.ok(!keys.includes(FEE_WALLET) || toFee!.destination !== FEE_WALLET,
    'fee was sent to the bare wallet address');
});

// ─────────────── the customer is never billed for Sivan's setup

test('a missing fee ATA skips the fee - it does NOT create it', async () => {
  /*
    THE ASSERTION THAT MATTERS MOST. An SPL token account costs ~0.00204 SOL of
    rent, paid by the transaction's fee payer - the SENDING USER. Creating
    Sivan's revenue account would silently bill a customer ~$0.31 on a transfer
    they were quoted $0.25 for.

    Verified live while building this: the fee wallet's USDC ATA did not exist
    yet, so this is the real state, not a hypothetical.
  */
  useRpc(new Set([USER_ATA, RECIP_ATA])); // fee ATA absent
  const built = await buildSplTransfer({
    fromOwner: USER, toOwner: RECIPIENT, mint: MINT, amount: '9.75', production: true,
    feeCollection: { owner: FEE_WALLET, amount: '0.25' },
  });
  assert.equal(built.collectsFee, false);
  assert.equal(built.feeSkippedReason, 'fee_ata_missing');
  assert.equal(built.instructionCount, 1, 'something was added for the fee wallet');
  assert.equal(built.createsRecipientAccount, false);

  // And the recipient still gets paid in full - the send is unaffected.
  const { ixs } = decode(built.transactionBase64);
  const transfers = ixs.filter((i) => i.discriminator === TRANSFER_CHECKED);
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].destination, RECIP_ATA);
  assert.equal(transfers[0].amount, 9_750_000n);
});

// ─────────────────────────── it stays off unless explicitly configured

test('no fee wallet means the previous behaviour, unchanged', async () => {
  useRpc(allPresent());
  const built = await buildSplTransfer({
    fromOwner: USER, toOwner: RECIPIENT, mint: MINT, amount: '9.75', production: true,
  });
  assert.equal(built.collectsFee, false);
  assert.equal(built.instructionCount, 1);
});

test('a zero fee adds nothing', async () => {
  useRpc(allPresent());
  const built = await buildSplTransfer({
    fromOwner: USER, toOwner: RECIPIENT, mint: MINT, amount: '10', production: true,
    feeCollection: { owner: FEE_WALLET, amount: '0' },
  });
  assert.equal(built.collectsFee, false);
  assert.equal(built.feeSkippedReason, 'zero_amount');
  assert.equal(built.instructionCount, 1);
});

test('a malformed fee wallet does not take the transfer down', async () => {
  // The send is valid and the user is waiting on it. A configuration mistake
  // must cost Sivan its fee, never the customer their transfer.
  useRpc(allPresent());
  const built = await buildSplTransfer({
    fromOwner: USER, toOwner: RECIPIENT, mint: MINT, amount: '9.75', production: true,
    feeCollection: { owner: 'not-a-real-solana-address', amount: '0.25' },
  });
  assert.equal(built.collectsFee, false);
  assert.equal(built.feeSkippedReason, 'invalid_fee_wallet');
  assert.equal(built.instructionCount, 1);
});

test('the new-recipient case still works, with the fee alongside', async () => {
  // Three instructions: create the recipient's ATA, pay them, pay the fee.
  useRpc(new Set([USER_ATA, FEE_ATA])); // recipient ATA absent
  const built = await buildSplTransfer({
    fromOwner: USER, toOwner: RECIPIENT, mint: MINT, amount: '9.45', production: true,
    feeCollection: { owner: FEE_WALLET, amount: '0.55' },
  });
  assert.equal(built.createsRecipientAccount, true);
  assert.equal(built.collectsFee, true);
  assert.equal(built.instructionCount, 3);
});

// ──────────────────────────────── the switches, and that they default off

test('the capability is ON by default', async () => {
  /*
    DELIBERATELY THE EXCEPTION to the fail-closed rule beside it.

    autoSweepBridgeWallet moves a USER'S OWN BALANCE between custodians and
    must never switch itself on. This collects a fee the user was quoted,
    agreed to on the confirm screen, and that the ledger already debited.

    Off is not the safe choice here, it is the lossy one: Sivan sponsors gas on
    every Solana send, so a transfer with collection off costs gas and returns
    nothing. Defaulting off would make every transaction a small silent loss.
  */
  const { defaultWalletControls } = await import('../src/wallets/wallet-controls.service.js');
  assert.equal(defaultWalletControls().collectTransferFeeOnChain, true);
});

test('an admin who turns it OFF is still obeyed', async () => {
  // A default is not a lock. Explicit false must survive the merge.
  const { updateWalletControls, updateWalletControlsSchema, getWalletControls } =
    await import('../src/wallets/wallet-controls.service.js');
  await updateWalletControls(
    updateWalletControlsSchema.parse({ collectTransferFeeOnChain: false, updatedBy: 'test_fee_collection' }),
  );
  const off: any = await getWalletControls();
  assert.equal(off.collectTransferFeeOnChain, false, 'the default overrode an explicit off');

  await updateWalletControls(
    updateWalletControlsSchema.parse({ collectTransferFeeOnChain: true, updatedBy: 'test_fee_collection' }),
  );
  const on: any = await getWalletControls();
  assert.equal(on.collectTransferFeeOnChain, true);
});

test('a controls row predating the field reads as ON', async () => {
  /*
    THE FALLBACK THAT MAKES THE DEFAULT REAL, ASSERTED THROUGH THE REAL MERGE.

    A deployment that has ever saved a wallet control has a stored row with no
    collectTransferFeeOnChain key. If that resolves to false the new default
    applies to nobody: enabled in the schema, disabled everywhere that matters.

    My first version of this test re-implemented `?? true` on a literal object
    and asserted against its own arithmetic - so mutating the production
    fallback to `?? false` left it passing. Caught by mutation, not by reading.
    It now writes a legacy-shaped row and reads it back through
    updateWalletControls/getWalletControls, which is the code that actually
    decides.
  */
  const { db } = await import('../src/database/json-database.js');
  const { updateWalletControls, updateWalletControlsSchema, getWalletControls } =
    await import('../src/wallets/wallet-controls.service.js');

  // A row as it existed before this field was added.
  await db.upsertWalletControlsRecord({
    id: 'global', autoSweepBridgeWallet: false, updatedBy: 'legacy', updatedAt: new Date().toISOString(),
  } as any);

  // Touching an UNRELATED field must not silently switch fee collection off.
  await updateWalletControls(
    updateWalletControlsSchema.parse({ autoSweepBridgeWallet: false, updatedBy: 'test_fee_collection' }),
  );
  const merged: any = await getWalletControls();
  assert.equal(merged.collectTransferFeeOnChain, true,
    'a legacy row resolved to OFF - the default applies to nobody');
});

test('the admin view reports the switch AND whether a destination exists', async () => {
  // A switch that is on with no wallet configured collects nothing. An
  // operator must be able to see both halves in the hub.
  const { getWalletControlsView } = await import('../src/wallets/wallet-controls.service.js');
  const view: any = await getWalletControlsView();
  assert.equal(typeof view.collectTransferFeeOnChain, 'boolean');
  assert.equal(typeof view.feeWalletConfigured, 'boolean');
});

test('the transfer path hands the fee to the provider', async () => {
  const src = (await import('node:fs')).readFileSync('src/balances/balance.service.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.match(src, /feeAmount: transfer\.fee/);
  // The recipient still receives the NET, not the gross.
  assert.match(src, /amount: transfer\.netAmount \?\? transfer\.amount/);
});

let passed = 0;
for (const [name, fn] of checks) {
  // Each case declares its own chain state; restore between them so a leaked
  // stub cannot make a later assertion pass for the wrong reason.
  restoreRpc();
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${(error as Error).message.split('\n')[0]}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${checks.length} passed`);
if (passed !== checks.length) process.exitCode = 1;
