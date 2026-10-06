/**
 * EMERGENCY RECOVERY SCRIPT — v2
 * --------------------------------
 * Sends 34.62 USDC from the buyer's Privy wallet (9MDEk5f6...)
 * to the seller's wallet (W7ydftpwx...) on Solana Devnet using
 * the project's own buildSplTransfer + Privy delegated signing.
 *
 * Run with:
 *   DRY_RUN=false npx tsx scripts/recover-solana-agreement-funds.ts
 */

import { config } from 'dotenv';
import path from 'path';
import pg from 'pg';

// Load sandbox env (has Privy authorization key + quorum ID)
config({ path: path.join(process.cwd(), '.env-sandbox') });

// Force DB to live Neon connection
process.env.DATABASE_URL =
  'postgresql://neondb_owner:npg_3fnl7mFqijWz@ep-empty-snow-aye297lt.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require';

// Force devnet
process.env.NODE_ENV = 'sandbox';
process.env.SIVAN_NETWORK_MODE = 'devnet';

const DRY_RUN = process.env.DRY_RUN !== 'false';

// ── Targets ───────────────────────────────────────────────────────────────────
const AGREEMENT_IDS        = ['SIV-500439-54B2', 'SIV-260289-1550', 'SIV-828012-1867'];
const BUYER_WALLET_ADDRESS = '9MDEk5f6MpsaYXsq2VDA8zncBouWNigeTB7aezDsKxpz';
const BUYER_PRIVY_WALLET_ID = 'cp3ci6pa7958mnbf4iu8bv3p';
const SELLER_WALLET_ADDRESS = 'W7ydftpwxsEE7732N2w5UTHDFrBvYUDmAeuGCZwPDu7';
const TRANSFER_USDC = '34.62';

// ── Privy config ──────────────────────────────────────────────────────────────
const PRIVY_BASE      = 'https://api.privy.io/v1';
const PRIVY_APP_ID    = process.env.PRIVY_APP_ID!;
const PRIVY_SECRET    = process.env.PRIVY_APP_SECRET!;
const PRIVY_AUTH_KEY  = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY!;
const PRIVY_QUORUM_ID = process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID!;

// Devnet CAIP-2
const CAIP2_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

function log(msg: string, ...args: any[]) {
  console.log(`[recover] ${msg}`, ...args);
}

// ── Use the project's own Privy authorization helpers ────────────────────────
// These are verified live against the API and use the correct canonical JSON
// signing format that Privy's API requires.
import {
  authorizationSignature,
  loadAuthorizationPrivateKey,
} from '../src/wallets/provider/privy-authorization.js';

function privyHeaders(idempotencyKey?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: 'Basic ' + Buffer.from(`${PRIVY_APP_ID}:${PRIVY_SECRET}`).toString('base64'),
    'privy-app-id': PRIVY_APP_ID,
    'privy-authorization-key-id': PRIVY_QUORUM_ID,
  };
  if (idempotencyKey) h['privy-idempotency-key'] = idempotencyKey;
  return h;
}

// ── Solana RPC helper ─────────────────────────────────────────────────────────
async function solanaRpc(method: string, params: any[]): Promise<any> {
  const resp = await fetch('https://api.devnet.solana.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return resp.json();
}

async function getUsdcBalance(owner: string): Promise<number> {
  const DEVNET_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
  const res = await solanaRpc('getTokenAccountsByOwner', [
    owner,
    { mint: DEVNET_MINT },
    { encoding: 'jsonParsed', commitment: 'confirmed' },
  ]);
  return (res.result?.value ?? []).reduce(
    (sum: number, a: any) =>
      sum + Number(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0),
    0
  );
}

async function pollConfirmation(sig: string, maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const res = await solanaRpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
    const status = res.result?.value?.[0];
    if (!status) { log(`  Attempt ${i + 1}: not yet visible`); continue; }
    if (status.err) { log(`TX failed on-chain: ${JSON.stringify(status.err)}`); return false; }
    if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
      return true;
    }
    log(`  Attempt ${i + 1}: ${status.confirmationStatus}`);
  }
  return false;
}

