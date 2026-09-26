/**
 * STARKNET TRANSFER CONSTRUCTION.
 *
 * Builds the calls that go into a paymaster invoke, and computes the SNIP-12
 * message hash that Privy signs.
 *
 * WHY starknet.js IS A DEPENDENCY HERE, when evm-rpc.ts deliberately hand
 * rolls its one eth_call.
 *
 * That trade went the other way on EVM because the work was a 68 byte
 * calldata encode. Here the work is SNIP-12 structured-data hashing over
 * Poseidon, and a wrong hash does NOT throw. It produces a VALID SIGNATURE
 * OVER THE WRONG DATA, which the sequencer rejects with an unhelpful error,
 * or in the worst case authorises something other than what the user agreed
 * to. That is not a place to save a dependency.
 *
 * Everything cheap is still computed rather than trusted: the entry point
 * selectors below are derived at module load and asserted against
 * independently computed values in the test suite.
 *
 * MULTICALL, which is genuinely nicer than the EVM path.
 *
 * Starknet invokes carry an ARRAY of calls executed atomically. So the
 * recipient transfer and the Sivan protocol fee go in ONE transaction: either
 * both move or neither does. On Celo the same outcome needs a second
 * transaction after the first confirms (see sendCeloTransfer), which can and
 * does leave a fee uncollected when the second one fails.
 */

import { hash as snHash, uint256, typedData as snTypedData } from 'starknet';
import type { StarknetCall } from './paymaster.js';

/**
 * Entry point selectors, DERIVED not hardcoded.
 *
 * starknet_keccak is keccak256 truncated to 250 bits. Deriving these at load
 * removes the class of bug where a pasted constant is subtly wrong, and the
 * suite cross-checks them against values computed independently.
 */
export const SN_SELECTOR = {
  transfer: snHash.getSelectorFromName('transfer'),
  balanceOf: snHash.getSelectorFromName('balanceOf'),
  symbol: snHash.getSelectorFromName('symbol'),
  decimals: snHash.getSelectorFromName('decimals'),
} as const;

/**
 * Convert a decimal amount to a u256 pair for calldata.
 *
 * Cairo has no native 256 bit integer, so a u256 argument occupies TWO felts
 * in calldata, low first. Passing a single felt produces a calldata array of
 * the wrong length and the call reverts, which at least fails loudly. The
 * dangerous direction is the reverse: reading a u256 as one felt, which is
 * handled in starknet-rpc.ts.
 *
 * String arithmetic on the way in, for the same reason fromBaseUnits uses it:
 * Number() loses precision above 2^53.
 */
export function toU256Calldata(amount: string, decimals: number): [string, string] {
  const trimmed = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) {
    throw new Error(
      `Amount ${amount} has more than ${decimals} decimal places. ` +
        'Truncating would move less than the user asked for.'
    );
  }
  const base = BigInt(whole + fraction.padEnd(decimals, '0'));
  const { low, high } = uint256.bnToUint256(base);
  return [String(low), String(high)];
}

/**
 * One ERC-20 transfer, as a Starknet call.
 *
 * calldata is [recipient, amount_low, amount_high].
 */
export function buildErc20TransferCall(
  tokenAddress: string,
  recipient: string,
  amount: string,
  decimals: number
): StarknetCall {
  const [low, high] = toU256Calldata(amount, decimals);
  return {
    contract_address: tokenAddress,
    entry_point_selector: SN_SELECTOR.transfer,
    calldata: [recipient, low, high],
  };
}

/**
 * The full call array for a Sivan transfer: recipient, then protocol fee.
 *
 * Both in one invoke, so they are atomic. Order matters only for readability;
 * Starknet executes them in sequence within a single transaction.
 *
 * A zero or absent fee produces a single call rather than a second call
 * moving nothing, because an explicit zero-value transfer still costs gas and
 * still shows up in the recipient's history as a confusing 0 USDC entry.
 */
export function buildSivanTransferCalls(input: {
  tokenAddress: string;
  recipient: string;
  amount: string;
  decimals: number;
  feeAmount?: string;
  feeRecipient?: string;
}): StarknetCall[] {
  const calls: StarknetCall[] = [
    buildErc20TransferCall(input.tokenAddress, input.recipient, input.amount, input.decimals),
  ];

  const fee = Number(input.feeAmount ?? 0);
  if (fee > 0 && input.feeRecipient) {
    calls.push(
      buildErc20TransferCall(
        input.tokenAddress,
        input.feeRecipient,
        String(input.feeAmount),
        input.decimals
      )
    );
  }
  return calls;
}

/**
 * SNIP-12 message hash for the typed data the paymaster returned.
 *
 * This is the value Privy signs. It is bound to the account address, so a
 * signature produced for one account cannot be replayed against another.
 *
 * Delegated to starknet.js deliberately. See the file header.
 */
export function computeTypedDataHash(typedData: unknown, accountAddress: string): string {
  return snTypedData.getMessageHash(typedData as any, accountAddress);
}
