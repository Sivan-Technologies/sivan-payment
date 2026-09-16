import crypto from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';

/**
 * CIP-64 Transaction Serializer for Celo native fee abstraction.
 *
 * CIP-64 (Celo Dynamic Fee v2) introduces Ethereum transaction type 0x7b.
 * It is identical to EIP-1559 but adds a feeCurrency field so gas is paid in
 * a whitelisted ERC-20 (USDC, USDT, or cUSD). The Celo node debits gas from
 * the stablecoin balance directly — zero native CELO required.
 *
 * Unsigned wire format (signed payload / signing hash input):
 *   0x7b || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas,
 *                gasLimit, to, value, data, accessList, feeCurrency])
 *
 * Signed wire format (broadcast via eth_sendRawTransaction):
 *   0x7b || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas,
 *                gasLimit, to, value, data, accessList, feeCurrency,
 *                signatureYParity, signatureR, signatureS])
 *
 * Reference: https://github.com/celo-org/celo-proposals/blob/master/CIPs/cip-0064.md
 *
 * No viem or ethers required. RLP encoding is hand-rolled (same philosophy as
 * evm-rpc.ts). keccak_256 from @noble/hashes — already in node_modules via
 * @solana/web3.js, audited, zero native deps.
 */

// ---------------------------------------------------------------------------
// Chain IDs
// ---------------------------------------------------------------------------

export const CELO_MAINNET_CHAIN_ID  = 42220n;
export const CELO_SEPOLIA_CHAIN_ID  = 11142220n;

const CIP64_TYPE_BYTE = 0x7b;

// ---------------------------------------------------------------------------
// Minimal RLP encoder
// ---------------------------------------------------------------------------

type RlpInput = Buffer | bigint | RlpInput[];

function bigintToMinimalBytes(n: bigint): Buffer {
  if (n === 0n) return Buffer.alloc(0);
  const hex = n.toString(16);
  return Buffer.from(hex.length % 2 === 0 ? hex : '0' + hex, 'hex');
}

function rlpLengthPrefix(payloadLen: number, baseOffset: number): Buffer {
  if (payloadLen < 56) {
    return Buffer.from([baseOffset + payloadLen]);
  }
  const lenBuf = bigintToMinimalBytes(BigInt(payloadLen));
  return Buffer.concat([Buffer.from([baseOffset + 55 + lenBuf.length]), lenBuf]);
}

