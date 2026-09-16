import { IChainAdapter } from './IChainAdapter.js';
import { SolanaAdapter } from './solana/SolanaAdapter.js';
import { EvmAdapter } from './evm/EvmAdapter.js';
import { StellarAdapter } from './stellar/StellarAdapter.js';
import { CeloAdapter } from './celo/CeloAdapter.js';

const solanaAdapter = new SolanaAdapter();
const baseAdapter = new EvmAdapter('base');
const ethereumAdapter = new EvmAdapter('ethereum');
const bscAdapter = new EvmAdapter('bsc');
const stellarAdapter = new StellarAdapter();
const celoAdapter = new CeloAdapter();

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
    default:
      throw new Error(`Unsupported chain adapter requested: ${chain}`);
  }
}
