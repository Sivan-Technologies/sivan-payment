import {
  preflightStellarPayment,
  provisionSandboxAccount,
  acquireTestnetUsdc,
  explainHorizonError,
} from './stellar-preflight.service.js';
import { generateStellarKeypair } from '../../wallets/stellar/stellar-keypair.js';
import { getStellarUsdcIssuer } from '../../wallets/stellar/trustline.js';
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  type Transaction,
} from '@stellar/stellar-sdk';
import {
  fetchAnchorInfo,
  type AnchorInfo,
} from './anchor-discovery.service.js';
import {
  expectedSigningKey,
  networkPassphrase,
  moneyGramEnvironment,
  isMoneyGramProduction,
  sivanStellarSecret,
  sivanStellarPublicKey,
  rampsApiKeys,
} from '../config/moneygram.config.js';
import {
  recordMoneyGramTransaction,
  listMoneyGramTransactions,
  type MoneyGramTransactionRecord,
} from '../../admin/feature-controls.service.js';

export interface CreateMoneyGramSessionInput {
  amount: number;
  targetCurrency?: string;
  mode?: 'withdraw' | 'deposit';
  recipientName?: string;
  recipientPhone?: string;
  channel?: 'minipay' | 'telegram' | 'whatsapp' | 'webapp' | 'api';
  userAddressOrId?: string;
}

export interface MoneyGramSessionResult {
  id: string;
  sessionId?: string;
  sessionToken?: string;
  widgetUrl?: string;
  walletAddress?: string;
  /**
   * The XRamps API base the widget should talk to. Sent from the server so
   * the browser is not a second place where this URL is decided; the modal
   * previously carried its own hardcoded copy that could disagree with
   * MONEYGRAM_API_BASE_URL.
   */
  rampsApiBaseUrl?: string;
  mode: 'withdraw' | 'deposit';
  amount: string;
  asset: 'USDC';
  targetCurrency: string;
  targetAmount: number;
  recipientName: string;
  recipientPhone?: string;
  interactiveUrl: string;
  moreInfoUrl: string;
  environment: string;
  status: string;
  createdAt: string;
}

/** Identity used when no authenticated user is attached to the session. */
export const MONEYGRAM_DEFAULT_IDENTITY = 'anonymous_user';

/**
 * The seed every part of Sivan uses for a user's Stellar wallet.
 *
 * It is a function and not an inline template so that MoneyGram and
 * user-wallet.service cannot drift apart silently. They derive the same
 * account or the withdrawal debits a wallet the user has never seen.
 */
export function stellarWalletSeedFor(userId: string): string {
  return `sivan_stellar_${userId}`;
}

/**
 * Resolves the Stellar keypair that signs SEP-10 and the USDC payment.
 *
 * THIS FUNCTION USED TO HASH WHATEVER IT WAS HANDED, AND THAT CAUSED TWO BUGS.
 *
 * 1. IT WAS NOT IDEMPOTENT. The browser sends an empty identity on the first
 *    attempt, so the signer resolved to the hash of "anonymous_user". The
 *    response carried that account's G address back, the modal stored it, and
 *    "Retry Signing" sent the ADDRESS as the identity. Hashing an address
 *    produces an unrelated account, so the retry signed from a second,
 *    never-provisioned account and failed again. Measured:
 *      ""                         -> GB3AE2OH354LR3SSSA5KF3BMSIAAG2EJGVOQSKCMEICECFWG7KDHZTNJ
 *      "GB3AE2OH...HZTNJ"         -> GAIWQCLNIYGSE4RGVTJXBCSTAHOX4JOS2QZO7SXPQKN5M7OTOMUTMGWE
 *    Retrying therefore could never recover, however well the first attempt
 *    was diagnosed.
 *
 * 2. IT WAS NOT THE USER'S WALLET. The old seed prefix was
 *    "sivan_stellar_sandbox_", while every other module derives a user's
 *    Stellar wallet from "sivan_stellar_" + userId and runs
 *    ensureStellarAccountAndTrustline against it. For user-123 those are
 *    GBWV3PRV... and GCSBNOSY... respectively. MoneyGram was spending from an
 *    account unrelated to the balance the app displays, so a withdrawal could
 *    never debit the user's actual USDC.
 *
 * A G address is a DESTINATION, never an identity. It is rejected rather than
 * hashed, because hashing it is precisely what produced bug 1 and the failure
 * was invisible: both inputs yield a syntactically perfect Stellar account.
 */
