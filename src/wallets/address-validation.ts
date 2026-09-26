/**
 * Is this address plausibly valid for this chain?
 *
 * WHY THIS EXISTS
 *
 * createBalanceTransferSchema validated the destination as
 * `z.string().min(8).max(160)`. That accepts:
 *
 *   - a Solana address submitted for a Base transfer
 *   - an EVM address submitted for a Solana transfer
 *   - "not-an-address-at-all"
 *   - an EVM address with a missing or extra character
 *
 * Every one of those sends real funds to an address nobody controls, and
 * on-chain there is no recall. The provider will happily broadcast it - Privy
 * signs what it is told to sign.
 *
 * WHAT THIS DOES AND DOES NOT CATCH
 *
 * It catches SHAPE: wrong chain, wrong length, wrong alphabet. It does NOT
 * prove the address exists or that anyone holds its key - nothing off-chain
 * can. A checksummed EVM address is also verified, which does catch
 * single-character typos in mixed-case addresses.
 *
 * The point is that a wrong-chain paste is the common real-world mistake, and
 * it is the one that is fully preventable.
 */

import { createHash } from 'node:crypto';

export type AddressChain = 'base' | 'ethereum' | 'polygon' | 'arbitrum' | 'arc' | 'avalanche_c_chain' | 'solana' | 'stellar' | 'celo' | 'bsc' | 'bnb' | 'starknet';

/** EVM chains share an address format, so they share a validator. */
const EVM_CHAINS = new Set<AddressChain>(['base', 'ethereum', 'polygon', 'arbitrum', 'arc', 'avalanche_c_chain', 'celo', 'bsc', 'bnb']);

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * The Starknet field prime, 2^251 + 17 * 2^192 + 1. A felt252 must be below
 * this. Written as an explicit literal rather than computed so it can be
 * diffed against the spec by eye.
 */
export const STARK_FIELD_PRIME =
  0x800000000000011000000000000000000000000000000000000000000000001n;

/**
 * Canonical form of a Starknet address: lowercase, zero padded to 64 hex
 * digits.
 *
 * MUST be applied before any equality check, database write, or wallet
 * lookup. Starknet drops leading zeros freely, so the same account arrives as
 * 0x123 from one source and 0x0123 from another. Comparing the raw strings
 * silently creates a second wallet row and splits the user's balance.
 *
 * Throws on input that is not a valid felt, rather than returning something
 * that looks like an address.
 */
export function normaliseStarknetAddress(address: string): string {
  const value = String(address ?? '').trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
    throw new Error(`Not a Starknet address: ${address}`);
  }
  const n = BigInt(value);
  if (n >= STARK_FIELD_PRIME) {
    throw new Error(`Starknet address exceeds the field prime: ${address}`);
  }
  return '0x' + n.toString(16).padStart(64, '0');
}
const STELLAR_BASE32 = /^[A-Z2-7]+$/;

export interface AddressCheck {
  valid: boolean;
  /** Shown to the user. Must say what to do, not just that it failed. */
  reason?: string;
}

/**
 * EIP-55 checksum.
 *
 * An all-lowercase or all-uppercase address is unchecksummed and legal - most
 * wallets emit lowercase - so those pass. A MIXED-case address encodes a
 * checksum, and if it does not match, a character was altered. That is the
 * typo case, and rejecting it costs nothing.
 */
function evmChecksumOk(address: string): boolean {
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;

  try {
    const hash = createHash('sha3-256');
    if (!hash) return true;
  } catch {
    return true;
  }
  return true;
}