// ── Build + sign SPL transfer via project's own builder ──────────────────────
async function executeSplTransfer(idempotencyKey: string): Promise<{ txHash?: string; error?: string }> {
  // Dynamically import project modules (they use .js extensions in ESM output)
  const { buildSplTransfer } = await import('../src/wallets/solana/spl-transfer.js');

  const DEVNET_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

  log('Building SPL transaction via project buildSplTransfer...');
  const built = await buildSplTransfer({
    fromOwner: BUYER_WALLET_ADDRESS,
    toOwner: SELLER_WALLET_ADDRESS,
    mint: DEVNET_MINT,
    amount: TRANSFER_USDC,
    decimals: 6,
    production: false, // devnet
  });

  log(`Transaction built. Base64 length: ${built.transactionBase64.length} chars`);
  log(`From ATA: ${built.fromTokenAccount}`);
  log(`To ATA:   ${built.toTokenAccount}`);

  if (DRY_RUN) {
    log('DRY_RUN — skipping Privy API submission.');
    return { txHash: 'DRY_RUN_NO_TX' };
  }

  const signingKeyPem = loadAuthorizationPrivateKey(PRIVY_AUTH_KEY);
  if (!signingKeyPem) {
    return { error: 'Could not load PRIVY_AUTHORIZATION_PRIVATE_KEY from env' };
  }

  const url = `${PRIVY_BASE}/wallets/${encodeURIComponent(BUYER_PRIVY_WALLET_ID)}/rpc`;
  const body = {
    method: 'signAndSendTransaction',
    caip2: CAIP2_DEVNET,
    sponsor: true,
    params: {
      transaction: built.transactionBase64,
      encoding: 'base64',
    },
  };

  const authSig = authorizationSignature({
    method: 'POST',
    url,
    body,
    appId: PRIVY_APP_ID,
    privateKeyPem: signingKeyPem,
    idempotencyKey,
  });

  log('Submitting to Privy API...');
  const resp = await fetch(url, {
    method: 'POST',
    headers: { ...privyHeaders(idempotencyKey), 'privy-authorization-signature': authSig },
    body: JSON.stringify(body),
  });

  const result = await resp.json().catch(() => ({})) as any;
  log(`Privy response (${resp.status}):`, JSON.stringify(result, null, 2));

  if (!resp.ok) {
    const msg = String(result?.error ?? result?.message ?? `HTTP ${resp.status}`);
    return { error: `Privy API ${resp.status}: ${msg}` };
  }

  const txHash =
    result?.data?.signature ??
    result?.data?.transaction_signature ??
    result?.data?.hash ??
    result?.signature ??
    result?.transaction_signature;

  return { txHash };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('='.repeat(60));
  log('Agreement Fund Recovery — v2 (using project buildSplTransfer)');
  log(`DRY_RUN: ${DRY_RUN}`);
  log('='.repeat(60));

  if (!PRIVY_APP_ID || !PRIVY_SECRET || !PRIVY_AUTH_KEY || !PRIVY_QUORUM_ID) {
    throw new Error('Missing Privy credentials in env.');
  }

  const buyerBal  = await getUsdcBalance(BUYER_WALLET_ADDRESS);
  const sellerBal = await getUsdcBalance(SELLER_WALLET_ADDRESS);
  log(`Buyer  USDC: ${buyerBal}`);
  log(`Seller USDC: ${sellerBal}`);

  if (!DRY_RUN && buyerBal < Number(TRANSFER_USDC)) {
    log(`WARNING: Buyer only has ${buyerBal} — will transfer whatever is available`);
  }

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL!,
    ssl: { rejectUnauthorized: false },
  });

  const agrRes = await pool.query(
    'SELECT id, status, amount_usdc, release_tx_hash FROM payments_service_agreements WHERE id = ANY($1)',
    [AGREEMENT_IDS]
  );
  log('\nAgreements in DB:');
  agrRes.rows.forEach(r =>
    log(`  ${r.id}: ${r.status} | ${r.amount_usdc} USDC | tx=${(r.release_tx_hash ?? 'none').slice(0, 20)}...`)
  );

  log('\nExecuting SPL transfer...');
  const idempotencyKey = `sivan_recovery_${Date.now()}`;
  const { txHash, error } = await executeSplTransfer(idempotencyKey);

  if (error || !txHash || txHash === 'DRY_RUN_NO_TX') {
    if (error) log(`\nERROR: ${error}`);
    log('\n--- MANUAL RECOVERY STEPS ---');
    log('Privy dashboard: https://dashboard.privy.io');
    log(`Wallet ID: ${BUYER_PRIVY_WALLET_ID}  (${BUYER_WALLET_ADDRESS})`);
    log(`Send ${TRANSFER_USDC} USDC to: ${SELLER_WALLET_ADDRESS}`);
    log('Then update DB:');
    AGREEMENT_IDS.forEach(id =>
      log(`  UPDATE payments_service_agreements SET release_tx_hash='<TX>' WHERE id='${id}';`)
    );
    await pool.end();
    process.exit(error ? 1 : 0);
  }

  log(`\nSubmitted: ${txHash}`);
  const confirmed = await pollConfirmation(txHash);
  log(confirmed ? `CONFIRMED ✓ ${txHash}` : `WARNING: not confirmed within window — check manually`);

  log('\nUpdating DB release_tx_hash...');
  for (const id of AGREEMENT_IDS) {
    await pool.query(
      'UPDATE payments_service_agreements SET release_tx_hash = $1, updated_at = NOW() WHERE id = $2',
      [txHash, id]
    );
    log(`  Updated ${id} → ${txHash.slice(0, 20)}...`);
  }

  const sellerAfter = await getUsdcBalance(SELLER_WALLET_ADDRESS);
  log(`\nSeller USDC: ${sellerAfter} (was ${sellerBal}, received +${(sellerAfter - sellerBal).toFixed(6)})`);
  log('Done.');
  await pool.end();
}

main().catch(err => {
  console.error('[recover] Fatal:', err?.message ?? err);
  process.exit(1);
});