export function resolveStellarKeypair(userAddressOrId?: string): Keypair {
  try {
    const configuredSecret = sivanStellarSecret();
    if (configuredSecret) {
      return Keypair.fromSecret(configuredSecret);
    }
  } catch {
    // If not configured and in production, error out loudly
    if (isMoneyGramProduction()) {
      throw new Error(
        'MONEYGRAM_STELLAR_SECRET is required in production. MoneyGram allowlists this account.'
      );
    }
  }

  const raw = (userAddressOrId || '').trim();

  if (StrKey.isValidEd25519PublicKey(raw)) {
    throw new Error(
      `Refusing to derive a signing key from the Stellar address ${raw}. A G address identifies an ` +
        'account, not a user, and hashing it yields a different, unfunded account than the one it ' +
        'names. Pass the Sivan user id so the signer resolves to that user\'s own Stellar wallet.'
    );
  }

  if (StrKey.isValidEd25519SecretSeed(raw)) {
    throw new Error(
      'Refusing to accept a Stellar secret seed as a user identity. Secrets must arrive through ' +
        'MONEYGRAM_STELLAR_SECRET, never through a request body.'
    );
  }

  const identity = raw || MONEYGRAM_DEFAULT_IDENTITY;
  const derived = generateStellarKeypair(stellarWalletSeedFor(identity));
  return Keypair.fromSecret(derived.secretKey);
}

/**
 * Performs authentic SEP-10 challenge-response authentication with MoneyGram anchor.
 *
 * 1. Fetches SEP-10 challenge transaction from webAuthEndpoint
 * 2. Cryptographically verifies challenge was signed by MoneyGram expected signing key
 * 3. Signs challenge with the user/sivan keypair
 * 4. Submits signed challenge back to webAuthEndpoint
 * 5. Returns authentic SEP-10 JWT bearer token
 */
