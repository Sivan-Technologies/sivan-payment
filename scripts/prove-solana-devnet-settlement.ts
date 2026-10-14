/**
 * PROOF: Sivan's production SPL transfer path executes on a real Solana cluster.
 *
 * WHY THIS EXISTS
 *
 * Sivan has SPL transfer code written against the mainnet USDC mint, and a
 * 36 assertion suite that exercises it. What it did NOT have was a single
 * transaction accepted by a Solana validator. Unit tests prove the bytes are
 * shaped correctly; only a cluster proves they are correct.
 *
 * That gap matters because Sivan is entering a Solana hackathon. Narrating a
 * Solana settlement over code that has never settled is exactly the kind of
 * unverifiable claim this codebase has been removing all week.
 *
 * WHAT THIS DOES
 *
 * Runs the real buildSplTransfer() from src/wallets/solana against devnet,
 * end to end:
 *
 *   1. fund a fresh payer from the devnet faucet
 *   2. create a 6 decimal SPL mint, the same shape as USDC
 *   3. mint a balance to the sender
 *   4. build the transfer WITH THE PRODUCTION CODE PATH
 *   5. replace Privy's sentinel blockhash with a live one, sign, submit
 *   6. read the recipient balance back off the chain
 *
 * Step 4 is the point. The instruction set, the associated token account
 * derivation and the versioned transaction envelope are all produced by the
 * same function that serves real payouts. Only the signing differs, because
 * in production Privy holds the key.
 *
 * DEVNET, DELIBERATELY. This mints a test token rather than moving real
 * value, so it proves the transaction path and nothing about custody of real
 * funds. Stated plainly so the distinction is never blurred in a pitch.
 *
 * Run: ./node_modules/.bin/tsx scripts/prove-solana-devnet-settlement.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { buildSplTransfer, toBaseUnits } from '../src/wallets/solana/spl-transfer.js';

const RPC = process.env.SOLANA_DEVNET_RPC_URL || 'https://api.devnet.solana.com';
const DECIMALS = 6;            // USDC shape
const SEND_AMOUNT = '4.25';    // mirrors the Arc mainnet settlement amount

function log(step: string, detail = '') {
  console.log(`  ${step}${detail ? '  ' + detail : ''}`);
}

/**
 * Load the payer.
 *
 * SOLANA_PROOF_SECRET_KEY is preferred and is how this is meant to be run.
 * The public devnet faucet rate limits by IP and returns HTTP 429 from shared
 * or datacentre addresses, which is not a bug in this script and cannot be
 * retried around. Supplying a key that already holds a little devnet SOL
 * removes the faucet from the critical path entirely.
 *
 * Accepts either a base58 secret key (Phantom export) or the JSON byte array
 * that `solana-keygen` writes.
 */
function loadPayer(): { kp: Keypair; source: string } {
  const raw = (process.env.SOLANA_PROOF_SECRET_KEY || '').trim();
  if (!raw) return { kp: Keypair.generate(), source: 'generated' };

  if (raw.startsWith('[')) {
    const bytes = Uint8Array.from(JSON.parse(raw));
    return { kp: Keypair.fromSecretKey(bytes), source: 'SOLANA_PROOF_SECRET_KEY (json array)' };
  }
  return {
    kp: Keypair.fromSecretKey(bs58.decode(raw)),
    source: 'SOLANA_PROOF_SECRET_KEY (base58)',
  };
}

