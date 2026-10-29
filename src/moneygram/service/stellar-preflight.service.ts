/**
 * STELLAR PAYMENT PREFLIGHT AND SANDBOX PROVISIONING.
 *
 * WHY THIS EXISTS: THE "Not Found" BUG.
 *
 * A MoneyGram withdrawal failed in the UI with:
 *
 *   Stellar Payment Signing Failed: Not Found
 *
 * "Not Found" is the literal message the Stellar SDK throws when
 * horizon.loadAccount() gets a 404, and sendStellarUsdcPayment() called it
 * as its first action with no guard. The route caught the error and passed
 * err.message straight to the browser, so the user saw two useless words for
 * what is actually a precise, fixable condition.
 *
 * Reproduced directly against Horizon. In sandbox the signing keypair is
 * DERIVED from a hash of the user identifier, and that account has never
 * existed on testnet:
 *
 *   sha256("sivan_stellar_sandbox_anonymous_user")
 *     -> GB3AE2OH354LR3SSSA5KF3BMSIAAG2EJGVOQSKCMEICECFWG7KDHZTNJ
 *     -> horizon-testnet /accounts/... => 404 Resource Missing
 *
 * THREE PRECONDITIONS, EACH WITH ITS OWN OPAQUE FAILURE
 *
 *   1. account does not exist      -> "Not Found"
 *   2. no USDC trustline           -> "op_no_trust"
 *   3. insufficient USDC           -> "op_underfunded"
 *
 * All three are diagnosable BEFORE submitting, and all three have a specific
 * remedy. This module checks them up front and returns a diagnosis a human
 * can act on, instead of letting Horizon produce a code the user cannot.
 *
 * In SANDBOX it goes further and fixes the first two automatically: funding
 * via Friendbot and establishing the trustline are both free, reversible and
 * exactly what a developer would do by hand. In PRODUCTION it never
 * self-provisions; it reports precisely what is missing, because funding a
 * live account is a treasury action and not a side effect of a user tapping
 * a button.
 */

import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

export type StellarNetwork = 'mainnet' | 'testnet';

export function horizonUrlFor(network: StellarNetwork): string {
  const override = (
    network === 'mainnet'
      ? process.env.STELLAR_HORIZON_URL
      : process.env.STELLAR_HORIZON_TESTNET_URL
  )?.trim();
  if (override) return override.replace(/\/+$/, '');
  return network === 'mainnet'
    ? 'https://horizon.stellar.org'
    : 'https://horizon-testnet.stellar.org';
}

export function friendbotUrl(): string {
  return (process.env.STELLAR_FRIENDBOT_URL || 'https://friendbot.stellar.org').replace(/\/+$/, '');
}

export interface PreflightResult {
  ok: boolean;
  accountExists: boolean;
  hasTrustline: boolean;
  usdcBalance: string;
  xlmBalance: string;
  /** Present when ok is false. Written for a human, naming the remedy. */
  diagnosis?: string;
  /** Short machine code for logs and metrics. */
  code?:
    | 'ACCOUNT_NOT_FOUND'
    | 'NO_TRUSTLINE'
    | 'INSUFFICIENT_USDC'
    | 'INSUFFICIENT_XLM_RESERVE'
    | 'HORIZON_UNREACHABLE';
}

/**
 * Inspect the source account against everything a USDC payment requires.
 *
 * Never throws for an expected condition. A missing account is an answer,
 * not an exception, and treating it as one is what lets the caller produce a
 * useful message.
 */
