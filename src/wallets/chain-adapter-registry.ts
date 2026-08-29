import { IChainAdapter } from './IChainAdapter.js';
import { SolanaAdapter } from './solana/SolanaAdapter.js';
import { EvmAdapter } from './evm/EvmAdapter.js';
import { StellarAdapter } from './stellar/StellarAdapter.js';

const solanaAdapter = new SolanaAdapter();
const baseAdapter = new EvmAdapter('base');
const ethereumAdapter = new EvmAdapter('ethereum');
const stellarAdapter = new StellarAdapter();

export function getChainAdapter(chain: string): IChainAdapter {
  const normalized = String(chain || '').toLowerCase().trim();

  switch (normalized) {
    case 'solana':
      return solanaAdapter;
    case 'base':
      return baseAdapter;
    case 'ethereum':
      return ethereumAdapter;
    case 'stellar':
      return stellarAdapter;
    default:
      throw new Error(`Unsupported chain adapter requested: ${chain}`);
  }
}