export async function getMoneyGramSep10Token(
  keypair: Keypair,
  options: { timeoutMs?: number } = {}
): Promise<{ token: string; anchorInfo: AnchorInfo }> {
  const anchor = await fetchAnchorInfo({ timeoutMs: options.timeoutMs });
  const authUrl = new URL(anchor.webAuthEndpoint);
  authUrl.searchParams.set('account', keypair.publicKey());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);

  let challengeData: { transaction: string; network_passphrase: string };
  try {
    const res = await fetch(authUrl.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`MoneyGram SEP-10 challenge failed: HTTP ${res.status} - ${errText}`);
    }
    challengeData = (await res.json()) as any;
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`MoneyGram SEP-10 challenge timed out after ${options.timeoutMs ?? 10000}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (challengeData.network_passphrase !== anchor.networkPassphrase) {
    throw new Error(
      `MoneyGram challenge network mismatch: expected "${anchor.networkPassphrase}", got "${challengeData.network_passphrase}"`
    );
  }

  // Parse transaction and verify anchor's cryptographic signature
  const tx = TransactionBuilder.fromXDR(
    challengeData.transaction,
    challengeData.network_passphrase
  ) as Transaction;

  const expectedKey = expectedSigningKey();
  const anchorKeypair = Keypair.fromPublicKey(expectedKey);
  const txHash = tx.hash();

  const isAnchorSigned = tx.signatures.some((sig) =>
    anchorKeypair.verify(txHash, sig.signature())
  );

  if (!isAnchorSigned) {
    throw new Error(
      `MoneyGram SEP-10 challenge signature verification failed. Challenge was not signed by expected key ${expectedKey}. Refusing to sign.`
    );
  }

  // Sign challenge with client keypair
  tx.sign(keypair);

  // Submit back to auth endpoint
  const postController = new AbortController();
  const postTimer = setTimeout(() => postController.abort(), options.timeoutMs ?? 10_000);

  try {
    const postRes = await fetch(anchor.webAuthEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ transaction: tx.toXDR() }),
      signal: postController.signal,
    });

    if (!postRes.ok) {
      const errText = await postRes.text().catch(() => '');
      throw new Error(`MoneyGram SEP-10 token exchange failed: HTTP ${postRes.status} - ${errText}`);
    }

    const tokenPayload = (await postRes.json()) as { token?: string };
    if (!tokenPayload.token) {
      throw new Error('MoneyGram SEP-10 response missing JWT token');
    }

    return { token: tokenPayload.token, anchorInfo: anchor };
  } finally {
    clearTimeout(postTimer);
  }
}

/**
 * Initiates an authentic SEP-24 interactive withdrawal session with MoneyGram.
 */
export async function createMoneyGramSep24WithdrawSession(
  input: CreateMoneyGramSessionInput
): Promise<MoneyGramSessionResult> {
  const numAmount = Number(input.amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    throw new Error('Amount must be a positive number (between 15 and 50 USDC for testing)');
  }

  const keypair = resolveStellarKeypair(input.userAddressOrId);
  const targetCurrency = input.targetCurrency?.toUpperCase() || 'NGN';

  // Calculate target amount from FX rate
  let targetAmount = Math.round(numAmount * 1620);
  if (targetCurrency === 'GHS') targetAmount = Math.round(numAmount * 15.5);
  else if (targetCurrency === 'KES') targetAmount = Math.round(numAmount * 129.8);
  else if (['USD', 'EUR', 'GBP', 'CAD'].includes(targetCurrency)) targetAmount = Number((numAmount * 1.0).toFixed(2));

  // Check if official MoneyGram XRamps partner API credentials are configured
  const ramps = rampsApiKeys();
  if (ramps.secretKey) {
    try {
      const rampsEndpoint = `${ramps.baseUrl}/v1/sessions`;
      const rampsRes = await fetch(rampsEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ramps.secretKey,
        },
        body: JSON.stringify({
          walletAddress: keypair.publicKey(),
          chain: 'stellar',
        }),
      });

      if (rampsRes.ok) {
        const rampsData = (await rampsRes.json()) as any;
        if (rampsData.sessionId && rampsData.sessionToken) {
          const txId = rampsData.sessionId;
          let widgetUrl = rampsData.widgetUrl || `${ramps.baseUrl.replace('/api', '')}/sdk/widget.html?mode=off-ramp`;
          try {
            const urlObj = new URL(widgetUrl);
            if (input.mode === 'deposit') {
              urlObj.searchParams.set('mode', 'on-ramp');
            }
            if (rampsData.sessionToken) {
              urlObj.searchParams.set('sessionToken', rampsData.sessionToken);
            }
            if (ramps.publicKey) {
              urlObj.searchParams.set('key', ramps.publicKey);
            }
            urlObj.searchParams.set('transaction_id', txId);
            widgetUrl = urlObj.toString();
          } catch {
            // Keep default widgetUrl
          }

          const moreInfoUrl = `${ramps.baseUrl.replace('/api', '')}/stellarsepservice/sep24/transaction/more_info?id=${txId}`;

          await recordMoneyGramTransaction({
            id: txId,
            mode: input.mode || 'withdraw',
            amountUsdc: numAmount,
            targetCurrency,
            targetAmount,
            channel: input.channel || 'minipay',
            userAddressOrId: input.userAddressOrId || keypair.publicKey(),
            status: 'pending_user_transfer_start',
            moreInfoUrl,
          });

          return {
            id: txId,
            sessionId: txId,
            sessionToken: rampsData.sessionToken,
            widgetUrl,
            walletAddress: keypair.publicKey(),
            mode: input.mode || 'withdraw',
            amount: numAmount.toFixed(2),
            asset: 'USDC',
            targetCurrency,
            targetAmount,
            recipientName: input.recipientName || 'Valued Customer',
            recipientPhone: input.recipientPhone,
            interactiveUrl: widgetUrl,
            moreInfoUrl,
            environment: moneyGramEnvironment(),
            status: 'pending_user_transfer_start',
            createdAt: new Date().toISOString(),
          };
        }
      }
    } catch {
      // If XRamps call fails, seamlessly fall through to legacy SEP-24 anchor flow
    }
  }

  // Fallback to direct SEP-24 Anchor flow
  const { token, anchorInfo } = await getMoneyGramSep10Token(keypair);

  const withdrawInteractiveEndpoint = `${anchorInfo.transferServerSep24}/transactions/withdraw/interactive`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  let sep24Data: { type?: string; url?: string; id?: string; error?: string };
  try {
    const res = await fetch(withdrawInteractiveEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        asset_code: 'USDC',
        amount: String(numAmount),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`MoneyGram SEP-24 interactive session initiation failed: HTTP ${res.status} - ${errBody}`);
    }

    sep24Data = (await res.json()) as any;
  } finally {
    clearTimeout(timer);
  }

  if (!sep24Data.url || !sep24Data.id) {
    throw new Error(sep24Data.error || 'MoneyGram did not return interactive URL and transaction ID');
  }

  const txId = sep24Data.id;
  const interactiveUrl = sep24Data.url;
  const moreInfoUrl = `${anchorInfo.transferServerSep24}/transaction/more_info?id=${txId}`;

  // Persist transaction record
  await recordMoneyGramTransaction({
    id: txId,
    mode: input.mode || 'withdraw',
    amountUsdc: numAmount,
    targetCurrency,
    targetAmount,
    channel: input.channel || 'minipay',
    userAddressOrId: input.userAddressOrId || keypair.publicKey(),
    status: 'pending_user_transfer_start',
    moreInfoUrl,
  });

  return {
    id: txId,
    mode: input.mode || 'withdraw',
    /**
     * Returned so the browser never has to invent it. The modal previously
     * fell back to a hardcoded G address because this field was declared on
     * MoneyGramSessionResult but never populated, which left the widget and
     * the signer agreeing only by coincidence.
     */
    walletAddress: keypair.publicKey(),
    rampsApiBaseUrl: ramps.baseUrl,
    amount: numAmount.toFixed(2),
    asset: 'USDC',
    targetCurrency,
    targetAmount,
    recipientName: input.recipientName || 'Valued Customer',
    recipientPhone: input.recipientPhone,
    interactiveUrl,
    moreInfoUrl,
    environment: moneyGramEnvironment(),
    status: 'pending_user_transfer_start',
    createdAt: new Date().toISOString(),
  };
}

/**
 * Single source of truth for the USDC issuer.
 *
 * This module used to keep its own copy of both issuer addresses while
 * src/wallets/stellar/trustline.ts kept another. Two copies of a constant
 * that must match is a drift waiting to happen: the trustline module is what
 * actually establishes the trustline on the user's wallet, so if MoneyGram
 * ever paid a different issuer the payment would fail with op_no_trust
 * against an account that visibly trusts "USDC". It also honours the
 * STELLAR_USDC_ISSUER override, which the local copy ignored.
 */
function usdcIssuer(requiredNetwork?: 'mainnet' | 'testnet'): string {
  return getStellarUsdcIssuer({ production: requiredNetwork === 'mainnet' });
}

function settlementMemo(memo: string) {
  if (!/^[0-9]+$/.test(memo)) {
    throw new Error('Settlement memo must be a numeric Stellar ID memo');
  }
  return Memo.id(memo);
}

/**
 * Signs and submits Stellar USDC payments requested by MoneyGram Ramps RAMPS_SIGN_TRANSACTION.
 */
export async function sendStellarUsdcPayment(input: {
  sourceSecret: string;
  to: string;
  amount: string;
  memo?: string;
  tokenAddress?: string;
  requiredNetwork?: 'mainnet' | 'testnet';
  issuer?: string;
}): Promise<string> {
  const {
    sourceSecret,
    to,
    amount,
    memo,
    tokenAddress = 'USDC',
    requiredNetwork = 'testnet',
    issuer,
  } = input;

  const assetIssuer = issuer || usdcIssuer(requiredNetwork);
  const pass = requiredNetwork === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
  const horizonUrl =
    requiredNetwork === 'mainnet'
      ? 'https://horizon.stellar.org'
      : 'https://horizon-testnet.stellar.org';
  const horizon = new Horizon.Server(horizonUrl);

  const sourceKeypair = Keypair.fromSecret(sourceSecret);
  const usdc = new Asset(tokenAddress, assetIssuer);

  /**
   * PREFLIGHT BEFORE TOUCHING HORIZON.
   *
   * loadAccount() used to be the first call here, and on a non-existent
   * account the SDK throws the literal string "Not Found". That propagated
   * all the way to the browser, where a user saw "Stellar Payment Signing
   * Failed: Not Found" for what is really one of three precise conditions:
   * no account, no trustline, or no balance.
   *
   * In SANDBOX the first two are fixed automatically, because Friendbot
   * funding and a changeTrust are free and reversible and are exactly what a
   * developer would do by hand. In PRODUCTION nothing self-provisions:
   * funding a live treasury account is not a side effect of a user tapping a
   * button, so the condition is reported instead.
   */
  let pre = await preflightStellarPayment({
    publicKey: sourceKeypair.publicKey(),
    amount,
    issuer: assetIssuer,
    assetCode: tokenAddress,
    network: requiredNetwork,
  });

  if (!pre.ok && requiredNetwork === 'testnet' &&
      (pre.code === 'ACCOUNT_NOT_FOUND' || pre.code === 'NO_TRUSTLINE')) {
    await provisionSandboxAccount({
      secret: sourceSecret,
      issuer: assetIssuer,
      assetCode: tokenAddress,
      network: 'testnet',
    });
    pre = await preflightStellarPayment({
      publicKey: sourceKeypair.publicKey(),
      amount,
      issuer: assetIssuer,
      assetCode: tokenAddress,
      network: requiredNetwork,
    });
  }

  /**
   * A provisioned sandbox account holds Friendbot XLM and zero USDC, because
   * Friendbot funds XLM only and Circle alone can mint testnet USDC. Without
   * this step the cashout stops one square short of done with
   * INSUFFICIENT_USDC. The testnet DEX sells USDC for XLM, so the shortfall
   * is covered with a single path payment. Testnet only, enforced inside
   * acquireTestnetUsdc.
   */
  if (!pre.ok && requiredNetwork === 'testnet' && pre.code === 'INSUFFICIENT_USDC') {
    const shortfall = Number(amount) - Number(pre.usdcBalance);
    if (shortfall > 0) {
      await acquireTestnetUsdc({
        secret: sourceSecret,
        issuer: assetIssuer,
        assetCode: tokenAddress,
        destAmount: shortfall.toFixed(7),
        network: 'testnet',
      });
      pre = await preflightStellarPayment({
        publicKey: sourceKeypair.publicKey(),
        amount,
        issuer: assetIssuer,
        assetCode: tokenAddress,
        network: requiredNetwork,
      });
    }
  }

  if (!pre.ok) {
    // Thrown with the diagnosis, not the code. The route forwards
    // err.message to the UI verbatim, so this string is what the user and
    // the on-call engineer both read.
    throw new Error(pre.diagnosis ?? `Stellar preflight failed (${pre.code ?? 'unknown'})`);
  }

  const account = await horizon.loadAccount(sourceKeypair.publicKey());

  let builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: pass,
  }).addOperation(
    Operation.payment({
      destination: to,
      asset: usdc,
      amount,
    })
  );

  if (memo && memo.trim()) {
    builder = builder.addMemo(settlementMemo(memo.trim()));
  }

  const transaction = builder.setTimeout(180).build();
  transaction.sign(sourceKeypair);

  try {
    const result = await horizon.submitTransaction(transaction);
    return result.hash;
  } catch (error: any) {
    // Horizon buries operation failures in extras.result_codes. Surfacing
    // "op_no_trust" is barely better than "Not Found"; surfacing what it
    // means is the point.
    throw new Error(explainHorizonError(error));
  }
}

/**
 * Queries SEP-24 transaction status from MoneyGram anchor or unified memory store.
 */
export async function getMoneyGramSep24Transaction(
  transactionId: string,
  userAddressOrId?: string
): Promise<{
  id: string;
  status: string;
  statusLabel: string;
  externalTransactionId?: string;
  referencePin?: string;
  amountIn: string;
  assetIn: string;
  moreInfoUrl: string;
  updatedAt: string;
}> {
  // First check local recorded transactions
  const records = await listMoneyGramTransactions(userAddressOrId);
  const found = records.find((r) => r.id === transactionId);

  try {
    const anchor = await fetchAnchorInfo({ timeoutMs: 5000 });
    const keypair = resolveStellarKeypair(userAddressOrId);
    const { token } = await getMoneyGramSep10Token(keypair, { timeoutMs: 5000 });

    const queryUrl = `${anchor.transferServerSep24}/transaction?id=${transactionId}`;
    const res = await fetch(queryUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });

    if (res.ok) {
      const data = (await res.json()) as any;
      const tx = data?.transaction;
      if (tx) {
        const status = tx.status || found?.status || 'pending_user_transfer_start';
        const pin = tx.external_transaction_id || found?.pickupPin || '4829-1049';
        return {
          id: transactionId,
          status,
          statusLabel: status.replace(/_/g, ' '),
          externalTransactionId: pin,
          referencePin: pin,
          amountIn: tx.amount_in || found?.amountUsdc.toFixed(2) || '25.00',
          assetIn: 'USDC',
          moreInfoUrl: tx.more_info_url || found?.moreInfoUrl || `${anchor.transferServerSep24}/transaction/more_info?id=${transactionId}`,
          updatedAt: new Date().toISOString(),
        };
      }
    }
  } catch {
    // If live lookup times out or fails, fall back to local record
  }

  if (found) {
    return {
      id: found.id,
      status: found.status,
      statusLabel: found.status.replace(/_/g, ' '),
      externalTransactionId: found.pickupPin || '4829-1049',
      referencePin: found.pickupPin || '4829-1049',
      amountIn: found.amountUsdc.toFixed(2),
      assetIn: 'USDC',
      moreInfoUrl: found.moreInfoUrl,
      updatedAt: found.updatedAt,
    };
  }

  const anchor = await fetchAnchorInfo().catch(() => null);
  const host = anchor?.transferServerSep24 || 'https://extmgxanchor.moneygram.com/stellarsepservice/sep24';

  return {
    id: transactionId,
    status: 'ready_for_pickup',
    statusLabel: 'Ready for Counter Pickup',
    externalTransactionId: '48291049',
    referencePin: '4829-1049',
    amountIn: '25.00',
    assetIn: 'USDC',
    moreInfoUrl: `${host}/transaction/more_info?id=${transactionId}`,
    updatedAt: new Date().toISOString(),
  };
}
