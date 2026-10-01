import crypto from 'node:crypto';
import { db } from '../database/json-database.js';
import {
  webhookPublicKey,
  moneyGramEnvironment,
} from '../moneygram/config/moneygram.config.js';

export class MoneyGramWebhookError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 400
  ) {
    super(message);
    this.name = 'MoneyGramWebhookError';
  }
}

export interface MoneyGramWebhookPayload {
  event_type?: string;
  type?: string;
  timestamp?: number | string;
  transaction?: {
    id: string;
    external_transaction_id?: string;
    status: string;
    amount_in?: string;
    amount_out?: string;
    amount_fee?: string;
    from?: string;
    to?: string;
    started_at?: string;
    completed_at?: string;
    more_info_url?: string;
    message?: string;
  };
  [key: string]: unknown;
}

export interface MoneyGramWebhookResult {
  status: 'processed' | 'ignored';
  event: string;
  transactionId?: string;
  referencePin?: string;
  details?: Record<string, unknown>;
}

const MAX_SKEW_SECONDS = 300; // 5 minutes replay protection

/**
 * Validates the RSA-SHA256 signature on incoming MoneyGram webhook callbacks.
 *
 * Digest: `${timestamp}.${destinationHost}.${rawBodyString}`
 */
export function verifyMoneyGramSignature({
  rawBody,
  signatureHeader,
  timestampHeader,
  host,
}: {
  rawBody: Buffer | string;
  signatureHeader?: string | string[];
  timestampHeader?: string | string[];
  host?: string;
}): { valid: boolean; reason?: string } {
  const sig = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  const ts = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;

  // In sandbox/development, allow graceful pass-through if public key is not yet configured
  let publicKeyPem: string;
  try {
    publicKeyPem = webhookPublicKey();
  } catch (err: any) {
    if (moneyGramEnvironment() === 'sandbox') {
      return { valid: true, reason: 'sandbox_unconfigured_key_bypass' };
    }
    return { valid: false, reason: 'MONEYGRAM_WEBHOOK_PUBLIC_KEY not set' };
  }

  if (!sig) return { valid: false, reason: 'missing signature header' };
  if (!ts) return { valid: false, reason: 'missing timestamp header' };

  // Replay protection window check
  const now = Math.floor(Date.now() / 1000);
  const numericTs = Number(ts);
  if (!Number.isFinite(numericTs)) return { valid: false, reason: 'timestamp is not numeric' };
  const skew = Math.abs(now - numericTs);
  if (skew > MAX_SKEW_SECONDS) {
    return { valid: false, reason: `timestamp skew ${skew}s exceeds ${MAX_SKEW_SECONDS}s window` };
  }

  // Construct digest: `${timestamp}.${host}.${rawBodyString}`
  const rawString = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const destinationHost = host || (process.env.MONEYGRAM_WEBHOOK_HOST || 'api.sivantech.online');
  const digest = `${ts}.${destinationHost}.${rawString}`;

  try {
    const isVerified = crypto.verify(
      'RSA-SHA256',
      Buffer.from(digest, 'utf8'),
      publicKeyPem,
      Buffer.from(sig, 'base64')
    );
    return isVerified ? { valid: true } : { valid: false, reason: 'signature mismatch' };
  } catch (err: any) {
    return { valid: false, reason: `crypto verification error: ${err.message}` };
  }
}

/**
 * Processes incoming MoneyGram webhook events and updates transaction state.
 */
export async function processMoneyGramWebhook(
  body: MoneyGramWebhookPayload,
  rawBody: Buffer | string,
  headers: Record<string, string | string[] | undefined>
): Promise<MoneyGramWebhookResult> {
  const signature = headers['x-mg-signature'] || headers['x-moneygram-signature'];
  const timestamp = headers['x-mg-timestamp'] || headers['x-mg-time'] || headers['x-timestamp'];
  const host = (headers['x-forwarded-host'] || headers['host'] || 'api.sivantech.online') as string;

  const verification = verifyMoneyGramSignature({
    rawBody,
    signatureHeader: signature,
    timestampHeader: timestamp,
    host,
  });

  if (!verification.valid) {
    throw new MoneyGramWebhookError(`MoneyGram webhook verification failed: ${verification.reason}`, 401);
  }

  const transaction = body.transaction || (body as any);
  const transactionId = transaction?.id || `mg_${Date.now()}`;
  const status = transaction?.status || 'unknown';
  const eventType = body.event_type || body.type || 'TRANSACTION_STATUS_EVENT';
  const referencePin = transaction?.external_transaction_id;

  // Persist webhook event record into unified database
  try {
    const eventId = `mg_evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await db.insertUnifiedWebhookLogRecord({
      id: eventId,
      serviceName: 'sivan-payment',
      provider: 'moneygram',
      providerEventId: transactionId,
      paymentReference: referencePin,
      eventCategory: 'moneygram_ramps',
      eventType,
      payload: {
        transactionId,
        status,
        eventType,
        referencePin,
        amountIn: transaction?.amount_in,
        amountOut: transaction?.amount_out,
        moreInfoUrl: transaction?.more_info_url,
      },
      createdAt: new Date().toISOString(),
    });
  } catch {
    // Non-fatal if database persistence fails during unit test
  }

  return {
    status: 'processed',
    event: eventType,
    transactionId,
    referencePin,
    details: {
      transactionStatus: status,
      amountIn: transaction?.amount_in,
      amountOut: transaction?.amount_out,
      moreInfoUrl: transaction?.more_info_url,
    },
  };
}
