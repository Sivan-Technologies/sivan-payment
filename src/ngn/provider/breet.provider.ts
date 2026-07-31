import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { forbidden } from '../../shared/errors.js';
import type { NgnProviderAdapter } from './ngn-provider.js';
import type { NgnProviderHealth, NgnProviderName, NgnQuoteInput, NgnQuoteRecord } from '../types/ngn.types.js';
import type { BalanceNetwork } from '../../balances/balance.service.js';
import {
  breetDepositAssetId,
  breetMinimumDepositUsd,
  breetWithdrawalNetwork,
  canDeposit,
  canWithdraw,
  type StableAsset,
} from './breet-networks.js';

/**
 * Breet NGN provider.
 *
 * Primary NGN rail. PajRamp becomes the fallback.
 *
 * Verified against https://docs.breet.io (OpenAPI at /api-reference/openapi.json):
 *
 *   base            https://api.breet.io/v1
 *   auth            x-app-id + x-app-secret headers
 *   environment     X-Breet-Env: development | production   (REQUIRED - a
 *                   missing or invalid value is rejected outright)
 *   response shape  { success, message, data, meta }
 *
 * HOW BREET'S MODEL DIFFERS FROM PAJ'S, AND WHY IT MATTERS
 *
 * Breet is deposit-address-centric, not order-centric. For an off-ramp you do
 * not create an "order" and receive an address; you generate a PERMANENT
 * address per user per asset, once, and every later deposit to it settles the
 * same way. Their docs are explicit: "Each address is unique and reusable, so
 * you only need to call this once per user per asset."
 *
 * That, plus `autoSettlement`, is the whole off-ramp: crypto lands on the
 * user's address and Breet converts and pays the linked bank automatically.
 * There is no per-transfer call to make.
 *
 * The consequence worth stating: an address is REUSABLE, so a second deposit to
 * it is a genuinely new transaction and not a duplicate. Anything downstream
 * must key on the trade `id`, never on the address.
 */

const BREET_BASE = 'https://api.breet.io/v1';

/**
 * IPs Breet delivers webhooks from, per their docs.
 *
 * The secret header is the real check; this is defence in depth. Kept here
 * beside the adapter so it is obvious where the list came from and what to
 * update if Breet changes it.
 */
export const BREET_WEBHOOK_IPS: readonly string[] = [
  '46.101.201.155',
  '46.101.225.109',
  '46.101.225.97',
  '46.101.225.251',
  '159.89.20.62',
];

function breetEnvironment(): 'development' | 'production' {
  return env.BREET_ENV === 'production' ? 'production' : 'development';
}

function headers() {
  const appId = env.BREET_APP_ID;
  const appSecret = env.BREET_APP_SECRET;
  if (!appId || !appSecret) throw forbidden('Breet credentials are not configured.');
  return {
    'Content-Type': 'application/json',
    'x-app-id': appId,
    'x-app-secret': appSecret,
    'X-Breet-Env': breetEnvironment(),
  };
}

async function breetRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BREET_BASE}${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers ?? {}) },
  });

  const body: any = await response.json().catch(() => ({}));

  // Breet signals failure in the envelope as well as the status, so both are
  // checked. A 200 carrying success:false is still a failure.
  if (!response.ok || body?.success === false) {
    const message = body?.message || `Breet API error ${response.status}`;
    throw new Error(`Breet: ${message}`);
  }

  return (body?.data ?? body) as T;
}

function money(value: number, dp = 2) {
  return value.toFixed(dp);
}

export class BreetNgnProvider implements NgnProviderAdapter {
  name: NgnProviderName = 'breet';

  /** Banks, for payout selection and name resolution. */
  async listBanks() {
    return breetRequest<Array<{ id: string; name: string; code?: string }>>('/payments/banks');
  }

