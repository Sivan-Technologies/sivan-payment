/**
 * Textile Credit FX Service — USDC/cNGN Rate Quoting on Celo
 *
 * Non-custodial FX rate quoting and firm-quote orchestration for the
 * USDC <-> cNGN conversion corridor on Celo Mainnet.
 *
 * Sivan AI never holds fiat or acts as a bank. This service fetches
 * institutional-grade FX rates from Textile Credit's RFQ API, caches
 * quotes for 60 seconds, and provides firm quote requests for NGN
 * bank payouts.
 *
 * Textile Credit is the licensed NGN bank liquidity and redemption
 * partner handling all actual currency conversion and NIBSS settlement.
 *
 * Integration Reference: Textile Credit API v2
 * Target Network: Celo Mainnet (Chain ID 42220) only
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TEXTILE_API_BASE = process.env.TEXTILE_CREDIT_API_URL || 'https://api.textilecredit.com/v2';
const TEXTILE_API_KEY = process.env.TEXTILE_CREDIT_API_KEY || '';

/** Quote cache TTL in milliseconds (60 seconds) */
const QUOTE_CACHE_TTL_MS = 60_000;

/** Sivan taker fee in basis points (1 bps = 0.01%) */
const SIVAN_TAKER_FEE_BPS = 100; // 1%

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TextileFxQuote {
  /** Direction of the conversion */
  direction: 'usdc_to_cngn' | 'cngn_to_usdc';
  /** Input amount (in source currency) */
  inputAmount: number;
  /** Output amount (in destination currency) after spread */
  outputAmount: number;
  /** Effective exchange rate (1 USDC = X NGN) */
  rate: number;
  /** Textile Credit spread (basis points) */
  spreadBps: number;
  /** Sivan protocol fee (in destination currency) */
  sivanFee: number;
  /** Net amount after Sivan fee deduction */
  netOutput: number;
  /** Quote timestamp */
  quotedAt: string;
  /** Quote expiry timestamp */
  expiresAt: string;
  /** Whether this is a live rate or cached */
  cached: boolean;
}

export interface TextileFirmQuote {
  /** Unique quote reference from Textile Credit */
  quoteId: string;
  /** Locked rate guaranteed for the duration */
  lockedRate: number;
  /** Input amount in USDC */
  inputUsdc: number;
  /** Gross NGN output before Sivan fee */
  grossNgn: number;
  /** Sivan protocol fee in NGN */
  sivanFeeNgn: number;
  /** Net NGN the contractor receives in their bank */
  netNgn: number;
  /** Bank account number for payout */
  bankAccount: string;
  /** Bank code (NIP) */
  bankCode: string;
  /** Quote validity window in seconds */
  validForSeconds: number;
  /** ISO timestamp when the firm quote expires */
  expiresAt: string;
}

export interface TextileRedemptionResult {
  /** Transaction reference from Textile Credit */
  redemptionId: string;
  /** Status: pending | completed | failed */
  status: 'pending' | 'completed' | 'failed';
  /** Celo transaction hash for the on-chain leg */
  celoTxHash?: string;
  /** NIBSS session ID for the bank leg */
  nibssSessionId?: string;
  /** Estimated settlement time */
  estimatedSettlement: string;
}

// ---------------------------------------------------------------------------
// Quote Cache
// ---------------------------------------------------------------------------

interface CachedQuote {
  quote: TextileFxQuote;
  fetchedAt: number;
}

const quoteCache = new Map<string, CachedQuote>();

function getCacheKey(direction: string, amount: number): string {
  // Round to 2 decimal places for cache key stability
  return `${direction}:${amount.toFixed(2)}`;
}

function getCachedQuote(direction: string, amount: number): TextileFxQuote | null {
  const key = getCacheKey(direction, amount);
  const cached = quoteCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > QUOTE_CACHE_TTL_MS) {
    quoteCache.delete(key);
    return null;
  }
  return { ...cached.quote, cached: true };
}

