import crypto from 'node:crypto';
import { paystackWebhookSecret } from '../config/paystackConfig.js';
import {
  completeAfterIdentification,
  recordIdentificationFailure,
  findDvaRecord,
} from '../virtual-accounts/service/paystackDvaService.js';
import { db } from '../database/json-database.js';
import type {
  VirtualAccountEventRecord,
  VirtualAccountTransactionRecord,
} from '../virtual-accounts/types/virtual-account.types.js';

export class PaystackWebhookError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 400
  ) {
    super(message);
    this.name = 'PaystackWebhookError';
  }
}

/**
 * Validates the HMAC-SHA512 signature on incoming Paystack webhook requests.
 */
export function verifyPaystackSignature(
  rawBody: Buffer | string,
  signatureHeader?: string | string[]
): boolean {
  if (!signatureHeader) return false;
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!signature || typeof signature !== 'string') return false;

  const secret = paystackWebhookSecret();
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');

  const computed = crypto.createHmac('sha512', secret).update(raw).digest('hex');
  const computedBuffer = Buffer.from(computed);
  const signatureBuffer = Buffer.from(signature);

  if (computedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(computedBuffer, signatureBuffer);
}

/**
 * Calculates Sivan platform fee for Dedicated Virtual Account deposits:
 * - Under 3,000 NGN: 0% fee (free tier).
 * - 3,000 NGN and above: 1.3% capped at 500 NGN.
 */
export function calculateDvaInflowFee(grossNgn: number): {
  feeNgn: number;
  netNgn: number;
} {
  if (grossNgn < 3000) {
    return { feeNgn: 0, netNgn: grossNgn };
  }
  const rawFee = grossNgn * 0.013;
  const feeNgn = Math.min(500, Math.round(rawFee * 100) / 100);
  const netNgn = Math.round((grossNgn - feeNgn) * 100) / 100;
  return { feeNgn, netNgn };
}

export interface PaystackWebhookResult {
  status: 'processed' | 'ignored';
  event: string;
  details?: Record<string, unknown>;
}

/**
 * Core processor for Paystack webhooks.
 * Operates idempotently and dispatches identity and deposit events.
 */