async function ensureFunded(conn: Connection, payer: Keypair, minSol: number) {
  const balance = await conn.getBalance(payer.publicKey);
  if (balance >= minSol * LAMPORTS_PER_SOL) {
    log('balance  ', `${balance / LAMPORTS_PER_SOL} SOL, already funded`);
    return;
  }

  try {
    const sig = await conn.requestAirdrop(payer.publicKey, 1 * LAMPORTS_PER_SOL);
    const bh = await conn.getLatestBlockhash();
    await conn.confirmTransaction(
      { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
      'confirmed'
    );
    log('airdrop  ', sig);
    return;
  } catch (err: any) {
    throw new Error(
      `Could not fund ${payer.publicKey.toBase58()}.\n\n` +
      `  The public devnet faucet rate limits by IP and answers 429 from shared or\n` +
      `  datacentre addresses. Retrying will not help. Two ways forward:\n\n` +
      `    1. Run this from your own machine, where the faucet will serve you:\n` +
      `         ./node_modules/.bin/tsx scripts/prove-solana-devnet-settlement.ts\n\n` +
      `    2. Fund any devnet key with about 0.1 SOL at https://faucet.solana.com\n` +
      `       and pass it in:\n` +
      `         SOLANA_PROOF_SECRET_KEY=<base58 or json array> \\\n` +
      `           ./node_modules/.bin/tsx scripts/prove-solana-devnet-settlement.ts\n\n` +
      `  Underlying error: ${String(err?.message ?? err)}`
    );
  }
}

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const version = await conn.getVersion();
  console.log(`\nSolana devnet  ${RPC}`);
  console.log(`solana-core    ${version['solana-core']}\n`);

  const { kp: payer, source } = loadPayer();   // sender and fee payer
  const recipient = Keypair.generate();

  console.log('SETUP');
  log('key source', source);
  log('sender   ', payer.publicKey.toBase58());
  log('recipient', recipient.publicKey.toBase58());

  await ensureFunded(conn, payer, 0.05);

  // A 6 decimal mint: structurally identical to USDC.
  const mint = await createMint(conn, payer, payer.publicKey, null, DECIMALS);
  log('mint     ', mint.toBase58() + `  (${DECIMALS} decimals)`);

  const senderAta = await getOrCreateAssociatedTokenAccount(
    conn, payer, mint, payer.publicKey
  );
  await mintTo(conn, payer, mint, senderAta.address, payer, 1_000_000_000n); // 1000 tokens
  log('funded   ', '1000.000000 to the sender token account');

  // ------------------------------------------------------------------
  // THE PRODUCTION CODE PATH
  // ------------------------------------------------------------------
  console.log('\nBUILD VIA src/wallets/solana/spl-transfer.ts');
  const built = await buildSplTransfer({
    fromOwner: payer.publicKey.toBase58(),
    toOwner: recipient.publicKey.toBase58(),
    mint: mint.toBase58(),
    amount: SEND_AMOUNT,
    decimals: DECIMALS,
    production: false,
    rpcOptions: { production: false },
  });

  log('from ATA ', built.fromTokenAccount);
  log('to ATA   ', built.toTokenAccount);
  log('creates recipient account', String(built.createsRecipientAccount));

  const tx = VersionedTransaction.deserialize(
    Buffer.from(built.transactionBase64, 'base64')
  );
  log('instructions', String(tx.message.compiledInstructions.length));

  /**
   * Privy builds against a sentinel blockhash and substitutes a live one at
   * signing time. We are standing in for Privy, so we do the same thing here.
   * The instruction set is untouched.
   */
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.message.recentBlockhash = blockhash;
  tx.sign([payer]);

  console.log('\nSUBMIT');
  const signature = await conn.sendTransaction(tx, { maxRetries: 5 });
  log('signature', signature);

  const conf = await conn.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight }, 'confirmed'
  );
  if (conf.value.err) {
    throw new Error(`Transaction failed on chain: ${JSON.stringify(conf.value.err)}`);
  }
  log('status   ', 'confirmed, no error');

  // ------------------------------------------------------------------
  // READ IT BACK OFF THE CHAIN. A returned signature is a claim.
  // ------------------------------------------------------------------
  console.log('\nVERIFY ON CHAIN');
  const recipientAta = await getAccount(conn, new PublicKey(built.toTokenAccount));
  const expected = toBaseUnits(SEND_AMOUNT, DECIMALS);
  log('recipient balance', `${Number(recipientAta.amount) / 10 ** DECIMALS}`);

  if (recipientAta.amount !== expected) {
    throw new Error(
      `Recipient holds ${recipientAta.amount} base units, expected ${expected}`
    );
  }
  log('amount matches   ', `${SEND_AMOUNT} exactly`);

  const parsed = await conn.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
  });
  log('ledger slot      ', String(parsed?.slot));
  log('network fee      ', `${(parsed?.meta?.fee ?? 0) / LAMPORTS_PER_SOL} SOL`);

  console.log('\n----------------------------------------------------------');
  console.log('PROVEN: the production SPL path produced a transaction that a');
  console.log('Solana validator accepted, and the tokens arrived.');
  console.log(`\nsignature  ${signature}`);
  console.log(`explorer   https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  console.log('\nScope: devnet, with a test mint of USDC shape. This proves the');
  console.log('transaction path, NOT custody or movement of real value.');
  console.log('----------------------------------------------------------\n');
}

main().catch((err) => {
  console.error('\nPROOF FAILED:', err?.message ?? err);
  process.exit(1);
});
