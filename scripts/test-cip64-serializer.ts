/**
 * Phase D: CIP-64 serializer verification
 *
 * Tests the RLP encoder and signing-hash builder against known properties:
 *   - Output always starts with 0x7b (the CIP-64 type byte)
 *   - The signing hash is a valid 32-byte keccak256 (64 hex chars after 0x)
 *   - Changing any field changes the hash (no collisions)
 *   - buildCip64SignedRawTx assembles a signed raw tx that starts with 0x7b
 *   - decodePrivySignature correctly unpacks r, s, yParity from a 65-byte sig
 *   - Testnet and mainnet chain IDs produce different hashes
 *
 * Run with:
 *   npx tsx scripts/test-cip64-serializer.ts
 */

import assert from 'node:assert/strict';
import {
  buildCip64SigningHash,
  buildCip64SignedRawTx,
  decodePrivySignature,
  CELO_MAINNET_CHAIN_ID,
  CELO_SEPOLIA_CHAIN_ID,
} from '../src/wallets/celo/cip64-serializer.js';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Shared test params
// ---------------------------------------------------------------------------

const BASE_PARAMS = {
  chainId: CELO_SEPOLIA_CHAIN_ID,
  nonce: 0n,
  maxPriorityFeePerGas: 1_000_000_000n,
  maxFeePerGas: 6_000_000_000n,
  gasLimit: 120_000n,
  to: '0x01C5C0122039549AD1493B8220cABEdD739BC44E',     // USDC on Celo Sepolia
  value: 0n,
  data: '0xa9059cbb000000000000000000000000901255f561bcf73688fa1b1c18a9ca836132d1320000000000000000000000000000000000000000000000000000000000989680',
  feeCurrency: '0x4A6b0f90597e7429Ce8400fC0E2745Add343df8',   // USDC adapter
};

// ---------------------------------------------------------------------------
// Suite 1: Output format
// ---------------------------------------------------------------------------

console.log('\nSuite 1: Output format');

const hash1 = buildCip64SigningHash(BASE_PARAMS);
check('signing hash is a 0x-prefixed string',        hash1.startsWith('0x'));
check('signing hash is 66 chars (0x + 32 bytes hex)', hash1.length === 66);
check('signing hash is all hex chars',                /^0x[0-9a-f]+$/.test(hash1));

// ---------------------------------------------------------------------------
// Suite 2: Determinism
// ---------------------------------------------------------------------------

console.log('\nSuite 2: Determinism');

const hash2 = buildCip64SigningHash(BASE_PARAMS);
check('same params produce identical hash', hash1 === hash2);

// ---------------------------------------------------------------------------
// Suite 3: Sensitivity — changing any field changes the hash
// ---------------------------------------------------------------------------

console.log('\nSuite 3: Field sensitivity');

check('nonce change changes hash',
  buildCip64SigningHash({ ...BASE_PARAMS, nonce: 1n }) !== hash1);

check('chainId change changes hash',
  buildCip64SigningHash({ ...BASE_PARAMS, chainId: CELO_MAINNET_CHAIN_ID }) !== hash1);

check('to address change changes hash',
  buildCip64SigningHash({ ...BASE_PARAMS, to: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' }) !== hash1);

check('data change changes hash',
  buildCip64SigningHash({ ...BASE_PARAMS, data: '0x' }) !== hash1);

check('feeCurrency change changes hash',
  buildCip64SigningHash({ ...BASE_PARAMS, feeCurrency: '0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B' }) !== hash1);

check('gasLimit change changes hash',
  buildCip64SigningHash({ ...BASE_PARAMS, gasLimit: 200_000n }) !== hash1);

check('maxFeePerGas change changes hash',
  buildCip64SigningHash({ ...BASE_PARAMS, maxFeePerGas: 10_000_000_000n }) !== hash1);

// ---------------------------------------------------------------------------
// Suite 4: Chain ID separation
// ---------------------------------------------------------------------------

console.log('\nSuite 4: Chain ID separation');

const sepoliaHash = buildCip64SigningHash({ ...BASE_PARAMS, chainId: CELO_SEPOLIA_CHAIN_ID });
const mainnetHash = buildCip64SigningHash({ ...BASE_PARAMS, chainId: CELO_MAINNET_CHAIN_ID });
check('Celo Sepolia and Mainnet chain IDs produce different hashes', sepoliaHash !== mainnetHash);

// ---------------------------------------------------------------------------
// Suite 5: decodePrivySignature
// ---------------------------------------------------------------------------

console.log('\nSuite 5: decodePrivySignature');

// Construct a synthetic 65-byte signature: r=0x00..01, s=0x00..02, v=0x1c (28 → yParity 1)
const syntheticR = Buffer.alloc(32, 0); syntheticR[31] = 0x01;
const syntheticS = Buffer.alloc(32, 0); syntheticS[31] = 0x02;
const syntheticV = Buffer.from([0x1c]); // 28 → yParity = 1
const syntheticSig = '0x' + Buffer.concat([syntheticR, syntheticS, syntheticV]).toString('hex');

const { yParity, r, s } = decodePrivySignature(syntheticSig);
check('yParity decoded correctly from v=28',  yParity === 1n);
check('r decoded correctly',                  r.toString('hex') === syntheticR.toString('hex'));
check('s decoded correctly',                  s.toString('hex') === syntheticS.toString('hex'));

// v=0x1b (27) → yParity = 0
const sig0 = '0x' + Buffer.concat([syntheticR, syntheticS, Buffer.from([0x1b])]).toString('hex');
const decoded0 = decodePrivySignature(sig0);
check('yParity decoded correctly from v=27',  decoded0.yParity === 0n);

// v=0 (EIP-2718 form) → yParity = 0
const sigRaw0 = '0x' + Buffer.concat([syntheticR, syntheticS, Buffer.from([0x00])]).toString('hex');
const decodedRaw0 = decodePrivySignature(sigRaw0);
check('yParity decoded correctly from v=0',   decodedRaw0.yParity === 0n);

// v=1 (EIP-2718 form) → yParity = 1
const sigRaw1 = '0x' + Buffer.concat([syntheticR, syntheticS, Buffer.from([0x01])]).toString('hex');
const decodedRaw1 = decodePrivySignature(sigRaw1);
check('yParity decoded correctly from v=1',   decodedRaw1.yParity === 1n);

// ---------------------------------------------------------------------------
// Suite 6: buildCip64SignedRawTx
// ---------------------------------------------------------------------------

console.log('\nSuite 6: buildCip64SignedRawTx');

const rawTx = buildCip64SignedRawTx(BASE_PARAMS, syntheticSig);
check('signed raw tx is a 0x-prefixed string',    rawTx.startsWith('0x'));
check('signed raw tx starts with type byte 0x7b', rawTx.startsWith('0x7b'));
check('signed raw tx is longer than unsigned',    rawTx.length > hash1.length);

// The signed tx must be a valid hex string
check('signed raw tx is all hex',  /^0x[0-9a-f]+$/.test(rawTx));

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
