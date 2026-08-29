import { env } from '../../config/env.js';

/**
 * Stellar Fee-Bump Transactions & Master Vault Sponsorship (CAP-0015 / CAP-0033).
 *
 * All Stellar user operations on Sivan are 100% zero-gas for the end-user.
 * The Sivan Master Vault account sponsors the 100 stroops (0.00001 XLM) base fee.
 */

export interface FeeSponsorshipConfig {
  masterVaultAccountId: string;
  maxBaseFeeStroops: number;
  sponsoredReservesEnabled: boolean;
}

export function getFeeSponsorshipConfig(): FeeSponsorshipConfig {
  return {
    masterVaultAccountId: (process.env.STELLAR_MASTER_VAULT_ACCOUNT_ID || 'G_SIVAN_MASTER_VAULT_PLACEHOLDER').trim(),
    maxBaseFeeStroops: parseInt(process.env.STELLAR_MAX_FEE_STROOPS || '1000', 10),
    sponsoredReservesEnabled: process.env.STELLAR_SPONSORED_RESERVES === 'true' || true,
  };
}
