import { encodeErc20Transfer } from '../provider/privy-wallet.provider.js';
import { toDataSuffix, fromDataSuffix } from '@celo/attribution-tags';
export { toDataSuffix, fromDataSuffix };

/**
 * Official Sivan AI Hackathon Attribution Tag on Celo Mainnet.
 * Cryptographically derived from Sivan-Technologies/Sivan and registered
 * with Celo Builders for the Agents at Work Hackathon.
 */
export const SIVAN_CELO_ATTRIBUTION_TAG = 'celo_bafcc2e56bd7';

/**
 * Appends the ERC-8021 attribution suffix to Celo transaction calldata.
 */
export function attachCeloAttributionTag(calldata: string, tag: string = SIVAN_CELO_ATTRIBUTION_TAG): string {
  if (!tag) return calldata;
  const suffix = toDataSuffix(tag).slice(2);
  return `${calldata}${suffix}`;
}

/**
 * Canonical Multicall3 contract deployed on Celo Mainnet (42220) and Celo Sepolia (44787).
 */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

export interface Multicall3Call {
  target: string;
  allowFailure: boolean;
  callData: string;
}

/**
 * ABI-encode Multicall3 aggregate3((address,bool,bytes)[]).
 * Function selector: 0x82ad56a4
 */
export function encodeMulticall3Aggregate3(calls: Multicall3Call[]): string {
  const selector = '0x82ad56a4';
  if (!calls.length) {
    throw new Error('Multicall3 calls array cannot be empty');
  }

  // Offset to the start of the calls array (32 bytes = 0x20)
  const arrayOffset = '0000000000000000000000000000000000000000000000000000000000000020';
  const arrayLength = calls.length.toString(16).padStart(64, '0');

  // Calculate offsets for each Call3 tuple
  const encodedTuples: string[] = [];
  for (const call of calls) {
    const target = call.target.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    const allowFailure = (call.allowFailure ? '1' : '0').padStart(64, '0');
    
    // callData bytes encoding
    const rawBytes = call.callData.replace(/^0x/, '');
    const byteLength = (rawBytes.length / 2).toString(16).padStart(64, '0');
    // pad to 32-byte (64 hex char) boundary
    const paddedBytes = rawBytes.padEnd(Math.ceil(rawBytes.length / 64) * 64, '0');

    // Inside the tuple: target (32b), allowFailure (32b), offset to callData bytes (32b = 0x60 = 96)
    const callDataOffset = '0000000000000000000000000000000000000000000000000000000000000060';
    const tupleData = target + allowFailure + callDataOffset + byteLength + paddedBytes;
    encodedTuples.push(tupleData);
  }

  // Dynamic offsets table
  let currentOffset = calls.length * 32;
  let offsetsHex = '';
  for (const tuple of encodedTuples) {
    offsetsHex += currentOffset.toString(16).padStart(64, '0');
    currentOffset += tuple.length / 2;
  }

  return selector + arrayOffset + arrayLength + offsetsHex + encodedTuples.join('');
}

export interface CeloTransferPlan {
  to: string;
  data: string;
  value: string;
  isMulticall: boolean;
  netAmount: string;
  feeAmount: string;
}

/**
 * Builds the Celo transfer execution payload.
 * If feeAmount > 0 and feeWallet is provided, bundles recipient payment and
 * Sivan protocol fee collection atomically via Multicall3 in a single transaction.
 */
export function buildCeloTransferPayload(options: {
  tokenAddress: string;
  recipientAddress: string;
  amount: string;
  feeAmount?: string;
  feeWallet?: string;
  decimals?: number;
  attributionTag?: string | null;
}): CeloTransferPlan {
  const decimals = options.decimals ?? 6;
  const rawFee = options.feeAmount ? parseFloat(options.feeAmount) : 0;
  const rawTotal = parseFloat(options.amount);
  const tag = options.attributionTag === null ? '' : (options.attributionTag ?? SIVAN_CELO_ATTRIBUTION_TAG);

  const hasFee = rawFee > 0 && Boolean(options.feeWallet?.trim());

  if (hasFee && options.feeWallet) {
    const netAmount = Math.max(0, rawTotal - rawFee).toFixed(decimals);
    const feeAmount = rawFee.toFixed(decimals);

    const call1Data = encodeErc20Transfer(options.recipientAddress, netAmount, decimals);
    const call2Data = encodeErc20Transfer(options.feeWallet.trim(), feeAmount, decimals);

    const multicallData = encodeMulticall3Aggregate3([
      { target: options.tokenAddress, allowFailure: false, callData: call1Data },
      { target: options.tokenAddress, allowFailure: false, callData: call2Data },
    ]);

    return {
      to: MULTICALL3_ADDRESS,
      data: tag ? attachCeloAttributionTag(multicallData, tag) : multicallData,
      value: '0x0',
      isMulticall: true,
      netAmount,
      feeAmount,
    };
  }

  // Standard single transfer
  const data = encodeErc20Transfer(options.recipientAddress, options.amount, decimals);
  return {
    to: options.tokenAddress,
    data: tag ? attachCeloAttributionTag(data, tag) : data,
    value: '0x0',
    isMulticall: false,
    netAmount: options.amount,
    feeAmount: '0',
  };
}
