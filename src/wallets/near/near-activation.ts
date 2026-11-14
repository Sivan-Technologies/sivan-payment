import crypto from 'node:crypto';
import {
  actions,
  createTransaction,
  KeyPairEd25519,
  baseDecode,
  baseEncode,
  SignedTransaction,
  Signature,
  encodeTransaction,
} from 'near-api-js';
import { generateNearAddress, generateNearKeypair } from './near-keypair.js';
import {
  getNearRpcUrl,
  getNearUsdcContract,
  NEAR_CIRCLE_USDC_TESTNET,
  NEAR_FAKES_USDC_TESTNET,
  isNearStorageRegistered,
  fetchNearNativeBalance,
} from './near-rpc.js';
import { getNearVaultConfig } from './near-vault.js';
import {
  fetchAccessKeyNonce,
  fetchRecentBlockHash,
  broadcastSignedTransaction,
} from './near-transfer.js';

export interface NearActivationResult {
  success: boolean;
  address: string;
  nativeActivated: boolean;
  usdcStorageRegistered: boolean;
  txHashes: string[];
  error?: string;
}

/**
 * Standard NEP-145 storage deposit attached deposit (0.00125 NEAR in yoctoNEAR).
 * Exact minimum for registering an account on standard NEP-141 token contracts.
 */
const STORAGE_DEPOSIT_YOCTO = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR
const STANDARD_FUNCTION_GAS = 30_000_000_000_000n; // 30 TGas

/**
 * Executes a single storage_deposit call on a NEP-141 contract.
 */