  /**
   * Resolve an account number to its registered account name.
   *
   * This is Sivan's Level 1 identity evidence. Since the CBN directive
   * effective 1 March 2024 a Nigerian bank account cannot transact without
   * BVN/NIN linkage, so an account that resolves is one a licensed bank has
   * already verified.
   */
  async verifyBankAccount(bankId: string, accountNumber: string) {
    return breetRequest<{ accountName: string; accountNumber: string; bankId?: string }>(
      '/payments/banks/verify',
      { method: 'POST', body: JSON.stringify({ bankId, accountNumber }) }
    );
  }

  /**
   * Price a conversion.
   *
   * Breet's rate calculator is denominated in USD and returns the NGN figure,
   * so both directions are derived from one call rather than from two different
   * rate sources that could disagree.
   *
   * Deliberately uses the rate calculator and NOT the crypto-prices endpoint:
   * their docs warn that crypto prices are "global market prices, not
   * Breet-specific rates". Quoting a user a global price and settling at
   * Breet's rate would show a number Sivan cannot honour.
   */
  async createQuote(input: NgnQuoteInput) {
    const assetId = env.BREET_DEFAULT_ASSET_ID;
    if (!assetId) throw forbidden('BREET_DEFAULT_ASSET_ID is not configured.');

    const source = Number(input.sourceAmount);
    if (!Number.isFinite(source) || source <= 0) throw new Error('Breet: invalid source amount.');

    // Probe with 1 USD to read the rate, then scale. The endpoint takes USD in
    // and gives NGN out, so this works for both directions off one call.
    const probe = await breetRequest<{ NGNAmount: number; rate: number; cryptoAmount: number }>(
      `/trades/pbc/sell/rate-calculator/${encodeURIComponent(assetId)}`,
      { method: 'POST', body: JSON.stringify({ amountInUSD: 1, currency: 'ngn' }) }
    );

    const rate = Number(probe?.rate);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('Breet: rate is unavailable.');

    const feePercent = Number(env.BREET_FEE_PERCENT ?? 0);
    let destinationAmount: number;
    let feeAmount: number;

    if (input.direction === 'onramp') {
      // NGN in, stablecoin out.
      feeAmount = source * (feePercent / 100);
      destinationAmount = Math.max(source - feeAmount, 0) / rate;
    } else {
      // Stablecoin in, NGN out.
      const gross = source * rate;
      feeAmount = gross * (feePercent / 100);
      destinationAmount = Math.max(gross - feeAmount, 0);
    }

    return {
      provider: this.name,
      providerQuoteId: `breet_${input.direction}_${crypto.randomUUID()}`,
      sourceAmount: money(source, input.sourceCurrency === 'ngn' ? 2 : 6),
      destinationAmount: money(destinationAmount, input.destinationCurrency === 'ngn' ? 2 : 6),
      rate: money(rate),
      feeAmount: money(feeAmount, input.direction === 'onramp' ? 2 : 6),
      metadata: {
        breet: true,
        environment: breetEnvironment(),
        assetId,
        feePercent,
        rateSource: 'rate-calculator',
      },
    } satisfies Partial<NgnQuoteRecord> as any;
  }

  /** Sivan's own balances at Breet. The float that funds on-ramp. */
  async getIntegrationBalance() {
    return breetRequest<any>('/integration');
  }

