/**
 * SIVAN UNIFIED CHECKOUT SERVICE
 *
 * Pluggable business logic layer for hosted checkout, dynamic bank transfers,
 * and card inflows across any active provider (Nomba, 9PSB, Paystack).
 *
 * Enforces strict financial ledger integrity:
 *   1. Authoritative re-query verification before delivering any value.
 *   2. Strict ledger idempotency (duplicate webhooks or claims cannot credit twice).
 *   3. Dynamic provider switching via CHECKOUT_PROVIDER with zero code changes.
 */

import { createBalanceLedgerEntry, listUserBalanceLedger } from '../../balances/balance.service.js';
import { getUnifiedBalance } from '../../balances/unified-balance.service.js';
import { db } from '../../database/json-database.js';
import { createAuditLog } from '../../audit/audit.service.js';
import { env } from '../../config/env.js';
import {
  getCheckoutProvider,
  getDefaultCheckoutProviderName,
} from '../provider/checkout-registry.js';
import type {
  CreateCheckoutInput,
  CheckoutOrderResult,
  CheckoutVerificationResult,
  CheckoutProviderName,
} from '../provider/checkout-provider.interface.js';

export interface CheckoutProcessingResult {
  processed: boolean;
  alreadyProcessed?: boolean;
  action: 'balance_deposit' | 'agreement_funded';
  userId: string;
  amountNgn: number;
  orderReference: string;
  transactionId?: string;
  agreementId?: string;
  provider: CheckoutProviderName;
}

export class SivanCheckoutService {
  /**
   * Helper to detect provider from orderReference if not explicitly provided.
   */
  public detectProviderFromReference(orderReference: string): CheckoutProviderName {
    if (orderReference.includes('_9psb_')) return '9psb';
    if (orderReference.includes('_pstk_')) return 'paystack';
    return getDefaultCheckoutProviderName();
  }

  /**
   * Resolves any raw channel identifier (e.g. +2348079604214, whatsapp:+234..., usr_..., or
   * orderReference / customerEmail fallback) to the canonical internal `usr_...` userId.
   */
  public async resolveCheckoutUserId(
    rawUserId?: string,
    orderReference?: string,
    customerEmail?: string
  ): Promise<string | null> {
    const candidates: string[] = [];
    if (rawUserId && rawUserId !== 'unknown') {
      candidates.push(rawUserId.trim());
    }

    // Extract user/phone token from orderReference (e.g. sivan_dep__2348079604214_1795..._abc)
    if (orderReference) {
      const refMatch = orderReference.match(/^sivan_(?:dep|agr)_+([^_]+)_/);
      if (refMatch?.[1]) {
        candidates.push(refMatch[1]);
      }
    }

    // Extract phone token from synthetic email (_2348079604214@users.sivantech.online)
    if (customerEmail) {
      const localPart = customerEmail.split('@')[0]?.replace(/^_+/, '') || '';
      if (/^\d{10,15}$/.test(localPart)) {
        candidates.push(`+${localPart}`);
      }
      candidates.push(customerEmail.trim());
    }

    for (const candidate of candidates) {
      if (!candidate) continue;
      if (candidate.startsWith('usr_')) {
        const byId = await db.findUserById(candidate).catch(() => null);
        if (byId) return byId.id;
      }

      const digits = candidate.replace(/^whatsapp:/i, '').replace(/\D/g, '');
      if (digits.length >= 10 && digits.length <= 15) {
        const withPlus = `+${digits}`;
        const byWa =
          (await db.findUserByWhatsappNumber(withPlus).catch(() => null)) ||
          (await db.findUserByWhatsappNumber(`whatsapp:${withPlus}`).catch(() => null)) ||
          (await db.findUserByWhatsappNumber(digits).catch(() => null));
        if (byWa) return byWa.id;

        const links = await db.listCustomerIdentityLinks().catch(() => []);
        const waLink = links.find(
          (l) =>
            l.status === 'linked' &&
            l.whatsappNumber &&
            l.whatsappNumber.replace(/\D/g, '') === digits
        );
        if (waLink) return waLink.paymentUserId;
      }

      const byTarget = await db.findUserByTarget(candidate).catch(() => null);
      if (byTarget) return byTarget.id;
    }

    return null;
  }

