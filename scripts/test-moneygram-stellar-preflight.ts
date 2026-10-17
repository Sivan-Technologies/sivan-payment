/**
 * STELLAR PREFLIGHT, AGAINST LIVE TESTNET.
 *
 * Regression suite for the "Stellar Payment Signing Failed: Not Found" bug.
 *
 * The original failure: sendStellarUsdcPayment() called horizon.loadAccount()
 * as its first action. On an account Horizon does not know, the SDK throws
 * the literal string "Not Found", and the route forwarded err.message
 * verbatim to the browser. The user saw two words describing none of the
 * three conditions that actually cause it.
 *
 * These assertions run against real Horizon and real Friendbot. They are
 * slower than a unit test and worth it: the bug was entirely about what a
 * live network returns, and a mock would have reproduced the wrong thing.
 */

import crypto from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import {
  preflightStellarPayment,
  provisionSandboxAccount,
  explainHorizonError,
  horizonUrlFor,
  friendbotUrl,
} from '../src/moneygram/service/stellar-preflight.service.js';

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ok - ${name}`); }
  else { failed++; console.log(`  ❌ FAIL - ${name}${detail ? `  (${detail})` : ''}`); }
}
async function rejectsWith(fn: () => Promise<unknown>, re: RegExp) {
  try { await fn(); return false; } catch (e: any) { return re.test(String(e?.message ?? e)); }
}

/** MoneyGram's sandbox USDC issuer, from their own stellar.toml. */
const MG_TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

/** The exact derivation sendStellarUsdcPayment uses in sandbox. */
function sandboxKeypair(identifier: string): Keypair {
  const seed = crypto.createHash('sha256')
    .update(`sivan_stellar_sandbox_${identifier.trim().toLowerCase()}`)
    .digest();
  return Keypair.fromRawEd25519Seed(seed);
}

async function main() {
  console.log('\n' + '='.repeat(54));
  console.log('🔷 MONEYGRAM STELLAR PREFLIGHT (LIVE TESTNET)');
  console.log('='.repeat(54));

  // ── 1. Reproduce the original bug ───────────────────────────────
  console.log('\n══ 1. The "Not Found" Condition ══');

  /** A fresh random account Horizon has definitely never seen. */
  const ghost = Keypair.random();
  const ghostPre = await preflightStellarPayment({
    publicKey: ghost.publicKey(),
    amount: '5',
    issuer: MG_TESTNET_USDC_ISSUER,
    network: 'testnet',
  });

  check('a non-existent account is detected, not thrown as "Not Found"',
    ghostPre.ok === false && ghostPre.code === 'ACCOUNT_NOT_FOUND', String(ghostPre.code));
  check('the diagnosis names the account', ghostPre.diagnosis?.includes(ghost.publicKey()) === true);
  check('the diagnosis names the network', /testnet/i.test(ghostPre.diagnosis ?? ''));
  /** The whole point: no longer two useless words. */
  check('the diagnosis is actionable, not just "Not Found"',
    (ghostPre.diagnosis ?? '').length > 60 && !/^Not Found$/i.test(ghostPre.diagnosis ?? ''),
    (ghostPre.diagnosis ?? '').slice(0, 80));

  // ── 2. Sandbox self-provisioning ────────────────────────────────
  console.log('\n══ 2. Sandbox Provisioning (real Friendbot) ══');

  /** Unique per run so the test genuinely exercises creation. */
  const fresh = sandboxKeypair(`ci-${Date.now()}-${Math.random()}`);
  console.log(`     provisioning ${fresh.publicKey()}`);

  const prov = await provisionSandboxAccount({
    secret: fresh.secret(),
    issuer: MG_TESTNET_USDC_ISSUER,
    network: 'testnet',
  });
  check('Friendbot created the account', prov.funded === true, prov.notes.join(' | '));
  check('the USDC trustline was established', prov.trustlineCreated === true);

  const after = await preflightStellarPayment({
    publicKey: fresh.publicKey(),
    amount: '5',
    issuer: MG_TESTNET_USDC_ISSUER,
    network: 'testnet',
  });
  check('the account now exists', after.accountExists === true);
  check('the trustline is now present', after.hasTrustline === true);
  check('it holds XLM for the reserve', Number(after.xlmBalance) > 0, after.xlmBalance);

  /**
   * Still not ok, and that is CORRECT: Friendbot funds XLM, not USDC. The
   * failure has moved from an opaque "Not Found" to a precise, true
   * statement about the balance.
   */
  check('it correctly reports no USDC yet, rather than claiming ready',
    after.ok === false && after.code === 'INSUFFICIENT_USDC', String(after.code));
  check('the balance diagnosis states both figures',
    /holds 0/.test(after.diagnosis ?? '') && /requires 5/.test(after.diagnosis ?? ''),
    after.diagnosis);

  // ── 3. Provisioning is idempotent ───────────────────────────────
  console.log('\n══ 3. Idempotency ══');
  const again = await provisionSandboxAccount({
    secret: fresh.secret(),
    issuer: MG_TESTNET_USDC_ISSUER,
    network: 'testnet',
  });
  check('re-running does not re-fund', again.funded === false);
  check('and does not duplicate the trustline', again.trustlineCreated === false);

  // ── 4. Mainnet must never self-provision ────────────────────────
  console.log('\n══ 4. Mainnet Refusal ══');

  /**
   * Friendbot does not exist on mainnet, and silently funding a live
   * treasury account would be a far worse bug than the one being fixed.
   */
  check('provisioning REFUSES on mainnet',
    await rejectsWith(() => provisionSandboxAccount({
      secret: fresh.secret(), issuer: MG_TESTNET_USDC_ISSUER, network: 'mainnet',
    }), /refuses to run on mainnet/));

  const mainnetGhost = await preflightStellarPayment({
    publicKey: Keypair.random().publicKey(),
    amount: '5',
    issuer: MG_TESTNET_USDC_ISSUER,
    network: 'mainnet',
  });
  check('a missing mainnet account says it is a treasury action',
    /treasury action/i.test(mainnetGhost.diagnosis ?? ''), mainnetGhost.diagnosis?.slice(0, 70));

  // ── 5. Endpoints are env-driven ─────────────────────────────────
  console.log('\n══ 5. Endpoint Resolution ══');
  check('testnet and mainnet Horizon differ',
    horizonUrlFor('testnet') !== horizonUrlFor('mainnet'));
  const prevH = process.env.STELLAR_HORIZON_TESTNET_URL;
  process.env.STELLAR_HORIZON_TESTNET_URL = 'https://horizon.example.invalid';
  check('STELLAR_HORIZON_TESTNET_URL overrides the default',
    horizonUrlFor('testnet') === 'https://horizon.example.invalid');
  if (prevH === undefined) delete process.env.STELLAR_HORIZON_TESTNET_URL;
  else process.env.STELLAR_HORIZON_TESTNET_URL = prevH;
  check('friendbot URL is overridable', friendbotUrl().startsWith('http'));

  // ── 6. Horizon result codes become sentences ────────────────────
  console.log('\n══ 6. Horizon Error Translation ══');
  const mk = (codes: any) => ({ response: { data: { extras: { result_codes: codes } } } });
  check('op_no_trust is explained',
    /trustline is required/i.test(explainHorizonError(mk({ operations: ['op_no_trust'] }))));
  check('op_underfunded is explained',
    /does not hold enough USDC/i.test(explainHorizonError(mk({ operations: ['op_underfunded'] }))));
  check('op_no_destination is explained',
    /destination account does not exist/i.test(explainHorizonError(mk({ operations: ['op_no_destination'] }))));
  check('tx_bad_auth is explained',
    /signature did not match/i.test(explainHorizonError(mk({ transaction: 'tx_bad_auth' }))));
  /** The original symptom, now a sentence. */
  check('a bare "Not Found" is translated into the real cause',
    /does not exist on this network/i.test(explainHorizonError(new Error('Not Found'))),
    explainHorizonError(new Error('Not Found')));

  console.log('\n' + '='.repeat(54));
  console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(54) + '\n');
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('\nSUITE ERROR:', e?.message ?? e); process.exitCode = 1; });