function rlpEncodeOne(item: RlpInput): Buffer {
  // List
  if (Array.isArray(item)) {
    const payload = Buffer.concat(item.map(rlpEncodeOne));
    return Buffer.concat([rlpLengthPrefix(payload.length, 0xc0), payload]);
  }

  // Integer (bigint)
  if (typeof item === 'bigint') {
    if (item === 0n) return Buffer.from([0x80]); // RLP zero
    const bytes = bigintToMinimalBytes(item);
    if (bytes.length === 1 && bytes[0] < 0x80) return bytes; // single-byte value
    return Buffer.concat([rlpLengthPrefix(bytes.length, 0x80), bytes]);
  }

  // Byte string (Buffer)
  if (item.length === 0)                              return Buffer.from([0x80]);
  if (item.length === 1 && item[0] < 0x80)            return item;
  return Buffer.concat([rlpLengthPrefix(item.length, 0x80), item]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBuffer(hex: string): Buffer {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length === 0) return Buffer.alloc(0);
  return Buffer.from(clean.length % 2 === 0 ? clean : '0' + clean, 'hex');
}

/** Decode a 0x-prefixed 65-byte Privy signature into { yParity, r, s } */
export function decodePrivySignature(sig: string): { yParity: bigint; r: Buffer; s: Buffer } {
  const bytes = hexToBuffer(sig);
  if (bytes.length !== 65) {
    throw new Error(`CIP-64: expected 65-byte signature, got ${bytes.length}`);
  }
  // Privy returns Ethereum-style compact 65-byte: r(32) + s(32) + v(1)
  const r = bytes.subarray(0, 32);
  const s = bytes.subarray(32, 64);
  const v = bytes[64];
  // v is 27/28 (Ethereum legacy) or 0/1 (EIP-2718). Normalise to 0/1.
  const yParity = BigInt(v >= 27 ? v - 27 : v);
  return { yParity, r: Buffer.from(r), s: Buffer.from(s) };
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface Cip64Params {
  /** 42220n for mainnet, 11142220n for Celo Sepolia */
  chainId: bigint;
  nonce: bigint;
  /** Wei. Typically 1 Gwei = 1_000_000_000n on Celo Sepolia */
  maxPriorityFeePerGas: bigint;
  /** Wei. Typically 5 Gwei = 5_000_000_000n on Celo Sepolia */
  maxFeePerGas: bigint;
  /** Safe upper bound. 100_000n covers ERC-20 transfers with feeCurrency. */
  gasLimit: bigint;
  /** 0x-prefixed 20-byte destination address (token contract for ERC-20 send) */
  to: string;
  /** Native value in wei. 0n for ERC-20 transfers. */
  value: bigint;
  /** 0x-prefixed hex calldata (ERC-20 transfer(...) ABI) */
  data: string;
  /** 0x-prefixed fee-currency adapter address (USDC, USDT, or cUSD adapter) */
  feeCurrency: string;
}

/**
 * Build the keccak256 signing hash for a CIP-64 transaction.
 *
 * The returned hex hash is passed verbatim to Privy's raw_sign endpoint.
 * Privy signs it with the wallet's secp256k1 key inside the secure enclave.
 */
export function buildCip64SigningHash(params: Cip64Params): string {
  const rlpItems: RlpInput[] = [
    params.chainId,
    params.nonce,
    params.maxPriorityFeePerGas,
    params.maxFeePerGas,
    params.gasLimit,
    hexToBuffer(params.to),     // 20-byte address as bytes
    params.value,
    hexToBuffer(params.data),   // calldata as bytes
    [],                          // accessList: empty for simple transfers
    hexToBuffer(params.feeCurrency), // 20-byte fee-currency adapter address
  ];

  const unsignedRlp  = rlpEncodeOne(rlpItems);
  const envelope     = Buffer.concat([Buffer.from([CIP64_TYPE_BYTE]), unsignedRlp]);
  const hash         = keccak_256(envelope);
  return '0x' + Buffer.from(hash).toString('hex');
}

/**
 * Assemble the fully signed CIP-64 raw transaction ready for
 * eth_sendRawTransaction.
 *
 * Call buildCip64SigningHash, send the hash to Privy raw_sign, then call this
 * with the returned signature to get the broadcast payload.
 */
export function buildCip64SignedRawTx(
  params: Cip64Params,
  privySignature: string, // 65-byte hex from Privy raw_sign
): string {
  const { yParity, r, s } = decodePrivySignature(privySignature);

  const rlpItems: RlpInput[] = [
    params.chainId,
    params.nonce,
    params.maxPriorityFeePerGas,
    params.maxFeePerGas,
    params.gasLimit,
    hexToBuffer(params.to),
    params.value,
    hexToBuffer(params.data),
    [],
    hexToBuffer(params.feeCurrency),
    yParity,
    Buffer.from(r), // r as 32-byte buffer
    Buffer.from(s), // s as 32-byte buffer
  ];

  const signedRlp = rlpEncodeOne(rlpItems);
  const rawTx     = Buffer.concat([Buffer.from([CIP64_TYPE_BYTE]), signedRlp]);
  return '0x' + rawTx.toString('hex');
}

/**
 * Verify the signing hash matches a known test vector.
 * Used in unit tests to confirm the serialiser is correct.
 */
export function verifyCip64Hash(params: Cip64Params, expectedHash: string): boolean {
  return buildCip64SigningHash(params).toLowerCase() === expectedHash.toLowerCase();
}
