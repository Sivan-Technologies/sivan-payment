/**
 * STARKNET CHAIN ADAPTER
 *
 * Implements IChainAdapter, the developer and agent facing contract, so
 * Starknet is reachable from the Developer Gateway rather than only from the
 * user wallet path.
 *
 * SCOPE, STATED PLAINLY: this is the READ and VALIDATE surface. transfer()
 * intentionally refuses rather than pretending.
 *
 * Why transfer() refuses instead of being stubbed to "success": Privy supports
 * Starknet at Tier 2, which means it will create the wallet and sign a hash
 * via rawSign, but it will NOT broadcast. Completing a transfer requires
 * building the invoke transaction, computing the v3 transaction hash, signing,
 * assembling, and submitting it ourselves. Until that is done and tested
 * against Sepolia, a transfer() that returns a fake hash would be worse than
 * one that throws, because a caller would record a settlement that never
 * happened.
 *
 * The same discipline the Stellar lab uses: anything simulated says so.
 */

import type {
  IChainAdapter,
  ChainTransferParams,
  ChainTransferResult,
} from '../IChainAdapter.js';
import { validateAddressForChain, normaliseStarknetAddress } from '../address-validation.js';
import {
  starknetErc20Balance,
  starknetChainId,
  isAccountDeployed,
  STARKNET_CHAIN_ID,
} from './starknet-rpc.js';
import { resolveNetworkMode, isMainnet } from '../network-mode.js';

/**
 * Native Circle USDC on Starknet.
 *
 * Read back from the chain before being written here, the same standard the
 * Celo and Arbitrum entries were held to:
 *
 *   mainnet 0x033068F6...93b35fb  symbol() "USDC"  decimals() 6
 *
 * Note the decimals. Starknet USDC is 6dp, matching every other chain EXCEPT
 * Arc, where native USDC is 18dp. Two different answers across the estate,
 * which is why decimals must always come from a (chain, asset) lookup and
 * never from the asset alone.
 */
export const STARKNET_USDC = {
  mainnet: '0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb',
  testnet: process.env.STARKNET_USDC_TESTNET_ADDRESS || '',
} as const;

export const STARKNET_USDC_DECIMALS = 6;

export class StarknetAdapter implements IChainAdapter {
  readonly chain = 'starknet';

  private production(): boolean {
    return isMainnet(resolveNetworkMode());
  }

  private usdcAddress(): string {
    const addr = this.production() ? STARKNET_USDC.mainnet : STARKNET_USDC.testnet;
    if (!addr) {
      throw new Error(
        'No Starknet USDC address is configured for this network mode. ' +
          'Set STARKNET_USDC_TESTNET_ADDRESS to run against Sepolia.'
      );
    }
    return addr;
  }

  /**
   * Starknet wallets are provisioned through Privy with chain_type "starknet",
   * which generates STARK curve key material. There is no derivation from an
   * existing EVM wallet, so there is nothing to compute here without a
   * provisioned wallet row.
   */
  async getDepositAddress(_userId: string): Promise<string> {
    throw new Error(
      'Starknet deposit addresses are provisioned through the wallet service, ' +
        'not derived. Create a Starknet wallet for this user first.'
    );
  }

  async getBalance(_userId: string, _asset = 'usdc'): Promise<number> {
    throw new Error(
      'Starknet balance lookup by userId requires a provisioned wallet row. ' +
        'Use balanceForAddress() with a known address.'
    );
  }

  /** Read a USDC balance for an address. Normalises before use. */
  async balanceForAddress(address: string): Promise<number> {
    const normalised = normaliseStarknetAddress(address);
    const amount = await starknetErc20Balance(
      this.usdcAddress(),
      normalised,
      STARKNET_USDC_DECIMALS,
      { production: this.production() }
    );
    return Number(amount);
  }

  /** Is an account contract deployed at this address yet? */
  async isDeployed(address: string): Promise<boolean> {
    return isAccountDeployed(normaliseStarknetAddress(address), {
      production: this.production(),
    });
  }

  async transfer(_params: ChainTransferParams): Promise<ChainTransferResult> {
    throw new Error(
      'Starknet transfers are not yet enabled. Privy supports Starknet at Tier 2 ' +
        '(sign only, no broadcast), so the invoke transaction must be built, hashed, ' +
        'signed and submitted by Sivan. That path is not implemented and must not ' +
        'be simulated: a transfer that returns a hash it did not create would record ' +
        'a settlement that never happened.'
    );
  }

  validateAddress(address: string): boolean {
    return validateAddressForChain(address, 'starknet').valid;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const expected = this.production()
        ? STARKNET_CHAIN_ID.mainnet
        : STARKNET_CHAIN_ID.testnet;
      const actual = await starknetChainId({ production: this.production(), timeoutMs: 5_000 });
      return actual === expected;
    } catch {
      return false;
    }
  }
}