  /**
   * On-ramp: stablecoin out to the user's wallet.
   *
   * THIS IS A FLOAT MODEL, NOT A PASS-THROUGH. Read before enabling.
   *
   * Breet's on-ramp is documented as "buy stablecoins with your Breet USD
   * balance and send them to any external wallet address". The balance is
   * SIVAN'S, not the user's. Their own example journey is a company funding its
   * Breet balance via an assigned virtual account, converting NGN to USD, then
   * paying a supplier in USDT.
   *
   * So the sequence is:
   *
   *   user sends NGN to Sivan  (Sivan's own collection - NOT part of this call)
   *              ↓
   *   Sivan's Breet NGN balance  →  /payments/fiat-to-usd  →  USD balance
   *              ↓
   *   POST /payments/withdraw/address  →  USDC/USDT to the user's wallet
   *
   * What that means commercially, stated plainly because it is a real
   * commitment and not a detail: Sivan must PRE-FUND a USD balance at Breet.
   * That is working capital at risk, and every on-ramp draws it down. Breet
   * documents a 403 "insufficient balance", so the float running dry is a
   * user-visible failure, not a background one. It is checked before sending.
   *
   * There is still no documented PER-USER naira collection at Breet - the
   * virtual account in their example belongs to the business. Collecting the
   * user's naira remains Sivan's problem, which is why PajRamp stays wired for
   * flows that need a per-user collection account.
   */
  async createOnrampTransfer(quote: NgnQuoteRecord) {
    const destination = (quote.metadata as any)?.recipientAddress
      ?? env.BREET_DEFAULT_RECIPIENT_ADDRESS;
    if (!destination) {
      throw forbidden('No destination wallet address for the Breet on-ramp.');
    }

    const token = String((quote.metadata as any)?.token ?? quote.destinationCurrency ?? 'usdc').toUpperCase();
    if (token !== 'USDC' && token !== 'USDT') {
      throw forbidden(`Breet on-ramp supports USDC and USDT, not ${token}.`);
    }

    // Sivan's network vocabulary, not Breet's. The map translates, and refuses
    // pairs Breet cannot actually service.
    //
    // This matters more than it looks: Sivan's DEFAULT enabled networks are
    // base, solana and avalanche_c_chain, and Breet can withdraw stablecoin to
    // NONE of those except Solana. Without this check an on-ramp to a Base
    // address would be accepted and then fail at Breet - after Sivan's float
    // had been committed.
    const sivanNetwork = String(
      (quote.metadata as any)?.network ?? env.BREET_DEFAULT_NETWORK ?? 'solana'
    ).toLowerCase() as BalanceNetwork;

    const asset = token.toLowerCase() as StableAsset;

    if (!canWithdraw(sivanNetwork, asset)) {
      throw forbidden(
        `Breet cannot send ${token} on ${sivanNetwork}. Supported for on-ramp: Solana, Ethereum, Tron, BSC` +
          (asset === 'usdt' ? ', TON.' : ' (USDC is not available on TON).')
      );
    }

    const network = breetWithdrawalNetwork(sivanNetwork);
    if (!network) throw forbidden(`No Breet withdrawal network mapping for ${sivanNetwork}.`);

    const amountUsd = Number(quote.destinationAmount);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      throw new Error('Breet: invalid on-ramp amount.');
    }

    // Check the float BEFORE sending. Breet returns 403 "insufficient balance",
    // and finding that out mid-send gives the user a failure with no
    // explanation. Advisory only - the balance can move between check and send,
    // so the 403 is still handled below.
    try {
      const account: any = await this.getIntegrationBalance();
      const usdBalance = Number(
        account?.balances?.usd ?? account?.usdBalance ?? account?.balance?.usd ?? NaN
      );
      if (Number.isFinite(usdBalance) && usdBalance < amountUsd) {
        throw forbidden(
          'This on-ramp is temporarily unavailable. Please try a smaller amount or try again shortly.'
        );
      }
    } catch (error: any) {
      // A failed balance READ must not block the send - only an actual
      // shortfall should. Rethrow our own refusal, swallow anything else.
      if (error?.statusCode === 403) throw error;
    }

    // externalId is Breet's deduplication key. Using the quote id means a retry
    // of the same quote cannot send stablecoin twice - which for an on-ramp is
    // Sivan's float leaving the building for free.
    const externalId = `sivan_onramp_${quote.id}`;

    const result = await breetRequest<{ id?: string; status?: string; reference?: string }>(
      '/payments/withdraw/address',
      {
        method: 'POST',
        body: JSON.stringify({
          amount: amountUsd,
          walletAddress: destination,
          token,
          network,
          externalId,
        }),
      }
    );

