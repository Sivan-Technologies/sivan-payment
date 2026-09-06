import { env } from '../../config/env.js';
import { fetchStellarAccount, horizonEndpoint } from './stellar-rpc.js';
import { generateStellarKeypair } from './stellar-keypair.js';
import {
  Keypair,
  Asset,
  Networks,
  TransactionBuilder,
  Operation,
  Horizon,
} from '@stellar/stellar-sdk';

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

/**
 * Ensures a Stellar account is funded on-chain and has an active Circle USDC trustline.
 * Automatically runs in the background when a Stellar wallet is created or queried.
 */
export async function ensureStellarAccountAndTrustline(
  seedOrSecret: string,
  address?: string
): Promise<{ success: boolean; address: string; trustlineActive: boolean; error?: string }> {
  try {
    let keypair: Keypair;
    if (seedOrSecret.startsWith('S') && seedOrSecret.length === 56) {
      keypair = Keypair.fromSecret(seedOrSecret);
    } else {
      const kp = generateStellarKeypair(seedOrSecret);
      keypair = Keypair.fromSecret(kp.secretKey);
    }

    const pubkey = address || keypair.publicKey();
    const isProd = env.APP_ENV === 'production';
    const horizonUrl = horizonEndpoint();
    const server = new Horizon.Server(horizonUrl);
    const networkPassphrase = isProd ? Networks.PUBLIC : Networks.TESTNET;

    // 1. Check if account exists on Horizon
    let account = await fetchStellarAccount(pubkey);
    if (!account) {
      if (!isProd) {
        // Fund via Friendbot on Testnet
        try {
          const fbRes = await fetch(`https://friendbot.stellar.org/?addr=${pubkey}`);
          await fbRes.json().catch(() => ({}));
          await new Promise((r) => setTimeout(r, 2000));
          account = await fetchStellarAccount(pubkey);
        } catch (fbErr) {
          console.warn('[stellar_trustline.friendbot_error]', fbErr);
        }
      }
    }

    if (!account) {
      return { success: false, address: pubkey, trustlineActive: false, error: 'Account not initialized on network' };
    }

    // 2. Check if trustline is already active
    const alreadyHasTrustline = await hasUsdcTrustline(pubkey);
    if (alreadyHasTrustline) {
      return { success: true, address: pubkey, trustlineActive: true };
    }

    // 3. Build & submit ChangeTrust transaction
    const stellarAccount = await server.loadAccount(pubkey);
    const usdcAsset = new Asset('USDC', getStellarUsdcIssuer());
    const tx = new TransactionBuilder(stellarAccount, {
      fee: '100',
      networkPassphrase,
    })
      .addOperation(
        Operation.changeTrust({
          asset: usdcAsset,
        })
      )
      .setTimeout(30)
      .build();

    tx.sign(keypair);
    await server.submitTransaction(tx);

    return {
      success: true,
      address: pubkey,
      trustlineActive: true,
    };
  } catch (err: any) {
    const errorDetails = err?.response?.data || err?.data || {};
    const msg = errorDetails?.extras?.result_codes ? JSON.stringify(errorDetails.extras.result_codes) : (err instanceof Error ? err.message : String(err));
    console.warn('[stellar_trustline.ensure_error]', { address, error: msg, details: errorDetails });
    return {
      success: false,
      address: address || '',
      trustlineActive: false,
      error: msg,
    };
  }
}