export async function preflightStellarPayment(input: {
  publicKey: string;
  amount: string;
  issuer: string;
  assetCode?: string;
  network: StellarNetwork;
  timeoutMs?: number;
}): Promise<PreflightResult> {
  const { publicKey, amount, issuer, network } = input;
  const assetCode = input.assetCode || 'USDC';
  const base = horizonUrlFor(network);

  const empty = { accountExists: false, hasTrustline: false, usdcBalance: '0', xlmBalance: '0' };

  let account: any;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000);
    let res: Response;
    try {
      res = await fetch(`${base}/accounts/${publicKey}`, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 404) {
      return {
        ok: false,
        ...empty,
        code: 'ACCOUNT_NOT_FOUND',
        diagnosis:
          `Stellar account ${publicKey} does not exist on ${network}. ` +
          (network === 'testnet'
            ? 'Fund it from Friendbot to create it. Sivan does this automatically in sandbox: ' +
              'if you are seeing this, automatic provisioning is disabled or Friendbot is unreachable.'
            : 'It must be created and funded with XLM before it can send a payment. This is a treasury ' +
              'action and is deliberately never performed automatically.'),
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        ...empty,
        code: 'HORIZON_UNREACHABLE',
        diagnosis: `Horizon at ${base} returned HTTP ${res.status} for account ${publicKey}.`,
      };
    }
    account = await res.json();
  } catch (error: any) {
    return {
      ok: false,
      ...empty,
      code: 'HORIZON_UNREACHABLE',
      diagnosis: `Could not reach Horizon at ${base}: ${String(error?.message ?? error)}`,
    };
  }

  const balances: any[] = account.balances ?? [];
  const native = balances.find((b) => b.asset_type === 'native');
  const usdc = balances.find(
    (b) => b.asset_code === assetCode && b.asset_issuer === issuer
  );

  const xlmBalance = native?.balance ?? '0';
  const usdcBalance = usdc?.balance ?? '0';

  if (!usdc) {
    return {
      ok: false,
      accountExists: true,
      hasTrustline: false,
      usdcBalance: '0',
      xlmBalance,
      code: 'NO_TRUSTLINE',
      diagnosis:
        `Account ${publicKey} has no ${assetCode} trustline for issuer ${issuer}. ` +
        'A Stellar account cannot hold or send an asset until it explicitly trusts the issuer. ' +
        (network === 'testnet'
          ? 'Sivan establishes this automatically in sandbox.'
          : 'Submit a changeTrust operation from the treasury account.'),
    };
  }

  if (Number(usdcBalance) < Number(amount)) {
    return {
      ok: false,
      accountExists: true,
      hasTrustline: true,
      usdcBalance,
      xlmBalance,
      code: 'INSUFFICIENT_USDC',
      diagnosis:
        `Account ${publicKey} holds ${usdcBalance} ${assetCode} but the withdrawal requires ${amount}. ` +
        'Fund the account with the difference before retrying.',
    };
  }

  /**
   * A funded account still needs XLM for the base reserve and the fee. One
   * XLM is comfortably above both and keeps the check simple; the precise
   * reserve depends on subentry count and is not worth computing to produce
   * a warning.
   */
  if (Number(xlmBalance) < 1) {
    return {
      ok: false,
      accountExists: true,
      hasTrustline: true,
      usdcBalance,
      xlmBalance,
      code: 'INSUFFICIENT_XLM_RESERVE',
      diagnosis:
        `Account ${publicKey} holds only ${xlmBalance} XLM. Stellar requires XLM for the base reserve ` +
        'and the transaction fee, independent of the USDC balance.',
    };
  }

  return { ok: true, accountExists: true, hasTrustline: true, usdcBalance, xlmBalance };
}

/**
 * Create and prepare a sandbox account so a withdrawal can proceed.
 *
 * TESTNET ONLY, and the guard is not a formality: Friendbot does not exist on
 * mainnet, and silently self-funding a live treasury account would be a far
 * worse bug than the one this fixes.
 */
export async function provisionSandboxAccount(input: {
  secret: string;
  issuer: string;
  assetCode?: string;
  network: StellarNetwork;
  timeoutMs?: number;
}): Promise<{ funded: boolean; trustlineCreated: boolean; notes: string[] }> {
  const assetCode = input.assetCode || 'USDC';
  const notes: string[] = [];

  if (input.network !== 'testnet') {
    throw new Error(
      'provisionSandboxAccount refuses to run on mainnet. Friendbot does not exist there, and funding ' +
        'a live account is a treasury action, not an automatic side effect of a withdrawal.'
    );
  }

  const keypair = Keypair.fromSecret(input.secret);
  const publicKey = keypair.publicKey();
  const base = horizonUrlFor('testnet');
  const horizon = new Horizon.Server(base);

  let funded = false;
  let trustlineCreated = false;

  // 1. Create the account if Horizon does not know it.
  const exists = await fetch(`${base}/accounts/${publicKey}`).then((r) => r.ok).catch(() => false);
  if (!exists) {
    const fb = await fetch(`${friendbotUrl()}?addr=${encodeURIComponent(publicKey)}`);
    if (!fb.ok) {
      const body = await fb.text().catch(() => '');
      throw new Error(`Friendbot could not fund ${publicKey}: HTTP ${fb.status} ${body.slice(0, 160)}`);
    }
    funded = true;
    notes.push(`Funded ${publicKey} via Friendbot.`);
  } else {
    notes.push(`Account ${publicKey} already exists.`);
  }

  // 2. Establish the trustline if it is missing.
  const account = await horizon.loadAccount(publicKey);
  const has = account.balances.some(
    (b: any) => b.asset_code === assetCode && b.asset_issuer === input.issuer
  );

  if (!has) {
    const asset = new Asset(assetCode, input.issuer);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.changeTrust({ asset }))
      .setTimeout(60)
      .build();
    tx.sign(keypair);
    await horizon.submitTransaction(tx);
    trustlineCreated = true;
    notes.push(`Created ${assetCode} trustline to ${input.issuer}.`);
  } else {
    notes.push(`${assetCode} trustline already present.`);
  }

  return { funded, trustlineCreated, notes };
}

/**
 * Buy testnet USDC on the Stellar DEX so a sandbox withdrawal can complete.
 *
 * WHY THIS IS NEEDED AT ALL
 *
 * Friendbot funds XLM and nothing else. Circle issues testnet USDC from
 * GBBD47IF..., and nobody but Circle can mint it, so a freshly provisioned
 * sandbox account reaches the withdrawal step holding 10,000 XLM and 0 USDC.
 * The preflight then correctly reports INSUFFICIENT_USDC and the cashout
 * stops one step short of done. The Circle faucet is browser and captcha
 * gated, which makes it useless to a server completing a user's withdrawal.
 *
 * The Stellar testnet DEX carries real standing offers in XLM/USDC, so the
 * network itself provides the missing step: a path payment converts free
 * Friendbot XLM into the USDC the anchor expects. It is one operation, it
 * settles in the same ledger, and it needs no third party.
 *
 * TESTNET ONLY. The guard is load bearing: the identical operation on mainnet
 * would spend real XLM at whatever price the book happens to show, which is a
 * treasury decision and must never be a side effect of a user tapping
 * Withdraw.
 */
