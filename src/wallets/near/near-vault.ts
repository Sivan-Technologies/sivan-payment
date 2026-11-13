import { KeyPairEd25519 } from 'near-api-js';
import { generateNearKeypair } from './near-keypair.js';

export interface NearVaultConfig {
  accountId: string;
  privateKey: string;
  publicKey: string;
  isMainnet: boolean;
  network: 'mainnet' | 'testnet';
}

/**
 * Resolves the Sivan Transit Vault configuration on NEAR Protocol.
 * Cleanly differentiates between Testnet and Mainnet environments.
 *
 * Environment variables supported:
 * Testnet:
 *   - NEAR_VAULT_ACCOUNT_ID_TESTNET (e.g. "sivan-vault.testnet" or 64-char hex)
 *   - NEAR_VAULT_PRIVATE_KEY_TESTNET (e.g. "ed25519:...")
 * Mainnet:
 *   - NEAR_VAULT_ACCOUNT_ID_MAINNET (e.g. "sivan-vault.near" or 64-char hex)
 *   - NEAR_VAULT_PRIVATE_KEY_MAINNET (e.g. "ed25519:...")
 * Fallback / Legacy:
 *   - SIVAN_NEAR_VAULT_SEED
 */
export function getNearVaultConfig(production?: boolean): NearVaultConfig {
  const isMainnetMode =
    production !== undefined
      ? production
      : process.env.NETWORK_MODE === 'mainnet';

  const network: 'mainnet' | 'testnet' = isMainnetMode ? 'mainnet' : 'testnet';

  let rawAccountId = '';
  let rawPrivateKey = '';

  if (isMainnetMode) {
    rawAccountId =
      process.env.NEAR_VAULT_ACCOUNT_ID_MAINNET ||
      process.env.SIVAN_NEAR_VAULT_ACCOUNT_ID ||
      '';
    rawPrivateKey =
      process.env.NEAR_VAULT_PRIVATE_KEY_MAINNET ||
      process.env.SIVAN_NEAR_VAULT_PRIVATE_KEY ||
      process.env.SIVAN_NEAR_VAULT_SEED ||
      '';
  } else {
    rawAccountId =
      process.env.NEAR_VAULT_ACCOUNT_ID_TESTNET ||
      process.env.SIVAN_NEAR_VAULT_ACCOUNT_ID_TESTNET ||
      '';
    rawPrivateKey =
      process.env.NEAR_VAULT_PRIVATE_KEY_TESTNET ||
      process.env.SIVAN_NEAR_VAULT_PRIVATE_KEY_TESTNET ||
      process.env.SIVAN_NEAR_VAULT_SEED ||
      '';
  }

  let finalAccountId = rawAccountId.trim();
  let finalPrivateKey = rawPrivateKey.trim();
  let finalPublicKey = '';

  if (finalPrivateKey.startsWith('ed25519:')) {
    try {
      const nearKp = new KeyPairEd25519(finalPrivateKey.replace('ed25519:', ''));
      finalPublicKey = nearKp.getPublicKey().toString();
      const implicitHex = Buffer.from(nearKp.getPublicKey().data).toString('hex').toLowerCase();
      if (!finalAccountId) {
        finalAccountId = implicitHex;
      }
    } catch {
      // In case of invalid base58 string, fallback to seed generation
      const kp = generateNearKeypair(finalPrivateKey);
      finalPublicKey = kp.publicKey;
      finalPrivateKey = kp.secretKey;
      if (!finalAccountId) {
        finalAccountId = kp.accountId;
      }
    }
  } else if (finalPrivateKey.length > 0) {
    // Arbitrary seed phrase or secret string
    const kp = generateNearKeypair(finalPrivateKey);
    finalPublicKey = kp.publicKey;
    finalPrivateKey = kp.secretKey;
    if (!finalAccountId) {
      finalAccountId = kp.accountId;
    }
  } else {
    // Default deterministic vault seed for development / tests
    const defaultSeed = isMainnetMode ? 'sivan_transit_vault_mainnet' : 'sivan_transit_vault_testnet';
    const kp = generateNearKeypair(defaultSeed);
    finalPublicKey = kp.publicKey;
    finalPrivateKey = kp.secretKey;
    if (!finalAccountId) {
      finalAccountId = isMainnetMode ? 'sivan-vault.near' : 'sivan-vault.testnet';
    }
  }

  return {
    accountId: finalAccountId,
    privateKey: finalPrivateKey,
    publicKey: finalPublicKey,
    isMainnet: isMainnetMode,
    network,
  };
}
