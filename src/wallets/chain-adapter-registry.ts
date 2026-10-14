import { IChainAdapter } from './IChainAdapter.js';
import { SolanaAdapter } from './solana/SolanaAdapter.js';
import { EvmAdapter } from './evm/EvmAdapter.js';
import { StellarAdapter } from './stellar/StellarAdapter.js';
import { CeloAdapter } from './celo/CeloAdapter.js';
import { StarknetAdapter } from './starknet/StarknetAdapter.js';

const solanaAdapter = new SolanaAdapter();
const baseAdapter = new EvmAdapter('base');
const ethereumAdapter = new EvmAdapter('ethereum');
const bscAdapter = new EvmAdapter('bsc');
const stellarAdapter = new StellarAdapter();
const celoAdapter = new CeloAdapter();
/**
 * Arbitrum and Arc were added to WalletChain and to the Privy provider path
 * but never registered HERE, so getChainAdapter('arc') threw
 * "Unsupported chain adapter requested" and the Developer Gateway could not
 * serve either chain. Two registration points exist and only one was used.
 * Registering all of them now, and adding Starknet alongside.
 */
const arbitrumAdapter = new EvmAdapter('arbitrum');
const arcAdapter = new EvmAdapter('arc');
const starknetAdapter = new StarknetAdapter();

export function getChainAdapter(chain: string): IChainAdapter {
  const normalized = String(chain || '').toLowerCase().trim();

  switch (normalized) {
    case 'solana':
      return solanaAdapter;
    case 'base':
      return baseAdapter;
    case 'ethereum':
      return ethereumAdapter;
    case 'bsc':
    case 'bnb':
      return bscAdapter;
    case 'stellar':
      return stellarAdapter;
    case 'celo':
      return celoAdapter;
    case 'arbitrum':
      return arbitrumAdapter;
    case 'arc':
      return arcAdapter;
    case 'starknet':
      return starknetAdapter;
    default:
      throw new Error(`Unsupported chain adapter requested: ${chain}`);
  }
}