export async function processPaystackWebhook(
  payload: any,
  rawBody: Buffer | string,
  signatureHeader?: string | string[]
): Promise<PaystackWebhookResult> {
  if (!verifyPaystackSignature(rawBody, signatureHeader)) {
    throw new PaystackWebhookError('Invalid or missing x-paystack-signature header', 401);
  }

  if (!payload || typeof payload !== 'object') {
    throw new PaystackWebhookError('Invalid Paystack webhook payload shape', 400);
  }

  const eventType = String(payload.event || '').trim();
  const eventData = payload.data || {};

  switch (eventType) {
    case 'customeridentification.success': {
      const customerCode = String(eventData.customer_code || '').trim();
      const metadataUserId = eventData.metadata?.sivanUserId;

      let userId = metadataUserId;
      if (!userId) {
        const allAccounts = await db.listVirtualAccounts();
        const matching = allAccounts.find(
          (acc) => acc.customerId === customerCode && acc.provider === 'paystack'
        );
        userId = matching?.userId;
      }

      if (!userId) {
        return {
          status: 'ignored',
          event: eventType,
          details: { reason: `No matching Sivan user found for customer_code ${customerCode}` },
        };
      }

      await completeAfterIdentification(userId, customerCode);
      return {
        status: 'processed',
        event: eventType,
        details: { userId, customerCode, activated: true },
      };
    }

    case 'customeridentification.failed': {
      const customerCode = String(eventData.customer_code || '').trim();
      const reason = String(eventData.reason || 'Identification failed at NIBSS');
      const metadataUserId = eventData.metadata?.sivanUserId;

      let userId = metadataUserId;
      if (!userId) {
        const allAccounts = await db.listVirtualAccounts();
        const matching = allAccounts.find(
          (acc) => acc.customerId === customerCode && acc.provider === 'paystack'
        );
        userId = matching?.userId;
      }

      if (!userId) {
        return {
          status: 'ignored',
          event: eventType,
          details: { reason: `No matching Sivan user found for customer_code ${customerCode}` },
        };
      }

      await recordIdentificationFailure(userId, reason);
      return {
        status: 'processed',
        event: eventType,
        details: { userId, customerCode, failed: true, reason },
      };
    }

    case 'charge.success': {
      const channel = String(eventData.channel || '').trim();
      // Dedicated Virtual Account deposits arrive with channel: "dedicated_nuban"
      if (channel !== 'dedicated_nuban') {
        return {
          status: 'ignored',
          event: eventType,
          details: { reason: `Channel ${channel} is not a dedicated virtual account deposit` },
        };
      }

      const reference = String(eventData.reference || '').trim();
      if (!reference) {
        throw new PaystackWebhookError('Missing reference in charge.success event', 400);
      }

      // 1. Idempotency Check: Don't process the same deposit twice
      const existingTransactions = await db.listVirtualAccountTransactions();
      const alreadyProcessed = existingTransactions.find(
        (tx) => tx.depositId === reference || tx.depositReference === reference
      );
      if (alreadyProcessed) {
        return {
          status: 'processed',
          event: eventType,
          details: { duplicate: true, reference, message: 'Deposit reference already processed' },
        };
      }

      // 2. Identify Sivan User
      const customerCode = String(eventData.customer?.customer_code || '').trim();
      let userId = eventData.customer?.metadata?.sivanUserId;

      let virtualAccountId: string | undefined;
      let providerAccountId: string | undefined;

      const allAccounts = await db.listVirtualAccounts();
      const matchingAccount = allAccounts.find(
        (acc) => acc.customerId === customerCode && acc.provider === 'paystack'
      );

      if (matchingAccount) {
        userId = userId || matchingAccount.userId;
        virtualAccountId = matchingAccount.id;
        providerAccountId = matchingAccount.providerAccountId;
      }

      if (!userId) {
        return {
          status: 'ignored',
          event: eventType,
          details: { reason: `Cannot correlate deposit to Sivan user for customer ${customerCode}` },
        };
      }

      // 3. Amount and Fee Calculation
      const amountKobo = Number(eventData.amount || 0);
      const grossNgn = amountKobo / 100;
      const { feeNgn, netNgn } = calculateDvaInflowFee(grossNgn);

      const now = new Date().toISOString();

      // 4. Record Virtual Account Transaction
      const txRecord: VirtualAccountTransactionRecord = {
        id: `vatx_paystack_${crypto.createHash('sha256').update(reference).digest('hex').slice(0, 24)}`,
        provider: 'paystack',
        virtualAccountId,
        providerAccountId,
        depositId: reference,
        userId,
        customerId: customerCode,
        sourceCurrency: 'ngn',
        destinationCurrency: 'ngn',
        sourceAmount: grossNgn.toFixed(2),
        destinationAmount: netNgn.toFixed(2),
        paymentRail: 'nibss_paystack_dva',
        status: 'completed',
        depositReference: reference,
        rawPayload: eventData,
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      };

      await db.upsertVirtualAccountTransactionRecord(txRecord);

      // 5. Record Virtual Account Event
      const eventRecord: VirtualAccountEventRecord = {
        id: `vaev_paystack_${crypto.createHash('sha256').update(`${reference}_${now}`).digest('hex').slice(0, 24)}`,
        provider: 'paystack',
        providerEventId: String(payload.id || reference),
        virtualAccountId,
        providerAccountId,
        depositId: reference,
        eventType: 'funds_received',
        sourceCurrency: 'ngn',
        destinationCurrency: 'ngn',
        sourceAmount: grossNgn.toFixed(2),
        destinationAmount: netNgn.toFixed(2),
        paymentRail: 'nibss_paystack_dva',
        status: 'completed',
        depositReference: reference,
        rawPayload: payload,
        createdAt: now,
        updatedAt: now,
      };

      await db.upsertVirtualAccountEventRecord(eventRecord);

      return {
        status: 'processed',
        event: eventType,
        details: {
          userId,
          reference,
          grossNgn,
          feeNgn,
          netNgn,
          transactionId: txRecord.id,
        },
      };
    }

    default:
      return {
        status: 'ignored',
        event: eventType,
        details: { message: `Unhandled Paystack event: ${eventType}` },
      };
  }
}
