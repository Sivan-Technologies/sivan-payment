import { env } from '../../config/env.js';
import { MockWalletProvider } from './mock-wallet.provider.js';
import type { WalletProvider } from './wallet-provider.js';
import type { WalletProviderName } from '../types/wallet.types.js';

/**
 * Single switch point between wallet vendors.
 *
 * Adding Bridge or Privy should mean implementing WalletProvider and adding a
 * branch here. No service, route, or UI change should be required.
 *
 * Current status:
 *   mock   — implemented, used for local development and UI work
 *   bridge — pending Legal & Compliance approval and wallet pricing
 *   privy  — pending evaluation; non-custodial, likely cleaner under
 *            Bridge ToS 2.1(m) since Sivan would hold neither funds nor keys
 */
export function getWalletProvider(
  providerName = process.env.WALLET_PROVIDER || 'mock'
): WalletProvider {
  const normalized = providerName.trim().toLowerCase() as WalletProviderName;

  if (normalized === 'mock') {
    if (env.APP_ENV === 'production') {
      throw new Error(
        'Mock wallet provider is disabled in production. Configure WALLET_PROVIDER=bridge or privy.'
      );
    }
    return new MockWalletProvider();
  }

  if (normalized === 'bridge') {
    throw new Error(
      'Bridge wallet provider is not implemented yet. Pending Bridge Legal & Compliance approval ' +
      'of the wallet fund flow and confirmation of per-wallet pricing.'
    );
  }

  if (normalized === 'privy') {
    throw new Error(
      'Privy wallet provider is not implemented yet. Pending evaluation of Solana support depth ' +
      'and gas sponsorship approach.'
    );
  }

  throw new Error(`Unsupported wallet provider: ${providerName}`);
}
