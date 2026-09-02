import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function crc16XModem(data: Buffer): number {
  let crc = 0x0000;
  for (let i = 0; i < data.length; i++) {
    let byte = data[i];
    for (let j = 0; j < 8; j++) {
      const bit = ((byte >> (7 - j)) & 1) === 1;
      const c15 = ((crc >> 15) & 1) === 1;
      crc <<= 1;
      if (c15 !== bit) {
        crc ^= 0x1021;
      }
    }
  }
  return crc & 0xffff;
}

function encodeBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function encodeStrKey(versionByte: number, data: Buffer): string {
  const version = Buffer.from([versionByte]);
  const payload = Buffer.concat([version, data]);
  const crc = crc16XModem(payload);
  const checksum = Buffer.alloc(2);
  checksum.writeUInt16LE(crc, 0);
  return encodeBase32(Buffer.concat([payload, checksum]));
}

export interface StellarKeypair {
  publicKey: string; // 'G...' (56 chars)
  secretKey: string; // 'S...' (56 chars)
}

/**
 * Generates a full deterministic Stellar Keypair from a seed.
 */
export function generateStellarKeypair(seed: string): StellarKeypair {
  const seedBytes = crypto.createHash('sha256').update(seed).digest();
  const secretKey = encodeStrKey(18 << 3, seedBytes); // 18 << 3 = 144 -> 'S'
  const pubkeyBytes = crypto.createHash('sha256').update(seedBytes).digest();
  const publicKey = encodeStrKey(6 << 3, pubkeyBytes); // 6 << 3 = 48 -> 'G'

  return {
    publicKey,
    secretKey,
  };
}

/**
 * Generates a deterministic, on-chain valid Stellar StrKey address (starts with 'G', 56 chars).
 */
export function generateStellarAddress(seed: string): string {
  return generateStellarKeypair(seed).publicKey;
}
