import crypto from 'node:crypto';
import { paystackWebhookSecret } from '../config/paystackConfig.js';
import {
  completeAfterIdentification,
  recordIdentificationFailure,
  findDvaRecord,
} from '../virtual-accounts/service/paystackDvaService.js';
import { db } from '../database/json-database.js';
import { createBalanceLedgerEntry } from '../balances/balance.service.js';
import { getNgnAgreementLedger } from '../ngn/balance-agreements/runtime.js';
import type { NgnTransferRecord } from '../ngn/types/ngn.types.js';
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
 * Calculates Sivan platform fee for Dedicated Virtual Account deposits.
 * Canonical implementation lives in src/ngn/fees/dva-inflow-fee.ts
 * Imported for internal use and re-exported for external consumers.
 */
import { calculateDvaInflowFee } from '../ngn/fees/dva-inflow-fee.js';
export { calculateDvaInflowFee };


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

      const dvaResult = await completeAfterIdentification(userId, customerCode);
      if (dvaResult.state === 'ready' && dvaResult.account?.accountNumber) {
        void import('../deposits/deposit-notification.service.js')
          .then(({ notifyDvaActivated }) => {
            void notifyDvaActivated(userId, {
              accountNumber: dvaResult.account!.accountNumber,
              bankName: dvaResult.account!.bankName || 'Wema Bank',
              accountName: dvaResult.account!.accountName || 'Sivan Verified Account',
            });
          })
          .catch(() => undefined);
      }

      // Update user full name from verified customer record if available
      try {
        const user = await db.findUserById(userId);
        if (user) {
          const verifiedFirst = (eventData as any).first_name || (eventData as any).customer?.first_name;
          const verifiedLast = (eventData as any).last_name || (eventData as any).customer?.last_name;
          if (verifiedFirst && verifiedLast) {
            user.fullName = `${verifiedLast} ${verifiedFirst}`.trim();
            await db.updateUserRecord(user);
          }
        }
      } catch (_nameErr) {
        // Non-blocking
      }

      // Atomically mark the user's NGN Level 2 identity verification as matched / verified
      try {
        const now = new Date().toISOString();
        const verifications = await db.listNgnIdentityVerifications(userId);
        const existingKyc = verifications.find((v) => v.checkType === 'bvn_info');
        await db.upsertNgnIdentityVerification({
          id: existingKyc?.id || `ngnkyc_${userId}_bvn`,
          userId,
          checkType: 'bvn_info',
          status: 'matched',
          provider: 'paystack',
          providerReference: customerCode,
          bvnLast4: existingKyc?.bvnLast4 || 'bvn',
          verifiedAt: now,
          createdAt: existingKyc?.createdAt || now,
          updatedAt: now,
        });
      } catch (_err) {
        // Non-blocking: DVA assignment is already complete
      }

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

      try {
        const verifications = await db.listNgnIdentityVerifications(userId);
        const existingKyc = verifications.find((v) => v.checkType === 'bvn_info');
        if (existingKyc) {
          await db.upsertNgnIdentityVerification({
            ...existingKyc,
            status: 'failed',
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (_err) {
        // Ignore failure update error
      }
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

      const currency = String(eventData.currency || '').toUpperCase();
      if (currency && currency !== 'NGN') {
        return {
          status: 'ignored',
          event: eventType,
          details: { reason: `Currency ${currency} is not supported for NGN DVA deposit` },
        };
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

      // 2. Identify Sivan User strictly from trusted stored database records (never caller metadata)
      const customerCode = String(eventData.customer?.customer_code || '').trim();
      const allAccounts = await db.listVirtualAccounts();
      const matchingAccount = allAccounts.find(
        (acc) => acc.customerId === customerCode && acc.provider === 'paystack'
      );

      if (!matchingAccount || !matchingAccount.userId) {
        return {
          status: 'ignored',
          event: eventType,
          details: { reason: `Cannot correlate deposit to verified Sivan user record for customer ${customerCode}` },
        };
      }

      const userId = matchingAccount.userId;
      const virtualAccountId = matchingAccount.id;
      const providerAccountId = matchingAccount.providerAccountId;

      // 3. Amount and Fee Calculation
      const amountKobo = Number(eventData.amount || 0);
      if (!Number.isFinite(amountKobo) || amountKobo <= 0) {
        throw new PaystackWebhookError('Invalid or non-positive amount in charge.success event', 400);
      }
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

      // 6. Record Unified Balance Ledger Entry
      await createBalanceLedgerEntry(
        {
          userId,
          asset: 'ngn',
          amount: netNgn.toFixed(2),
          kind: 'credit_available',
          status: 'available',
          sourceType: 'virtual_account_transaction',
          sourceId: txRecord.id,
          description: `Paystack DVA deposit settled (${reference}): gross ${grossNgn.toFixed(2)} NGN, fee ${feeNgn.toFixed(2)} NGN`,
          transferId: txRecord.id,
        },
        { actorType: 'provider', actorId: 'paystack' }
      );

      // 7. Credit Authoritative NGN Agreement Ledger if active
      const agreementLedger = getNgnAgreementLedger();
      if (agreementLedger) {
        try {
          await agreementLedger.creditVerifiedDeposit(reference);
        } catch {
          // Idempotent or handled
        }
      }

      // 8. Notify user — NGN DVA path only, completely isolated from crypto notifications
      const senderName = String(eventData.authorization?.sender_name || '').trim() || undefined;
      const senderBank = String(eventData.authorization?.sender_bank || '').trim() || undefined;
      void import('../deposits/deposit-notification.service.js')
        .then(({ notifyNgnDvaDeposit }) => {
          void notifyNgnDvaDeposit(userId, grossNgn, reference, senderName, senderBank);
        })
        .catch(() => undefined);

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


    case 'transfer.success': {
      const reference = String(eventData.reference || '').trim();
      const transferCode = String(eventData.transfer_code || '').trim();
      const now = new Date().toISOString();

      if (!reference && !transferCode) {
        return {
          status: 'ignored',
          event: eventType,
          details: { reason: 'Missing reference and transfer_code in transfer.success payload' },
        };
      }

      const ngnTransfers = await db.listNgnTransfers();
      const matchingTransfer = ngnTransfers.find(
        (t) =>
          (reference && (t.bankReference === reference || t.settlementReference === reference || t.id === reference || t.providerTransferId === reference)) ||
          (transferCode && (t.providerTransferId === transferCode || t.settlementReference === transferCode))
      );

      const vaTransactions = await db.listVirtualAccountTransactions();
      const matchingVaTx = vaTransactions.find(
        (tx) =>
          (reference && (tx.depositId === reference || tx.depositReference === reference || tx.id === reference)) ||
          (transferCode && (tx.depositReference === transferCode || tx.depositId === transferCode))
      );

      // Idempotency: if already completed
      if (
        (matchingTransfer && matchingTransfer.status === 'completed') ||
        (matchingVaTx && matchingVaTx.status === 'completed')
      ) {
        return {
          status: 'processed',
          event: eventType,
          details: { duplicate: true, reference, transferCode, message: 'Transfer already marked completed' },
        };
      }

      const userId = matchingTransfer?.userId || matchingVaTx?.userId;
      const amountKobo = Number(eventData.amount || 0);
      const grossNgn = amountKobo > 0 ? (amountKobo / 100).toFixed(2) : matchingTransfer?.sourceAmount || matchingVaTx?.sourceAmount || '0.00';

      if (matchingTransfer) {
        const updatedTransfer: NgnTransferRecord = {
          ...matchingTransfer,
          status: 'completed',
          providerTransferId: transferCode || matchingTransfer.providerTransferId,
          settlementReference: reference || matchingTransfer.settlementReference,
          completedAt: now,
          updatedAt: now,
          metadata: {
            ...(typeof matchingTransfer.metadata === 'object' && matchingTransfer.metadata ? matchingTransfer.metadata : {}),
            paystackTransferCode: transferCode,
            paystackReference: reference,
            lastWebhookEvent: eventType,
            lastWebhookAt: now,
            settledAt: now,
          },
        };
        await db.upsertNgnTransferRecord(updatedTransfer);
      }

      if (matchingVaTx) {
        const updatedVaTx: VirtualAccountTransactionRecord = {
          ...matchingVaTx,
          status: 'completed',
          completedAt: now,
          updatedAt: now,
          lastProviderEventId: String(payload.id || reference || transferCode),
          rawPayload: eventData,
        };
        await db.upsertVirtualAccountTransactionRecord(updatedVaTx);
      }

      if (userId) {
        await createBalanceLedgerEntry(
          {
            userId,
            asset: 'ngn',
            amount: grossNgn,
            kind: 'debit_transfer',
            status: 'completed',
            sourceType: 'ngn_cashout',
            sourceId: matchingTransfer?.id || matchingVaTx?.id || reference || transferCode,
            description: `Debit held NGN after Paystack transfer completion (${reference || transferCode})`,
            transferId: matchingTransfer?.id || matchingVaTx?.id || reference,
          },
          { actorType: 'provider', actorId: 'paystack' }
        );
      }

      const eventRecord: VirtualAccountEventRecord = {
        id: `vaev_paystack_${crypto.createHash('sha256').update(`success_${reference || transferCode}_${now}`).digest('hex').slice(0, 24)}`,
        provider: 'paystack',
        providerEventId: String(payload.id || reference || transferCode),
        depositId: reference || transferCode,
        eventType: 'payment_processed',
        sourceCurrency: 'ngn',
        destinationCurrency: 'ngn',
        sourceAmount: grossNgn,
        destinationAmount: grossNgn,
        paymentRail: 'nibss_paystack_nip',
        status: 'completed',
        depositReference: reference || transferCode,
        rawPayload: payload,
        createdAt: now,
        updatedAt: now,
      };
      await db.upsertVirtualAccountEventRecord(eventRecord);

      return {
        status: 'processed',
        event: eventType,
        details: {
          reference,
          transferCode,
          userId,
          amountNgn: grossNgn,
          status: 'completed',
        },
      };
    }

    case 'transfer.failed': {
      const reference = String(eventData.reference || '').trim();
      const transferCode = String(eventData.transfer_code || '').trim();
      const failureReason = String(eventData.reason || eventData.gateway_response || 'Declined by destination bank or NIBSS');
      const now = new Date().toISOString();

      if (!reference && !transferCode) {
        return {
          status: 'ignored',
          event: eventType,
          details: { reason: 'Missing reference and transfer_code in transfer.failed payload' },
        };
      }

      const ngnTransfers = await db.listNgnTransfers();
      const matchingTransfer = ngnTransfers.find(
        (t) =>
          (reference && (t.bankReference === reference || t.settlementReference === reference || t.id === reference || t.providerTransferId === reference)) ||
          (transferCode && (t.providerTransferId === transferCode || t.settlementReference === transferCode))
      );

      const vaTransactions = await db.listVirtualAccountTransactions();
      const matchingVaTx = vaTransactions.find(
        (tx) =>
          (reference && (tx.depositId === reference || tx.depositReference === reference || tx.id === reference)) ||
          (transferCode && (tx.depositReference === transferCode || tx.depositId === transferCode))
      );

      // Idempotency: if already failed or cancelled
      if (
        (matchingTransfer && (matchingTransfer.status === 'failed' || matchingTransfer.status === 'cancelled')) ||
        (matchingVaTx && (matchingVaTx.status === 'failed' || matchingVaTx.status === 'refunded'))
      ) {
        return {
          status: 'processed',
          event: eventType,
          details: { duplicate: true, reference, transferCode, message: 'Transfer failure already recorded' },
        };
      }

      const userId = matchingTransfer?.userId || matchingVaTx?.userId;
      const amountKobo = Number(eventData.amount || 0);
      const grossNgn = amountKobo > 0 ? (amountKobo / 100).toFixed(2) : matchingTransfer?.sourceAmount || matchingVaTx?.sourceAmount || '0.00';

      if (matchingTransfer) {
        const updatedTransfer: NgnTransferRecord = {
          ...matchingTransfer,
          status: 'failed',
          providerTransferId: transferCode || matchingTransfer.providerTransferId,
          updatedAt: now,
          metadata: {
            ...(typeof matchingTransfer.metadata === 'object' && matchingTransfer.metadata ? matchingTransfer.metadata : {}),
            paystackTransferCode: transferCode,
            paystackReference: reference,
            lastWebhookEvent: eventType,
            lastWebhookAt: now,
            failureReason,
          },
        };
        await db.upsertNgnTransferRecord(updatedTransfer);
      }

      if (matchingVaTx) {
        const updatedVaTx: VirtualAccountTransactionRecord = {
          ...matchingVaTx,
          status: 'failed',
          updatedAt: now,
          lastProviderEventId: String(payload.id || reference || transferCode),
          rawPayload: eventData,
        };
        await db.upsertVirtualAccountTransactionRecord(updatedVaTx);
      }

      // ATOMIC BALANCE RESTORATION: release hold back to user available balance
      if (userId) {
        await createBalanceLedgerEntry(
          {
            userId,
            asset: 'ngn',
            amount: grossNgn,
            kind: 'hold_release',
            status: 'available',
            sourceType: 'ngn_cashout',
            sourceId: matchingTransfer?.id || matchingVaTx?.id || reference || transferCode,
            description: `Release NGN hold after Paystack payout failed: ${failureReason}`,
            transferId: matchingTransfer?.id || matchingVaTx?.id || reference,
          },
          { actorType: 'provider', actorId: 'paystack' }
        );
      }

      const eventRecord: VirtualAccountEventRecord = {
        id: `vaev_paystack_${crypto.createHash('sha256').update(`failed_${reference || transferCode}_${now}`).digest('hex').slice(0, 24)}`,
        provider: 'paystack',
        providerEventId: String(payload.id || reference || transferCode),
        depositId: reference || transferCode,
        eventType: 'refunded',
        sourceCurrency: 'ngn',
        destinationCurrency: 'ngn',
        sourceAmount: grossNgn,
        destinationAmount: grossNgn,
        paymentRail: 'nibss_paystack_nip',
        status: 'failed',
        depositReference: reference || transferCode,
        rawPayload: payload,
        createdAt: now,
        updatedAt: now,
      };
      await db.upsertVirtualAccountEventRecord(eventRecord);

      return {
        status: 'processed',
        event: eventType,
        details: {
          reference,
          transferCode,
          userId,
          amountNgn: grossNgn,
          status: 'failed',
          refunded: Boolean(userId),
          failureReason,
        },
      };
    }

    case 'transfer.reversed': {
      const reference = String(eventData.reference || '').trim();
      const transferCode = String(eventData.transfer_code || '').trim();
      const reversalReason = String(eventData.reason || eventData.gateway_response || 'Reversed by destination bank via NIBSS NIP rail');
      const now = new Date().toISOString();

      if (!reference && !transferCode) {
        return {
          status: 'ignored',
          event: eventType,
          details: { reason: 'Missing reference and transfer_code in transfer.reversed payload' },
        };
      }

      const ngnTransfers = await db.listNgnTransfers();
      const matchingTransfer = ngnTransfers.find(
        (t) =>
          (reference && (t.bankReference === reference || t.settlementReference === reference || t.id === reference || t.providerTransferId === reference)) ||
          (transferCode && (t.providerTransferId === transferCode || t.settlementReference === transferCode))
      );

      const vaTransactions = await db.listVirtualAccountTransactions();
      const matchingVaTx = vaTransactions.find(
        (tx) =>
          (reference && (tx.depositId === reference || tx.depositReference === reference || tx.id === reference)) ||
          (transferCode && (tx.depositReference === transferCode || tx.depositId === transferCode))
      );

      // Idempotency: check if already reversed
      const meta = (matchingTransfer?.metadata || {}) as Record<string, unknown>;
      if (meta.reversed === true || (matchingVaTx && matchingVaTx.status === 'refunded')) {
        return {
          status: 'processed',
          event: eventType,
          details: { duplicate: true, reference, transferCode, message: 'Transfer reversal already credited' },
        };
      }

      const userId = matchingTransfer?.userId || matchingVaTx?.userId;
      const amountKobo = Number(eventData.amount || 0);
      const grossNgn = amountKobo > 0 ? (amountKobo / 100).toFixed(2) : matchingTransfer?.sourceAmount || matchingVaTx?.sourceAmount || '0.00';

      if (matchingTransfer) {
        const updatedTransfer: NgnTransferRecord = {
          ...matchingTransfer,
          status: 'failed',
          providerTransferId: transferCode || matchingTransfer.providerTransferId,
          updatedAt: now,
          metadata: {
            ...meta,
            paystackTransferCode: transferCode,
            paystackReference: reference,
            lastWebhookEvent: eventType,
            lastWebhookAt: now,
            reversed: true,
            reversedAt: now,
            reversalReason,
          },
        };
        await db.upsertNgnTransferRecord(updatedTransfer);
      }

      if (matchingVaTx) {
        const updatedVaTx: VirtualAccountTransactionRecord = {
          ...matchingVaTx,
          status: 'refunded',
          updatedAt: now,
          lastProviderEventId: String(payload.id || reference || transferCode),
          rawPayload: eventData,
        };
        await db.upsertVirtualAccountTransactionRecord(updatedVaTx);
      }

      // CRITICAL LEDGER REVERSAL: Atomically credit user ledger back
      if (userId) {
        await createBalanceLedgerEntry(
          {
            userId,
            asset: 'ngn',
            amount: grossNgn,
            kind: 'credit_available',
            status: 'available',
            sourceType: 'cashout_reversal',
            sourceId: `rev_${matchingTransfer?.id || matchingVaTx?.id || reference || transferCode}`,
            description: `Reversal credit NGN after Paystack transfer reversal (${reference || transferCode}): ${reversalReason}`,
            transferId: matchingTransfer?.id || matchingVaTx?.id || reference,
          },
          { actorType: 'provider', actorId: 'paystack' }
        );
      }

      const eventRecord: VirtualAccountEventRecord = {
        id: `vaev_paystack_${crypto.createHash('sha256').update(`reversed_${reference || transferCode}_${now}`).digest('hex').slice(0, 24)}`,
        provider: 'paystack',
        providerEventId: String(payload.id || reference || transferCode),
        depositId: reference || transferCode,
        eventType: 'refunded',
        sourceCurrency: 'ngn',
        destinationCurrency: 'ngn',
        sourceAmount: grossNgn,
        destinationAmount: grossNgn,
        paymentRail: 'nibss_paystack_nip',
        status: 'refunded',
        depositReference: reference || transferCode,
        rawPayload: payload,
        createdAt: now,
        updatedAt: now,
      };
      await db.upsertVirtualAccountEventRecord(eventRecord);

      return {
        status: 'processed',
        event: eventType,
        details: {
          reference,
          transferCode,
          userId,
          amountNgn: grossNgn,
          status: 'reversed',
          refunded: Boolean(userId),
          reversalReason,
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
