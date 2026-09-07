import { env } from '../../config/env.js';
import { resolveNetworkMode } from '../network-mode.js';
import { fetchStellarAccount, horizonEndpoints } from './stellar-rpc.js';
import { generateStellarKeypair } from './stellar-keypair.js';
import {
  Keypair,
  Asset,
  Networks,
  TransactionBuilder,
  Operation,
  Account,
} from '@stellar/stellar-sdk';

/**
 * Stellar USDC & USDT Trustline Configuration & Management.
 *
 * Official Circle USDC Issuers on Stellar:
 * Mainnet: GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
 * Testnet: GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
 *
 * Official Tether USDT Issuers on Stellar:
 * Mainnet: GCQTGZQQ5G4PTM2GL7CDIFKUBIPEC52BROAQJUOBURW3FSTKTRNMGXB5
 * Testnet: GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
 */

export const STELLAR_USDC_ISSUER_MAINNET = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
export const STELLAR_USDC_ISSUER_TESTNET = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

export const STELLAR_USDT_ISSUER_MAINNET = 'GCQTGZQQ5G4PTM2GL7CDIFKUBIPEC52BROAQJUOBURW3FSTKTRNMGXB5';
export const STELLAR_USDT_ISSUER_TESTNET = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

export function getStellarUsdcIssuer(options?: { production?: boolean }): string {
  const isProd = typeof options?.production === 'boolean' ? options.production : resolveNetworkMode() === 'mainnet';
  return (process.env.STELLAR_USDC_ISSUER || '').trim() || (isProd ? STELLAR_USDC_ISSUER_MAINNET : STELLAR_USDC_ISSUER_TESTNET);
}

export function getStellarUsdtIssuer(options?: { production?: boolean }): string {
  const isProd = typeof options?.production === 'boolean' ? options.production : resolveNetworkMode() === 'mainnet';
  return (process.env.STELLAR_USDT_ISSUER || '').trim() || (isProd ? STELLAR_USDT_ISSUER_MAINNET : STELLAR_USDT_ISSUER_TESTNET);
}

export async function hasUsdcTrustline(accountId: string, options?: { production?: boolean }): Promise<boolean> {
  const account = await fetchStellarAccount(accountId, options);
  if (!account) return false;

  const expectedIssuer = getStellarUsdcIssuer(options);
  return account.balances.some(
    (b) => (b.asset_code === 'USDC' || b.asset_code === 'usdc') && b.asset_issuer === expectedIssuer
  );
}

export async function hasUsdtTrustline(accountId: string, options?: { production?: boolean }): Promise<boolean> {
  const account = await fetchStellarAccount(accountId, options);
  if (!account) return false;

  const expectedIssuer = getStellarUsdtIssuer(options);
  return account.balances.some(
    (b) => (b.asset_code === 'USDT' || b.asset_code === 'usdt') && b.asset_issuer === expectedIssuer
  );
}

/**
 * Ensures a Stellar account is funded on-chain and has active USDC and USDT trustlines.
 * Automatically runs in the background when a Stellar wallet is created or queried.
 */
export async function ensureStellarAccountAndTrustline(
  seedOrSecret: string,
  address?: string,
  options?: { production?: boolean }
): Promise<{ success: boolean; address: string; trustlineActive: boolean; usdcActive?: boolean; usdtActive?: boolean; error?: string }> {
  try {
    let keypair: Keypair;
    if (seedOrSecret.startsWith('S') && seedOrSecret.length === 56) {
      keypair = Keypair.fromSecret(seedOrSecret);
    } else {
      const kp = generateStellarKeypair(seedOrSecret);
      keypair = Keypair.fromSecret(kp.secretKey);
    }

    const pubkey = address || keypair.publicKey();
    const isProd = typeof options?.production === 'boolean' ? options.production : resolveNetworkMode() === 'mainnet';
    const networkPassphrase = isProd ? Networks.PUBLIC : Networks.TESTNET;

    // 1. Check if account exists on Horizon
    let account = await fetchStellarAccount(pubkey, options);
    if (!account) {
      if (!isProd) {
        // Fund via Friendbot on Testnet
        try {
          const fbRes = await fetch(`https://friendbot.stellar.org/?addr=${pubkey}`);
          await fbRes.json().catch(() => ({}));
          await new Promise((r) => setTimeout(r, 2000));
          account = await fetchStellarAccount(pubkey, options);
        } catch (fbErr) {
          console.warn('[stellar_trustline.friendbot_error]', fbErr);
        }
      }
    }

    if (!account) {
      return { success: false, address: pubkey, trustlineActive: false, error: 'Account not initialized on network' };
    }

    // 2. Check if trustlines are already active
    const hasUsdc = await hasUsdcTrustline(pubkey, options);
    const hasUsdt = await hasUsdtTrustline(pubkey, options);

    if (hasUsdc && hasUsdt) {
      return { success: true, address: pubkey, trustlineActive: true, usdcActive: true, usdtActive: true };
    }

    // 3. Build & submit ChangeTrust transaction for missing trustlines
    const stellarAccount = new Account(pubkey, account.sequence);
    const builder = new TransactionBuilder(stellarAccount, {
      fee: '200',
      networkPassphrase,
    });

    if (!hasUsdc) {
      builder.addOperation(
        Operation.changeTrust({
          asset: new Asset('USDC', getStellarUsdcIssuer()),
        })
      );
    }

    if (!hasUsdt) {
      builder.addOperation(
        Operation.changeTrust({
          asset: new Asset('USDT', getStellarUsdtIssuer()),
        })
      );
    }

    const tx = builder.setTimeout(30).build();
    tx.sign(keypair);
    const xdr = tx.toXDR();

    const endpoints = horizonEndpoints();
    let submitted = false;
    let submitErrorMsg = '';

    for (const base of endpoints) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await fetch(`${base}/transactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ tx: xdr }),
          signal: controller.signal,
        });
        const data: any = await res.json().catch(() => ({}));
        if (res.ok || data.successful || data.hash) {
          submitted = true;
          break;
        } else {
          submitErrorMsg = data?.extras?.result_codes ? JSON.stringify(data.extras.result_codes) : (data?.title || `HTTP ${res.status}`);
        }
      } catch (err: any) {
        submitErrorMsg = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
      }
    }

    if (!submitted) {
      throw new Error(`Stellar trustline transaction submission failed: ${submitErrorMsg}`);
    }

    return {
      success: true,
      address: pubkey,
      trustlineActive: true,
      usdcActive: true,
      usdtActive: true,
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