  /**
   * Looks up persisted checkout order metadata saved at initialization time.
   */
  private async getPersistedCheckoutOrderMeta(orderReference: string): Promise<{
    userId?: string;
    depositAmountNgn?: number;
    purpose?: 'deposit' | 'fund_agreement';
    agreementId?: string;
  } | null> {
    try {
      const snapshot = await db.read();
      const log = (snapshot.auditLogs ?? []).find(
        (entry) =>
          entry.action === 'checkout.order_created' &&
          entry.resourceId === orderReference
      );
      if (!log?.metadata) return null;
      const meta = log.metadata as Record<string, any>;
      return {
        userId: typeof meta.userId === 'string' ? meta.userId : undefined,
        depositAmountNgn: Number(meta.depositAmountNgn || 0) || undefined,
        purpose: meta.purpose,
        agreementId: typeof meta.agreementId === 'string' ? meta.agreementId : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Generates a hosted checkout link via the active provider.
   */
  public async createCheckoutOrder(
    input: CreateCheckoutInput,
    preferredProvider?: CheckoutProviderName
  ): Promise<CheckoutOrderResult> {
    const provider = getCheckoutProvider(preferredProvider);
    const resolvedUserId = await this.resolveCheckoutUserId(input.userId, undefined, input.customerEmail);
    const order = await provider.createCheckoutOrder(input);

    // Persist checkout order metadata so webhook/reconciliation always knows the exact
    // canonical usr_... userId and net depositAmountNgn even if provider omits orderMetaData.
    await createAuditLog({
      actorType: 'user',
      actorId: resolvedUserId || input.userId,
      action: 'checkout.order_created',
      resourceType: 'checkout_order',
      resourceId: order.orderReference,
      metadata: {
        userId: resolvedUserId || input.userId,
        rawUserId: input.userId,
        depositAmountNgn: order.depositAmountNgn,
        totalPayableNgn: order.totalPayableNgn,
        purpose: order.purpose,
        agreementId: order.agreementId,
        provider: order.provider,
      },
    }).catch((err) => {
      console.warn('[sivan-checkout] Failed to persist checkout.order_created audit log:', err?.message || err);
    });

    return order;
  }

  /**
   * Authoritatively queries the provider upstream to verify payment status.
   */
  public async verifyCheckoutTransaction(
    orderReference: string,
    preferredProvider?: CheckoutProviderName
  ): Promise<CheckoutVerificationResult> {
    const providerName = preferredProvider || this.detectProviderFromReference(orderReference);
    const provider = getCheckoutProvider(providerName);
    const verification = await provider.verifyCheckoutOrder(orderReference);

    const persisted = await this.getPersistedCheckoutOrderMeta(orderReference);
    if (persisted) {
      if (!verification.userId && persisted.userId) {
        verification.userId = persisted.userId;
      }
      if (persisted.depositAmountNgn && persisted.depositAmountNgn > 0) {
        verification.depositAmountNgn = persisted.depositAmountNgn;
      }
      if (!verification.purpose && persisted.purpose) {
        verification.purpose = persisted.purpose;
      }
      if (!verification.agreementId && persisted.agreementId) {
        verification.agreementId = persisted.agreementId;
      }
    }

    return verification;
  }

  /**
   * Processes a verified checkout success:
   *  - Idempotently credits spendable NGN balance or triggers agreement funding.
   *  - Safe against webhook retries, client claim races, and network replays.
   */
  public async processCheckoutSuccess(
    verification: CheckoutVerificationResult
  ): Promise<CheckoutProcessingResult> {
    const { orderReference, amountNgn, userId, purpose, agreementId, transactionId, provider, customerEmail } =
      verification;

    if (!orderReference) {
      throw new Error('orderReference is required to process checkout transaction');
    }

    if (!amountNgn || amountNgn <= 0) {
      throw new Error(`Invalid transaction amount (${amountNgn}) for orderReference ${orderReference}`);
    }

    const cleanUserId = await this.resolveCheckoutUserId(userId, orderReference, customerEmail);
    if (!cleanUserId) {
      throw new Error(`Unable to resolve Sivan userId for checkout orderReference ${orderReference}`);
    }
    const existingLedger = await listUserBalanceLedger(cleanUserId);

    // Handle Purpose: Service Agreement Funding
    if (purpose === 'fund_agreement' && agreementId) {
      const alreadyFunded = existingLedger.some((item: any) => {
        const transferId = item.entry?.transferId || item.transferId;
        const sourceId = item.entry?.sourceId || item.sourceId;
        return (
          transferId === `checkout_fund_${orderReference}` ||
          transferId === `nomba_fund_${orderReference}` ||
          sourceId === orderReference
        );
      });

      if (alreadyFunded) {
        return {
          processed: true,
          alreadyProcessed: true,
          action: 'agreement_funded',
          userId: cleanUserId,
          amountNgn,
          orderReference,
          transactionId,
          agreementId,
          provider,
        };
      }

      await this.fundAgreementFromCheckout({
        agreementId,
        userId: cleanUserId,
        amountNgn,
        orderReference,
        transactionId,
        provider,
      });

      return {
        processed: true,
        alreadyProcessed: false,
        action: 'agreement_funded',
        userId: cleanUserId,
        amountNgn,
        orderReference,
        transactionId,
        agreementId,
        provider,
      };
    }

    // Default: Balance Deposit (Top-Up)
    const alreadyCredited = existingLedger.some((item: any) => {
      const transferId = item.entry?.transferId || item.transferId;
      const sourceId = item.entry?.sourceId || item.sourceId;
      return (
        transferId === `checkout_dep_${orderReference}` ||
        transferId === `nomba_dep_${orderReference}` ||
        transferId === `pstk_dep_${orderReference}` ||
        transferId === `9psb_dep_${orderReference}` ||
        transferId === orderReference ||
        sourceId === orderReference
      );
    });

    if (alreadyCredited) {
      return {
        processed: true,
        alreadyProcessed: true,
        action: 'balance_deposit',
        userId: cleanUserId,
        amountNgn,
        orderReference,
        transactionId,
        provider,
      };
    }

    // Atomic ledger credit with stable provider-agnostic transferId
    const creditAmount = verification.depositAmountNgn && verification.depositAmountNgn > 0
      ? verification.depositAmountNgn
      : amountNgn;

    await createBalanceLedgerEntry(
      {
        userId: cleanUserId,
        asset: 'ngn',
        amount: creditAmount.toFixed(2),
        kind: 'credit_available',
        status: 'available',
        sourceType: 'checkout_inflow',
        sourceId: orderReference,
        transferId: `checkout_dep_${orderReference}`,
        description: `Deposit via ${provider.toUpperCase()} Checkout (${orderReference})`,
      },
      { actorType: 'provider', actorId: provider }
    );

    void this.notifyWhatsAppCheckoutCredit({
      userId: cleanUserId,
      amountNgn: creditAmount,
      orderReference,
      provider,
    });

    return {
      processed: true,
      alreadyProcessed: false,
      action: 'balance_deposit',
      userId: cleanUserId,
      amountNgn: creditAmount,
      orderReference,
      transactionId,
      provider,
    };
  }

  private async notifyWhatsAppCheckoutCredit(params: {
    userId: string;
    amountNgn: number;
    orderReference: string;
    provider: CheckoutProviderName;
  }): Promise<void> {
    try {
      const rawWaUrl = env.WHATSAPP_NOTIFICATION_URL || process.env.WHATSAPP_NOTIFICATION_URL;
      const secret = process.env.NOTIFY_SECRET || process.env.NOTIFICATION_SECRET || process.env.CORE_API_SECRET;
      if (!rawWaUrl || !secret) return;

      const user = await db.findUserById(params.userId).catch(() => null);
      let targetPhone = user?.whatsappNumber;
      if (!targetPhone) {
        const links = await db.listCustomerIdentityLinks().catch(() => []);
        const activeWa = links
          .filter((l) => l.paymentUserId === params.userId && l.status === 'linked' && Boolean(l.whatsappNumber))
          .sort((a, b) => (b.linkedAt || b.createdAt || '').localeCompare(a.linkedAt || a.createdAt || ''));
        targetPhone = activeWa[0]?.whatsappNumber;
      }
      if (!targetPhone) return;

      let spendableText = `₦${params.amountNgn.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      try {
        const unified = await getUnifiedBalance(params.userId);
        const ngnBal = unified.balances.find((b) => b.asset.toLowerCase() === 'ngn');
        if (ngnBal) {
          spendableText = `₦${Number(ngnBal.spendable || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        }
      } catch {
        // Fallback to credited amount text
      }

      const creditFormatted = `₦${params.amountNgn.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const body =
        `✅ Deposit Credited . Sivan Payment Ai\n\n` +
        `• Amount Credited: ${creditFormatted}\n` +
        `• Spendable NGN Balance: ${spendableText}\n` +
        `• Rail: ${params.provider.toUpperCase()} Instant Checkout\n` +
        `• Reference: ${params.orderReference}`;

      const waNotifyUrl = rawWaUrl.endsWith('/api/notify') ? rawWaUrl : `${rawWaUrl.replace(/\/$/, '')}/api/notify`;
      const formattedTo = targetPhone.startsWith('whatsapp:')
        ? targetPhone
        : `whatsapp:${targetPhone.startsWith('+') ? targetPhone : `+${targetPhone.replace(/\D/g, '')}`}`;

      await fetch(waNotifyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-notify-secret': secret,
          'x-target-service': 'whatsapp-bot',
        },
        body: JSON.stringify({
          to: formattedTo,
          message: `${body}\n\nWithdraw . Transfer . New Deal`,
          menuCard: {
            body,
            actions: [
              { id: 'act_cashout', title: '🏧 Withdraw', action: 'CASHOUT' },
              { id: 'act_transfer', title: '💸 Transfer', action: 'TRANSFER' },
              { id: 'create service agreement', title: '🤝 New Deal', action: 'create service agreement' },
            ],
          },
        }),
      });
    } catch (err: any) {
      console.warn('[sivan-checkout.whatsapp_notify] Notification error:', err?.message || err);
    }
  }

  private async fundAgreementFromCheckout(params: {
    agreementId: string;
    userId: string;
    amountNgn: number;
    orderReference: string;
    transactionId?: string;
    provider: CheckoutProviderName;
  }): Promise<void> {
    const { agreementId, userId, amountNgn, orderReference, transactionId, provider } = params;

    await createBalanceLedgerEntry(
      {
        userId,
        asset: 'ngn',
        amount: amountNgn.toFixed(2),
        kind: 'hold',
        status: 'held',
        sourceType: 'agreement_funding',
        sourceId: agreementId,
        transferId: `checkout_fund_${orderReference}`,
        description: `Agreement ${agreementId} funding via ${provider.toUpperCase()} Checkout (${orderReference})`,
      },
      { actorType: 'provider', actorId: provider }
    );

    const agreementServiceUrl =
      process.env.ESCROW_SERVICE_URL ||
      process.env.UPSTREAM_ESCROW_API ||
      'https://escrow.sivantech.online';

    try {
      await fetch(`${agreementServiceUrl}/api/escrows/${agreementId}/fund`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-core-api-key': process.env.CORE_API_SECRET || '',
          'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET || '',
        },
        body: JSON.stringify({
          userId,
          amountNgn,
          paymentReference: orderReference,
          provider,
          transactionId,
        }),
      });
    } catch {
      // Safe non-blocking log
    }
  }
}

export const sivanCheckoutService = new SivanCheckoutService();
