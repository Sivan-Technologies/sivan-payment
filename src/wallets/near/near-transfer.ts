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
import { generateNearKeypair } from './near-keypair.js';
import { getNearRpcUrl, getNearUsdcContract } from './near-rpc.js';
import { getNearVaultConfig } from './near-vault.js';

export interface NearTransferInput {
  senderUserId: string;
  senderSeed?: string;
  senderAccountId?: string;
  senderPrivateKey?: string;
  useVault?: boolean;
  recipientAddress: string;
  amount: string; // e.g. "15.000000" or "1.5"
  asset?: 'usdc' | 'near';
  production?: boolean;
}

export interface NearTransferResult {
  success: boolean;
  txHash: string;
  senderAddress: string;
  recipientAddress: string;
  amount: string;
  asset: 'usdc' | 'near';
  network: 'near';
  blockHash?: string;
  error?: string;
  rawResult?: any;
}

interface NearRpcResponse<T = any> {
  jsonrpc: string;
  id: string;
  result?: T;
  error?: {
    name?: string;
    cause?: {
      name?: string;
      info?: any;
    };
    message?: string;
    data?: any;
  };
}

/**
 * Queries an access key nonce for a public key on an account.
 */
export async function fetchAccessKeyNonce(
  rpcUrl: string,
  accountId: string,
  publicKeyStr: string
): Promise<{ nonce: bigint; blockHash: string } | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `sivan_nonce_${Date.now()}`,
        method: 'query',
        params: {
          request_type: 'view_access_key',
          finality: 'final',
          account_id: accountId,
          public_key: publicKeyStr,
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return null;
    const data = (await res.json()) as NearRpcResponse<{ nonce: number; block_hash: string }>;
    if (data.error || !data.result) return null;

    return {
      nonce: BigInt(data.result.nonce),
      blockHash: data.result.block_hash,
    };
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

/**
 * Fetches the latest final block hash from NEAR RPC.
 */
export async function fetchRecentBlockHash(rpcUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `sivan_block_${Date.now()}`,
        method: 'block',
        params: { finality: 'final' },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return null;
    const data = (await res.json()) as NearRpcResponse<{ header: { hash: string } }>;
    if (data.error || !data.result?.header?.hash) return null;

    return data.result.header.hash;
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

/**
 * Broadcasts a signed NEAR transaction via broadcast_tx_commit.
 */
export async function broadcastSignedTransaction(
  rpcUrl: string,
  signedTx: SignedTransaction
): Promise<{ success: boolean; txHash: string; blockHash?: string; raw?: any; error?: string }> {
  const serialized = signedTx.encode();
  const base64Tx = Buffer.from(serialized).toString('base64');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `sivan_bcast_${Date.now()}`,
        method: 'broadcast_tx_commit',
        params: [base64Tx],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const body = (await res.json()) as NearRpcResponse<any>;

    if (body.error) {
      const msg = body.error.message || body.error.data || JSON.stringify(body.error);
      return { success: false, txHash: '', error: msg, raw: body };
    }

    const txOutcome = body.result?.transaction_outcome;
    const txHash = body.result?.transaction?.hash || txOutcome?.id || '';
    const blockHash = txOutcome?.block_hash;

    // Check if the transaction execution failed inside the VM
    const status = body.result?.status;
    if (status?.Failure) {
      const failureReason = JSON.stringify(status.Failure);
      return { success: false, txHash, blockHash, error: failureReason, raw: body.result };
    }

    return { success: true, txHash, blockHash, raw: body.result };
  } catch (err: any) {
    clearTimeout(timeoutId);
    return { success: false, txHash: '', error: err?.message || String(err) };
  }
}

/**
 * Builds, signs, and executes an on-chain transfer on NEAR Protocol.
 * Supports both native NEAR and NEP-141 USDC.
 */
export async function executeNearOnchainTransfer(
  input: NearTransferInput
): Promise<NearTransferResult> {
  const asset = input.asset || 'usdc';
  const production = Boolean(input.production);
  const rpcUrl = getNearRpcUrl(production);

  // 1. Resolve sender credentials (Transit Vault vs User Wallet)
  let senderAccountId: string;
  let nearKp: KeyPairEd25519;

  if (input.useVault) {
    const vaultConfig = getNearVaultConfig(production);
    senderAccountId = vaultConfig.accountId;
    nearKp = new KeyPairEd25519(vaultConfig.privateKey.replace('ed25519:', ''));
  } else if (input.senderPrivateKey) {
    nearKp = new KeyPairEd25519(input.senderPrivateKey.replace('ed25519:', ''));
    senderAccountId =
      input.senderAccountId ||
      Buffer.from(nearKp.getPublicKey().data).toString('hex').toLowerCase();
  } else {
    const seed = input.senderSeed || `sivan_near_${input.senderUserId}`;
    const kp = generateNearKeypair(seed);
    nearKp = new KeyPairEd25519(kp.secretKey.replace('ed25519:', ''));
    senderAccountId = input.senderAccountId || kp.accountId;
  }

  const senderPublicKeyStr = nearKp.getPublicKey().toString();

  // 2. Fetch current nonce and recent block hash
  let accessKey = await fetchAccessKeyNonce(rpcUrl, senderAccountId, senderPublicKeyStr);
  let recentBlockHashStr: string | null = accessKey?.blockHash ?? null;

  // Ensure sender account is activated with native gas and recipient has NEP-141 storage registered
  if (asset === 'usdc') {
    const { ensureNearAccountAndStorage } = await import('./near-activation.js');
    const { isNearStorageRegistered, fetchNearNativeBalance, fetchNearTokenBalance, NEAR_CIRCLE_USDC_TESTNET, NEAR_FAKES_USDC_TESTNET } = await import('./near-rpc.js');

    // Ensure sender has sufficient native gas for prepaid 30 TGas reservation
    if (!input.useVault) {
      const senderNativeBal = await fetchNearNativeBalance(senderAccountId, production).catch(() => '0.000000');
      if (!accessKey || parseFloat(senderNativeBal) < 0.04) {
        await ensureNearAccountAndStorage(input.senderUserId, senderAccountId, { production }).catch(() => {});
        accessKey = await fetchAccessKeyNonce(rpcUrl, senderAccountId, senderPublicKeyStr);
        recentBlockHashStr = accessKey?.blockHash ?? null;
      }
    }

    let usdcContract = getNearUsdcContract(production);
    if (!production) {
      const [circleBal, fakesBal] = await Promise.all([
        fetchNearTokenBalance(senderAccountId, NEAR_CIRCLE_USDC_TESTNET, 6, false).catch(() => '0.000000'),
        fetchNearTokenBalance(senderAccountId, NEAR_FAKES_USDC_TESTNET, 6, false).catch(() => '0.000000'),
      ]);
      if (parseFloat(circleBal) >= parseFloat(input.amount)) {
        usdcContract = NEAR_CIRCLE_USDC_TESTNET;
      } else if (parseFloat(fakesBal) >= parseFloat(input.amount)) {
        usdcContract = NEAR_FAKES_USDC_TESTNET;
      }
    }

    const recipientRegistered = await isNearStorageRegistered(input.recipientAddress, usdcContract, production).catch(() => true);
    if (!recipientRegistered) {
      await ensureNearAccountAndStorage(input.recipientAddress, input.recipientAddress, { production }).catch(() => {});
      if (input.useVault) {
        // Re-fetch nonce in case vault just signed a storage_deposit tx
        accessKey = await fetchAccessKeyNonce(rpcUrl, senderAccountId, senderPublicKeyStr);
        recentBlockHashStr = accessKey?.blockHash ?? null;
      }
    }
  }

  if (!recentBlockHashStr) {
    recentBlockHashStr = await fetchRecentBlockHash(rpcUrl);
  }

  // Fallback nonce and default genesis hash for isolated offline/sandboxed test execution
  const currentNonce = accessKey ? accessKey.nonce : 1n;
  const nextNonce = currentNonce + 1n;
  const safeBlockHashStr = recentBlockHashStr || 'HqvnUa4uvRVSio8tpSMsiZToAsMjdQaG5NM8hsqfsXdw';
  const recentBlockHashBytes = baseDecode(safeBlockHashStr);

  // 3. Build action according to asset type
  let receiverId: string;
  let action: any;

  if (asset === 'near') {
    receiverId = input.recipientAddress;
    // Native NEAR uses yoctoNEAR (10^24)
    const floatAmount = parseFloat(input.amount);
    const whole = Math.floor(floatAmount);
    const fraction = (floatAmount - whole).toFixed(6).slice(2);
    const yoctoStr = `${whole}${fraction}`.padEnd(whole.toString().length + 24, '0');
    action = actions.transfer(BigInt(yoctoStr));
  } else {
    // NEP-141 USDC: function call to ft_transfer on USDC contract
    let contractToUse = getNearUsdcContract(production);
    if (!production) {
      const { fetchNearTokenBalance, NEAR_CIRCLE_USDC_TESTNET, NEAR_FAKES_USDC_TESTNET } = await import('./near-rpc.js');
      const [circleBal, fakesBal] = await Promise.all([
        fetchNearTokenBalance(senderAccountId, NEAR_CIRCLE_USDC_TESTNET, 6, false).catch(() => '0.000000'),
        fetchNearTokenBalance(senderAccountId, NEAR_FAKES_USDC_TESTNET, 6, false).catch(() => '0.000000'),
      ]);
      if (parseFloat(circleBal) >= parseFloat(input.amount)) {
        contractToUse = NEAR_CIRCLE_USDC_TESTNET;
      } else if (parseFloat(fakesBal) >= parseFloat(input.amount)) {
        contractToUse = NEAR_FAKES_USDC_TESTNET;
      }
    }
    receiverId = contractToUse;
    // 6 decimals
    const usdcAtomic = BigInt(Math.round(parseFloat(input.amount) * 1_000_000)).toString();
    action = actions.functionCall(
      'ft_transfer',
      {
        receiver_id: input.recipientAddress,
        amount: usdcAtomic,
        memo: 'Sivan Ai Transfer',
      },
      30_000_000_000_000n, // 30 TGas
      1n // 1 yoctoNEAR deposit required by NEP-141 security standard
    );
  }

  // 4. Create and sign the transaction
  const tx = createTransaction(
    senderAccountId,
    nearKp.getPublicKey(),
    receiverId,
    nextNonce,
    [action],
    recentBlockHashBytes
  );

  const serializedTx = encodeTransaction(tx);
  const txHashBytes = crypto.createHash('sha256').update(serializedTx).digest();
  const sig = nearKp.sign(txHashBytes);

  const signedTx = new SignedTransaction({
    transaction: tx,
    signature: new Signature({
      keyType: tx.publicKey.keyType,
      data: sig.signature,
    }),
  });
  const computedTxHash = baseEncode(txHashBytes);

  // 5. Broadcast to NEAR RPC
  const broadcastRes = await broadcastSignedTransaction(rpcUrl, signedTx);

  const finalTxHash = broadcastRes.success
    ? (broadcastRes.txHash || computedTxHash)
    : (broadcastRes.txHash || '');

  return {
    success: broadcastRes.success,
    txHash: finalTxHash,
    senderAddress: senderAccountId,
    recipientAddress: input.recipientAddress,
    amount: input.amount,
    asset,
    network: 'near',
    blockHash: broadcastRes.blockHash || (broadcastRes.success ? safeBlockHashStr : undefined),
    error: broadcastRes.error,
    rawResult: broadcastRes.raw,
  };
}