export async function acquireTestnetUsdc(input: {
  secret: string;
  issuer: string;
  assetCode?: string;
  /** Exact amount of the asset to end up receiving. */
  destAmount: string;
  network: StellarNetwork;
  /** Fraction of headroom allowed on the XLM side. Default 0.5 (50 percent). */
  slippage?: number;
  timeoutMs?: number;
}): Promise<{ acquired: string; xlmSendMax: string; hash: string; quotedXlm: string }> {
  const assetCode = input.assetCode || 'USDC';

  if (input.network !== 'testnet') {
    throw new Error(
      'acquireTestnetUsdc refuses to run on mainnet. Converting XLM to USDC on the live DEX spends ' +
        'real funds at an unpredictable price, which is a treasury decision and not an automatic ' +
        'step in a user withdrawal.'
    );
  }

  const destAmount = Number(input.destAmount);
  if (!Number.isFinite(destAmount) || destAmount <= 0) {
    throw new Error(`acquireTestnetUsdc needs a positive destAmount, received: ${input.destAmount}`);
  }

  const base = horizonUrlFor('testnet');
  const keypair = Keypair.fromSecret(input.secret);
  const publicKey = keypair.publicKey();

  // Ask Horizon what the book actually costs right now rather than assuming a peg.
  const pathUrl =
    `${base}/paths/strict-receive` +
    `?source_assets=native` +
    `&destination_asset_type=${assetCode.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12'}` +
    `&destination_asset_code=${encodeURIComponent(assetCode)}` +
    `&destination_asset_issuer=${encodeURIComponent(input.issuer)}` +
    `&destination_amount=${destAmount.toFixed(7)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000);
  let quotedXlm: string;
  try {
    const res = await fetch(pathUrl, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Horizon path lookup failed: HTTP ${res.status} at ${base}`);
    }
    const body: any = await res.json();
    const records: any[] = body?._embedded?.records ?? [];
    if (records.length === 0) {
      throw new Error(
        `No testnet DEX liquidity to convert XLM into ${destAmount} ${assetCode} from issuer ` +
          `${input.issuer}. Fund the account with ${assetCode} directly, or set ` +
          'MONEYGRAM_STELLAR_SECRET to an already funded sandbox treasury account.'
      );
    }
    quotedXlm = String(records[0].source_amount);
  } finally {
    clearTimeout(timer);
  }

  const slippage = typeof input.slippage === 'number' ? input.slippage : 0.5;
  const sendMax = (Number(quotedXlm) * (1 + slippage)).toFixed(7);

  const horizon = new Horizon.Server(base);
  const account = await horizon.loadAccount(publicKey);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax,
        destination: publicKey,
        destAsset: new Asset(assetCode, input.issuer),
        destAmount: destAmount.toFixed(7),
        path: [],
      })
    )
    .setTimeout(60)
    .build();
  tx.sign(keypair);

  const submitted: any = await horizon.submitTransaction(tx);
  return {
    acquired: destAmount.toFixed(7),
    xlmSendMax: sendMax,
    quotedXlm,
    hash: submitted.hash,
  };
}

/**
 * Turn a Horizon submission failure into something actionable.
 *
 * Horizon reports operation failures as result codes buried several levels
 * into the response. Surfacing "op_no_trust" to a user is barely better than
 * "Not Found"; surfacing what it means is the point.
 */
export function explainHorizonError(error: any): string {
  const raw = error?.response?.data ?? error?.response ?? {};
  const codes = raw?.extras?.result_codes;
  const opCodes: string[] = codes?.operations ?? [];
  const txCode: string | undefined = codes?.transaction;

  if (opCodes.includes('op_no_trust')) {
    return 'The destination or source account does not trust this asset (op_no_trust). A USDC trustline is required.';
  }
  if (opCodes.includes('op_underfunded')) {
    return 'The source account does not hold enough USDC to cover this payment (op_underfunded).';
  }
  if (opCodes.includes('op_no_destination')) {
    return 'The destination account does not exist on this network (op_no_destination).';
  }
  if (txCode === 'tx_insufficient_balance') {
    return 'The source account cannot cover the transaction fee and base reserve (tx_insufficient_balance).';
  }
  if (txCode === 'tx_bad_auth') {
    return 'The transaction signature did not match the source account (tx_bad_auth).';
  }
  if (txCode === 'tx_too_late') {
    return 'The transaction time bound expired before submission (tx_too_late). Retry.';
  }

  const message = String(error?.message ?? '');
  if (/not found/i.test(message)) {
    return 'The source Stellar account does not exist on this network. It must be created and funded first.';
  }
  return message || 'Unknown Stellar submission error.';
}