function setCachedQuote(direction: string, amount: number, quote: TextileFxQuote): void {
  const key = getCacheKey(direction, amount);
  quoteCache.set(key, { quote, fetchedAt: Date.now() });

  // Prune stale entries if cache grows beyond 100
  if (quoteCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of quoteCache) {
      if (now - v.fetchedAt > QUOTE_CACHE_TTL_MS) {
        quoteCache.delete(k);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// API Helpers
// ---------------------------------------------------------------------------

async function textileApiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  if (!TEXTILE_API_KEY) {
    throw new Error(
      'TEXTILE_CREDIT_API_KEY is not configured. Set it in your environment to enable cNGN FX quoting.'
    );
  }

  const url = `${TEXTILE_API_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEXTILE_API_KEY}`,
        'X-Client-Id': 'sivan-ai',
        ...(options?.headers || {}),
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => 'unknown');
      throw new Error(`Textile Credit API ${res.status}: ${errorBody}`);
    }

    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetches the current indicative USDC/cNGN exchange rate from Textile Credit.
 * Returns a cached quote if one exists within the 60-second TTL window.
 *
 * @param direction - 'usdc_to_cngn' for off-ramp, 'cngn_to_usdc' for on-ramp
 * @param amount - Input amount in the source currency
 */
export async function getTextileFxQuote(
  direction: 'usdc_to_cngn' | 'cngn_to_usdc',
  amount: number
): Promise<TextileFxQuote> {
  // Validate realistic amounts (5 USDC to 50 USDC, or 2,000 NGN to 50,000 NGN)
  if (direction === 'usdc_to_cngn' && (amount < 0.01 || amount > 10_000)) {
    throw new Error(`Invalid USDC amount: ${amount}. Expected between 0.01 and 10,000 USDC.`);
  }
  if (direction === 'cngn_to_usdc' && (amount < 1 || amount > 15_000_000)) {
    throw new Error(`Invalid cNGN amount: ${amount}. Expected between 1 and 15,000,000 cNGN.`);
  }

  // Check cache first
  const cached = getCachedQuote(direction, amount);
  if (cached) return cached;

  // Fetch fresh rate from Textile Credit
  const rateData = await textileApiFetch<{
    rate: number;
    spreadBps: number;
    timestamp: string;
  }>(`/rates?pair=${direction === 'usdc_to_cngn' ? 'USDC_NGN' : 'NGN_USDC'}&amount=${amount}`);

  const rate = rateData.rate;
  const spreadBps = rateData.spreadBps || 0;

  let outputAmount: number;
  if (direction === 'usdc_to_cngn') {
    // USDC -> cNGN: multiply by rate
    outputAmount = amount * rate;
  } else {
    // cNGN -> USDC: divide by rate
    outputAmount = amount / rate;
  }

  // Apply Sivan protocol fee
  const sivanFee = outputAmount * (SIVAN_TAKER_FEE_BPS / 10_000);
  const netOutput = outputAmount - sivanFee;

  const now = new Date();
  const quote: TextileFxQuote = {
    direction,
    inputAmount: amount,
    outputAmount: Math.round(outputAmount * 100) / 100,
    rate,
    spreadBps,
    sivanFee: Math.round(sivanFee * 100) / 100,
    netOutput: Math.round(netOutput * 100) / 100,
    quotedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + QUOTE_CACHE_TTL_MS).toISOString(),
    cached: false,
  };

  setCachedQuote(direction, amount, quote);
  return quote;
}

/**
 * Requests a firm (locked) quote from Textile Credit for an off-ramp payout.
 * The locked rate is guaranteed for the returned validity window.
 *
 * @param inputUsdc - The USDC amount to convert
 * @param bankAccount - Destination Nigerian bank account number
 * @param bankCode - NIP bank code (e.g. '058' for GTBank)
 */
export async function requestFirmQuote(
  inputUsdc: number,
  bankAccount: string,
  bankCode: string
): Promise<TextileFirmQuote> {
  if (inputUsdc < 1 || inputUsdc > 10_000) {
    throw new Error(`Firm quote amount must be between 1 and 10,000 USDC. Got: ${inputUsdc}`);
  }

  const result = await textileApiFetch<{
    quoteId: string;
    lockedRate: number;
    grossNgn: number;
    validForSeconds: number;
    expiresAt: string;
  }>('/quotes/firm', {
    method: 'POST',
    body: JSON.stringify({
      inputCurrency: 'USDC',
      outputCurrency: 'NGN',
      amount: inputUsdc,
      chain: 'celo',
      bankAccount,
      bankCode,
    }),
  });

  const sivanFeeNgn = result.grossNgn * (SIVAN_TAKER_FEE_BPS / 10_000);

  return {
    quoteId: result.quoteId,
    lockedRate: result.lockedRate,
    inputUsdc,
    grossNgn: result.grossNgn,
    sivanFeeNgn: Math.round(sivanFeeNgn * 100) / 100,
    netNgn: Math.round((result.grossNgn - sivanFeeNgn) * 100) / 100,
    bankAccount,
    bankCode,
    validForSeconds: result.validForSeconds,
    expiresAt: result.expiresAt,
  };
}

/**
 * Initiates a cNGN redemption through Textile Credit.
 * Sends USDC on Celo -> Textile Credit converts to cNGN -> redeems to NGN bank.
 *
 * @param quoteId - The firm quote ID obtained from requestFirmQuote
 * @param celoTxHash - The on-chain transaction hash of the USDC transfer to Textile Credit
 */
export async function executeRedemption(
  quoteId: string,
  celoTxHash: string
): Promise<TextileRedemptionResult> {
  return textileApiFetch<TextileRedemptionResult>('/redemptions', {
    method: 'POST',
    body: JSON.stringify({
      quoteId,
      celoTxHash,
      chain: 'celo',
    }),
  });
}

/**
 * Checks the status of a pending redemption.
 */
export async function getRedemptionStatus(
  redemptionId: string
): Promise<TextileRedemptionResult> {
  return textileApiFetch<TextileRedemptionResult>(`/redemptions/${redemptionId}`);
}

/**
 * Clears the quote cache. Useful for testing.
 */
export function clearQuoteCache(): void {
  quoteCache.clear();
}