async function executeStorageDepositCall(
  signerAccountId: string,
  signerKp: KeyPairEd25519,
  targetContractId: string,
  recipientAddress: string,
  rpcUrl: string
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const signerPubKeyStr = signerKp.getPublicKey().toString();
    const accessKey = await fetchAccessKeyNonce(rpcUrl, signerAccountId, signerPubKeyStr);
    let recentBlockHashStr: string | null = accessKey?.blockHash ?? null;

    if (!recentBlockHashStr) {
      recentBlockHashStr = await fetchRecentBlockHash(rpcUrl);
    }

    const currentNonce = accessKey ? accessKey.nonce : 1n;
    const nextNonce = currentNonce + 1n;
    const safeBlockHashStr = recentBlockHashStr || 'HqvnUa4uvRVSio8tpSMsiZToAsMjdQaG5NM8hsqfsXdw';
    const recentBlockHashBytes = baseDecode(safeBlockHashStr);

    const action = actions.functionCall(
      'storage_deposit',
      {
        account_id: recipientAddress,
        registration_only: true,
      },
      STANDARD_FUNCTION_GAS,
      STORAGE_DEPOSIT_YOCTO
    );

    const tx = createTransaction(
      signerAccountId,
      signerKp.getPublicKey(),
      targetContractId,
      nextNonce,
      [action],
      recentBlockHashBytes
    );

    const serializedTx = encodeTransaction(tx);
    const txHashBytes = crypto.createHash('sha256').update(serializedTx).digest();
    const sig = signerKp.sign(txHashBytes);

    const signedTx = new SignedTransaction({
      transaction: tx,
      signature: new Signature({
        keyType: tx.publicKey.keyType,
        data: sig.signature,
      }),
    });

    const bcast = await broadcastSignedTransaction(rpcUrl, signedTx);
    if (!bcast.success) {
      return { success: false, error: bcast.error };
    }

    return { success: true, txHash: bcast.txHash || baseEncode(txHashBytes) };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Executes a native NEAR micro-transfer to activate an implicit account on-chain.
 */
async function executeNativeActivationTransfer(
  vaultAccountId: string,
  vaultKp: KeyPairEd25519,
  recipientAddress: string,
  rpcUrl: string
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const signerPubKeyStr = vaultKp.getPublicKey().toString();
    const accessKey = await fetchAccessKeyNonce(rpcUrl, vaultAccountId, signerPubKeyStr);
    let recentBlockHashStr: string | null = accessKey?.blockHash ?? null;

    if (!recentBlockHashStr) {
      recentBlockHashStr = await fetchRecentBlockHash(rpcUrl);
    }

    const currentNonce = accessKey ? accessKey.nonce : 1n;
    const nextNonce = currentNonce + 1n;
    const safeBlockHashStr = recentBlockHashStr || 'HqvnUa4uvRVSio8tpSMsiZToAsMjdQaG5NM8hsqfsXdw';
    const recentBlockHashBytes = baseDecode(safeBlockHashStr);

    // 0.02 NEAR in yoctoNEAR
    const activationYocto = 20_000_000_000_000_000_000_000n;
    const action = actions.transfer(activationYocto);

    const tx = createTransaction(
      vaultAccountId,
      vaultKp.getPublicKey(),
      recipientAddress,
      nextNonce,
      [action],
      recentBlockHashBytes
    );

    const serializedTx = encodeTransaction(tx);
    const txHashBytes = crypto.createHash('sha256').update(serializedTx).digest();
    const sig = vaultKp.sign(txHashBytes);

    const signedTx = new SignedTransaction({
      transaction: tx,
      signature: new Signature({
        keyType: tx.publicKey.keyType,
        data: sig.signature,
      }),
    });

    const bcast = await broadcastSignedTransaction(rpcUrl, signedTx);
    if (!bcast.success) {
      return { success: false, error: bcast.error };
    }

    return { success: true, txHash: bcast.txHash || baseEncode(txHashBytes) };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Ensures a NEAR implicit wallet is activated on-chain and registered for NEP-141 USDC storage.
 * Automatically runs in the background when a NEAR wallet is created or queried on Sivan.
 *
 * 1. Checks if the account is already registered for storage on the USDC contract(s).
 * 2. If already registered, exits immediately (0 gas, 0 RPC mutations, idempotent).
 * 3. If missing storage, uses Sivan Transit Vault to sponsor storage_deposit for the user address.
 * 4. If the user account also has 0 native NEAR, transfers 0.02 NEAR to activate the implicit account.
 * 5. If Vault is unfunded, checks whether user received native NEAR to self-register.
 */
export async function ensureNearAccountAndStorage(
  userIdOrSeed: string,
  address?: string,
  options?: { production?: boolean }
): Promise<NearActivationResult> {
  const isProd =
    typeof options?.production === 'boolean'
      ? options.production
      : process.env.NETWORK_MODE === 'mainnet';

  const userSeed = userIdOrSeed.startsWith('sivan_near_')
    ? userIdOrSeed
    : `sivan_near_${userIdOrSeed}`;

  const targetAddress = address || generateNearAddress(userSeed);
  const rpcUrl = getNearRpcUrl(isProd);
  const txHashes: string[] = [];

  const targetContracts: string[] = isProd
    ? [getNearUsdcContract(true)]
    : [NEAR_CIRCLE_USDC_TESTNET, NEAR_FAKES_USDC_TESTNET];

  try {
    // 1. Inspect current status: native balance and storage registrations
    const [nativeBalanceStr, ...storageStatuses] = await Promise.all([
      fetchNearNativeBalance(targetAddress, isProd),
      ...targetContracts.map((c) => isNearStorageRegistered(targetAddress, c, isProd)),
    ]);

    const hasNativeBalance = parseFloat(nativeBalanceStr) > 0.005;
    const allRegistered = storageStatuses.every(Boolean);

    if (allRegistered && hasNativeBalance) {
      return {
        success: true,
        address: targetAddress,
        nativeActivated: true,
        usdcStorageRegistered: true,
        txHashes: [],
      };
    }

    // 2. Identify which contracts need storage_deposit
    const contractsToRegister = targetContracts.filter((_, idx) => !storageStatuses[idx]);

    // 3. Check Sivan Transit Vault configuration and balance
    const vaultConfig = getNearVaultConfig(isProd);
    const vaultKp = new KeyPairEd25519(vaultConfig.privateKey.replace('ed25519:', ''));
    const vaultBalanceStr = await fetchNearNativeBalance(vaultConfig.accountId, isProd);
    const vaultHasFunds = parseFloat(vaultBalanceStr) >= 0.005;

    let nativeActivated = hasNativeBalance;
    let usdcStorageRegistered = allRegistered;

    if (vaultHasFunds) {
      // Step A: Activate native implicit account if needed
      if (!hasNativeBalance && parseFloat(vaultBalanceStr) >= 0.025) {
        const actRes = await executeNativeActivationTransfer(
          vaultConfig.accountId,
          vaultKp,
          targetAddress,
          rpcUrl
        );
        if (actRes.success && actRes.txHash) {
          txHashes.push(actRes.txHash);
          nativeActivated = true;
        }
      }

      // Step B: Sivan Transit Vault sponsors storage_deposit on required contracts
      for (const contractId of contractsToRegister) {
        const depRes = await executeStorageDepositCall(
          vaultConfig.accountId,
          vaultKp,
          contractId,
          targetAddress,
          rpcUrl
        );
        if (depRes.success && depRes.txHash) {
          txHashes.push(depRes.txHash);
          usdcStorageRegistered = true;
        }
      }

      return {
        success: true,
        address: targetAddress,
        nativeActivated,
        usdcStorageRegistered,
        txHashes,
      };
    }

    // 4. Fallback: If Vault is unfunded, check if user account itself has native balance
    if (hasNativeBalance) {
      const userKpRaw = generateNearKeypair(userSeed);
      const userKp = new KeyPairEd25519(userKpRaw.secretKey.replace('ed25519:', ''));

      for (const contractId of contractsToRegister) {
        const depRes = await executeStorageDepositCall(
          targetAddress,
          userKp,
          contractId,
          targetAddress,
          rpcUrl
        );
        if (depRes.success && depRes.txHash) {
          txHashes.push(depRes.txHash);
          usdcStorageRegistered = true;
        }
      }

      return {
        success: true,
        address: targetAddress,
        nativeActivated: true,
        usdcStorageRegistered,
        txHashes,
      };
    }

    // 5. If neither vault nor user is currently funded
    console.info(
      `[near_activation.unfunded] Transit vault and user wallet require native NEAR for storage registration. Target: ${targetAddress}, Vault: ${vaultConfig.accountId}`
    );

    return {
      success: false,
      address: targetAddress,
      nativeActivated: false,
      usdcStorageRegistered: false,
      txHashes: [],
      error: `Transit vault (${vaultConfig.accountId}) unfunded`,
    };
  } catch (err: any) {
    console.warn('[near_activation.error]', err);
    return {
      success: false,
      address: targetAddress,
      nativeActivated: false,
      usdcStorageRegistered: false,
      txHashes,
      error: err?.message || String(err),
    };
  }
}

