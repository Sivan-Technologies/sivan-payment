import crypto from 'node:crypto';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function encodeBase58(buffer: Buffer): string {
  const digits: number[] = [0];
  for (let i = 0; i < buffer.length; i++) {
    for (let j = 0; j < digits.length; j++) digits[j] <<= 8;
    digits[0] += buffer[i];
    let carry = 0;
    for (let j = 0; j < digits.length; ++j) {
      digits[j] += carry;
      carry = (digits[j] / 58) | 0;
      digits[j] %= 58;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let str = '';
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) str += BASE58_ALPHABET[0];
  for (let i = digits.length - 1; i >= 0; i--) str += BASE58_ALPHABET[digits[i]];
  return str;
}

export function decodeBase58(str: string): Buffer {
  if (!str || str.length === 0) return Buffer.alloc(0);
  const bytes: number[] = [0];
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    const value = BASE58_ALPHABET.indexOf(char);
    if (value === -1) throw new Error(`Invalid Base58 character: ${char}`);
    for (let j = 0; j < bytes.length; j++) bytes[j] *= 58;
    bytes[0] += value;
    let carry = 0;
    for (let j = 0; j < bytes.length; ++j) {
      bytes[j] += carry;
      carry = bytes[j] >> 8;
      bytes[j] &= 0xff;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < str.length && str[i] === BASE58_ALPHABET[0]; i++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

export interface NearKeypair {
  accountId: string; // 64-character lowercase hex string (implicit NEAR account ID)
  publicKey: string; // 'ed25519:<base58>'
  secretKey: string; // 'ed25519:<base58>' (64 bytes: 32 bytes seed + 32 bytes public key)
  publicKeyBytes: Buffer;
  secretKeyBytes: Buffer;
}

/**
 * Standard PKCS#8 DER prefix for Ed25519 private keys (RFC 8410).
 * 302e020100300506032b657004220420
 */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * Generates an authentic NEAR Ed25519 keypair deterministically from a seed.
 * The account ID is the native 64-hex lowercase implicit account ID used across NEAR Protocol.
 */
export function generateNearKeypair(seedInput: string): NearKeypair {
  // Deterministically hash seed to 32-byte Ed25519 seed
  const seedBytes = crypto.createHash('sha256').update(seedInput).digest();

  // Create Ed25519 private key from seed via PKCS#8 DER
  const pkcs8Der = Buffer.concat([ED25519_PKCS8_PREFIX, seedBytes]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey(privateKey as any);

  // Extract raw 32-byte Ed25519 public key from SPKI DER (last 32 bytes)
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeyBytes = spkiDer.subarray(spkiDer.length - 32);

  // NEAR native implicit account ID is the 64-character hex of the public key
  const accountId = publicKeyBytes.toString('hex').toLowerCase();

  // NEAR key format uses ed25519:<base58>
  const publicKeyStr = `ed25519:${encodeBase58(publicKeyBytes)}`;

  // Secret key in NEAR/libsodium format is 64 bytes: 32 bytes seed + 32 bytes public key
  const secretKeyBytes = Buffer.concat([seedBytes, publicKeyBytes]);
  const secretKeyStr = `ed25519:${encodeBase58(secretKeyBytes)}`;

  return {
    accountId,
    publicKey: publicKeyStr,
    secretKey: secretKeyStr,
    publicKeyBytes,
    secretKeyBytes,
  };
}

/**
 * Generates the deterministic 64-character implicit NEAR address for a user seed.
 */
export function generateNearAddress(seedInput: string): string {
  return generateNearKeypair(seedInput).accountId;
}

/**
 * Signs a payload using the deterministic Ed25519 keypair.
 * Returns the authentic 64-byte Ed25519 signature.
 */
export function signNearPayload(seedInput: string, payload: Buffer): Buffer {
  const seedBytes = crypto.createHash('sha256').update(seedInput).digest();
  const pkcs8Der = Buffer.concat([ED25519_PKCS8_PREFIX, seedBytes]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });
  return crypto.sign(null, payload, privateKey);
}
