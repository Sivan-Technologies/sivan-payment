import { env } from '../../config/env.js';
import { fetchStellarAccount } from './stellar-rpc.js';

/**
 * Stellar USDC Trustline Configuration & Management.
 *
 * Official Circle USDC Issuers on Stellar:
 * Mainnet: GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
 * Testnet: GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
 */

export const STELLAR_USDC_ISSUER_MAINNET = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
export const STELLAR_USDC_ISSUER_TESTNET = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

export function getStellarUsdcIssuer(): string {
  const isProd = env.APP_ENV === 'production';
  return (process.env.STELLAR_USDC_ISSUER || '').trim() || (isProd ? STELLAR_USDC_ISSUER_MAINNET : STELLAR_USDC_ISSUER_TESTNET);
}

export async function hasUsdcTrustline(accountId: string): Promise<boolean> {
  const account = await fetchStellarAccount(accountId);
  if (!account) return false;

  const expectedIssuer = getStellarUsdcIssuer();
  return account.balances.some(
    (b) => (b.asset_code === 'USDC' || b.asset_code === 'usdc') && b.asset_issuer === expectedIssuer
  );
}