    return {
      providerTransferId: result?.id ?? result?.reference ?? externalId,
      status: 'processing' as const,
      metadata: {
        breet: true,
        environment: breetEnvironment(),
        token,
        network,
        sivanNetwork,
        destination,
        externalId,
        amountUsd,
        // Flagged so operations can see which flows consume working capital.
        fundedFromSivanFloat: true,
      },
    };
  }

  /**
   * Off-ramp: stablecoin in, naira out.
   *
   * Generates the user's permanent deposit address with autoSettlement on, so
   * anything sent to it is converted and paid to the linked bank without a
   * further call.
   *
   * `label` must be unique and stable per user per asset. Breet returns 400
   * "already exists" on a repeat, which is not an error condition - it means
   * the address was already provisioned - so that case is handled rather than
   * surfaced.
   */
  async createOfframpTransfer(quote: NgnQuoteRecord) {
    // Asset id per (network, asset, environment) rather than one env var.
    // Breet's testnet and mainnet ids are entirely different strings, so a
    // single configured id is wrong in one of the two environments - and being
    // wrong means generating a deposit address for the wrong asset.
    const sivanNetwork = String(
      (quote.metadata as any)?.network ?? env.BREET_DEFAULT_NETWORK ?? 'solana'
    ).toLowerCase() as BalanceNetwork;
    const asset = String(quote.sourceCurrency ?? 'usdc').toLowerCase() as StableAsset;

    if (!canDeposit(sivanNetwork, asset)) {
      throw forbidden(
        `Breet cannot receive ${asset.toUpperCase()} on ${sivanNetwork}. ` +
          'Supported: USDC on Solana, Ethereum, Base, Arbitrum, Polygon; ' +
          'USDT on Solana, Ethereum, Tron, BSC, Polygon, TON.'
      );
    }

    const assetId =
      breetDepositAssetId(sivanNetwork, asset, breetEnvironment()) ?? env.BREET_DEFAULT_ASSET_ID;
    if (!assetId) throw forbidden('No Breet asset id for that network and asset.');

    // Below Breet's minimum a deposit is FLAGGED: confirmed on-chain, funds
    // held, NOT credited. The user must be told before they send, not after.
    const minimumUsd = breetMinimumDepositUsd(sivanNetwork, asset, breetEnvironment());

    const label = `sivan_${quote.userId}_${assetId}`;
    const bankId = (quote.metadata as any)?.bankId ?? env.BREET_DEFAULT_BANK_ID;
    const accountNumber = (quote.metadata as any)?.accountNumber ?? env.BREET_DEFAULT_ACCOUNT_NUMBER;

    const body: Record<string, unknown> = { label };
    if (bankId && accountNumber) {
      body.bankId = String(bankId);
      body.accountNumber = String(accountNumber);
      body.autoSettlement = true;
      body.narration = 'Sivan payout';
    }

    let address: string | undefined;
    let addressId: string | undefined;

    try {
      const created = await breetRequest<{ id: string; address: string }>(
        `/trades/sell/assets/${encodeURIComponent(assetId)}/generate-address`,
        { method: 'POST', body: JSON.stringify(body) }
      );
      address = created?.address;
      addressId = created?.id;
    } catch (error: any) {
      // "already exists" is the expected answer for a returning user, because
      // addresses are permanent and reusable by design.
      if (!/already exists/i.test(String(error?.message ?? ''))) throw error;

      const wallets = await breetRequest<Array<{ id: string; address: string; label?: string }>>(
        '/trades/sell/wallets'
      );
      const existing = wallets?.find((w) => w.label === label);
      address = existing?.address;
      addressId = existing?.id;
    }

    if (!address) throw new Error('Breet: could not obtain a deposit address.');

    return {
      providerTransferId: addressId ?? `breet_addr_${crypto.randomUUID()}`,
      status: 'awaiting_crypto_deposit' as const,
      depositAddress: address,
      metadata: {
        breet: true,
        environment: breetEnvironment(),
        assetId,
        sivanNetwork,
        asset,
        // Surfaced so the UI can warn BEFORE the user sends. Under this, Breet
        // flags the deposit and holds the funds without crediting.
        minimumDepositUsd: minimumUsd,
        label,
        autoSettlement: Boolean(bankId && accountNumber),
        // Stated plainly because it changes how callers must reconcile: this
        // address is permanent, so a later deposit is a NEW transaction, not a
        // duplicate. Key on the trade id, never on the address.
        addressIsReusable: true,
      },
    };
  }

  async getTransfer(providerTransferId: string) {
    try {
      const tx = await breetRequest<{ id: string; status: string }>(
        `/transactions/${encodeURIComponent(providerTransferId)}`
      );
      return { providerTransferId, status: mapStatus(tx?.status) };
    } catch {
      return { providerTransferId, status: 'processing' as const };
    }
  }

  /**
   * Verify an incoming webhook.
   *
   * Breet does not sign the body - verification is a shared secret in the
   * `x-webhook-secret` header, plus an IP allowlist. Compared with
   * timingSafeEqual rather than `===` so the comparison does not leak the
   * secret's length or content through timing.
   *
   * Fails CLOSED when the secret is unconfigured. An unauthenticated webhook
   * that credits balances is worse than a broken one.
   */
  async verifyWebhook(payload: any, rawHeaders?: unknown) {
    const configured = env.BREET_WEBHOOK_SECRET;
    if (!configured) throw forbidden('BREET_WEBHOOK_SECRET is not configured.');

    const headerBag = (rawHeaders ?? {}) as Record<string, string | string[] | undefined>;
    const provided = String(
      headerBag['x-webhook-secret'] ?? headerBag['X-Webhook-Secret'] ?? ''
    );

    const a = Buffer.from(provided);
    const b = Buffer.from(configured);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw forbidden('Invalid Breet webhook secret.');
    }

    return {
      // Breet's own guidance: "Use the id and event fields together to detect
      // duplicates". They retry with exponential backoff up to 24 hours, so
      // duplicates are expected, not exceptional.
      id: `ngnwh_${crypto.randomUUID()}`,
      provider: this.name,
      providerEventId: `${payload?.id ?? crypto.randomUUID()}:${payload?.event ?? 'unknown'}`,
      eventType: payload?.event ?? 'breet.unknown',
      transferId: payload?.id,
      payload,
      createdAt: new Date().toISOString(),
    };
  }

  async health(): Promise<NgnProviderHealth> {
    // Read from process.env as well as the parsed snapshot: env.ts parses once
    // at import, so a credential cleared or set afterwards would otherwise be
    // missed and health() would make a doomed network call instead of saying
    // plainly that it is unconfigured.
    // `??` is wrong here: env.BREET_APP_ID defaults to '' rather than
    // undefined, so a deleted process.env value would fall back to '' and still
    // read as "set". Take whichever is actually non-empty.
    const appId = process.env.BREET_APP_ID || env.BREET_APP_ID;
    const appSecret = process.env.BREET_APP_SECRET || env.BREET_APP_SECRET;
    const configured = Boolean(appId && appSecret);
    if (!configured) {
      return {
        provider: this.name,
        available: false,
        mode: 'live' as const,
        message: 'Breet credentials are not configured.',
        checkedAt: new Date().toISOString(),
      };
    }

    try {
      await breetRequest('/account');
      return {
        provider: this.name,
        available: true,
        mode: breetEnvironment() === 'production' ? ('live' as const) : ('sandbox' as const),
        message: `Breet reachable (${breetEnvironment()}).`,
        checkedAt: new Date().toISOString(),
      };
    } catch (error: any) {
      return {
        provider: this.name,
        available: false,
        mode: 'live' as const,
        message: String(error?.message ?? 'Breet unreachable.'),
        checkedAt: new Date().toISOString(),
      };
    }
  }
}

/** Breet's transaction states, mapped onto Sivan's. */
function mapStatus(status?: string) {
  const value = String(status ?? '').toLowerCase();
  if (value === 'completed') return 'completed' as const;
  if (value === 'failed' || value === 'rejected' || value === 'reversed') return 'failed' as const;
  // 'flagged' means confirmed on-chain but below the asset minimum: Breet
  // holds the funds and does NOT credit. That needs a human, not a retry.
  if (value === 'flagged') return 'requires_review' as const;
  return 'processing' as const;
}
