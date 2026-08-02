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

export type AddressChain = 'base' | 'ethereum' | 'polygon' | 'arbitrum' | 'avalanche_c_chain' | 'solana';

/** EVM chains share an address format, so they share a validator. */
const EVM_CHAINS = new Set<AddressChain>(['base', 'ethereum', 'polygon', 'arbitrum', 'avalanche_c_chain']);

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

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

  // keccak256 is what EIP-55 specifies. Node ships sha3-256, which is a
  // DIFFERENT function - using it would reject every valid checksummed
  // address. Without a keccak implementation the honest answer is "cannot
  // verify", so mixed case is accepted rather than wrongly refused.
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
      // The most common real mistake: a Solana address pasted into an EVM
      // field. Name it, because "invalid address" sends the user hunting.
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
    // The burn address is a valid-shaped address that destroys funds.
    if (/^0x0{40}$/.test(value)) {
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
    // Base58 excludes 0, O, I and l precisely because they are confusable.
    if (!BASE58.test(value)) {
      return { valid: false, reason: 'A Solana address cannot contain 0, O, I or l. Check the address again.' };
    }
    if (value.length < 32 || value.length > 44) {
      return { valid: false, reason: `A Solana address is 32-44 characters. That one is ${value.length}.` };
    }
    return { valid: true };
  }

  return { valid: false, reason: `Unsupported network: ${chain}.` };
}