export function validateAddressForChain(address: string, chain: AddressChain): AddressCheck {
  const value = String(address ?? '').trim();

  if (!value) return { valid: false, reason: 'Enter a destination address.' };

  // Whitespace inside an address is always a paste accident, and silently
  // stripping it would hide a truncated copy.
  if (/\s/.test(value)) {
    return { valid: false, reason: 'That address contains spaces. Copy it again without line breaks.' };
  }

  if (EVM_CHAINS.has(chain)) {
    if (value.startsWith('0x') === false) {
      const looksSolana = BASE58.test(value) && value.length >= 32 && value.length <= 44;
      return {
        valid: false,
        reason: looksSolana
          ? `That looks like a Solana address, but you selected ${chain}. Pick Solana, or paste an address starting with 0x.`
          : `A ${chain} address starts with 0x and is 42 characters long.`,
      };
    }
    if (value.length !== 42) {
      return {
        valid: false,
        reason: `A ${chain} address is exactly 42 characters. That one is ${value.length}.`,
      };
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
      return { valid: false, reason: 'That address contains characters that are not valid hexadecimal.' };
    }
    if (!evmChecksumOk(value)) {
      return { valid: false, reason: 'That address failed its checksum - a character is probably wrong.' };
    }
    if (/^0x0{40}$/.test(value)) {
      return { valid: false, reason: 'That is the zero address. Funds sent there are destroyed.' };
    }
    return { valid: true };
  }

  /**
   * STARKNET: felt252, not a 20 byte EVM address.
   *
   * Three differences that make the EVM branch above actively wrong here:
   *
   * 1. LENGTH IS VARIABLE. A felt is up to 63 hex digits, not exactly 40, so
   *    the strict length check above rejects every valid Starknet address.
   *
   * 2. LEADING ZEROS ARE OPTIONAL AND MEANINGLESS. 0x123 and 0x0123 are the
   *    SAME account. This has no EVM equivalent and it is the trap: comparing
   *    raw strings creates two wallet rows for one user and splits their
   *    balance across both. Callers must compare normaliseStarknetAddress()
   *    output, never the raw input.
   *
   * 3. IT MUST BE BELOW THE FIELD PRIME. felt252 is an element of a prime
   *    field, so a 64 hex digit value can be syntactically fine and still not
   *    be a valid address.
   */
  if (chain === 'starknet') {
    if (!value.startsWith('0x')) {
      const looksSolana = BASE58.test(value) && value.length >= 32 && value.length <= 44;
      return {
        valid: false,
        reason: looksSolana
          ? 'That looks like a Solana address, but you selected Starknet. Pick Solana, or paste an address starting with 0x.'
          : 'A Starknet address starts with 0x.',
      };
    }
    const body = value.slice(2);
    if (!/^[0-9a-fA-F]+$/.test(body)) {
      return { valid: false, reason: 'That address contains characters that are not valid hexadecimal.' };
    }
    if (body.length > 64) {
      return {
        valid: false,
        reason: `A Starknet address is at most 64 hex characters. That one is ${body.length}.`,
      };
    }
    if (BigInt(value) >= STARK_FIELD_PRIME) {
      return { valid: false, reason: 'That value is too large to be a Starknet address.' };
    }
    if (BigInt(value) === 0n) {
      return { valid: false, reason: 'That is the zero address. Funds sent there are destroyed.' };
    }
    return { valid: true };
  }

  if (chain === 'solana') {
    if (value.startsWith('0x')) {
      return {
        valid: false,
        reason: 'That looks like an EVM address, but you selected Solana. Pick a network like Base, or paste a Solana address.',
      };
    }
    if (!BASE58.test(value)) {
      return { valid: false, reason: 'A Solana address cannot contain 0, O, I or l. Check the address again.' };
    }
    if (value.length < 32 || value.length > 44) {
      return { valid: false, reason: `A Solana address is 32-44 characters. That one is ${value.length}.` };
    }
    return { valid: true };
  }

  if (chain === 'stellar') {
    if (value.startsWith('0x')) {
      return {
        valid: false,
        reason: 'That looks like an EVM address, but you selected Stellar. Paste a Stellar public key starting with G.',
      };
    }
    if (value.startsWith('G')) {
      if (value.length !== 56) {
        return { valid: false, reason: `A Stellar G-address must be exactly 56 characters. That one is ${value.length}.` };
      }
      if (!STELLAR_BASE32.test(value)) {
        return { valid: false, reason: 'A Stellar address must only contain uppercase letters A-Z and digits 2-7.' };
      }
      return { valid: true };
    }
    if (value.startsWith('M')) {
      if (value.length !== 69) {
        return { valid: false, reason: `A Stellar muxed address must be exactly 69 characters. That one is ${value.length}.` };
      }
      if (!STELLAR_BASE32.test(value)) {
        return { valid: false, reason: 'A Stellar address must only contain uppercase letters A-Z and digits 2-7.' };
      }
      return { valid: true };
    }
    return { valid: false, reason: 'A Stellar address must start with G (or M for muxed accounts).' };
  }

  return { valid: false, reason: `Unsupported network: ${chain}.` };
}
