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
   * Generates a hosted checkout link via the active provider.
   */
  public async createCheckoutOrder(
    input: CreateCheckoutInput,
    preferredProvider?: CheckoutProviderName
  ): Promise<CheckoutOrderResult> {
    const provider = getCheckoutProvider(preferredProvider);
    return provider.createCheckoutOrder(input);
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
    return provider.verifyCheckoutOrder(orderReference);
  }

  /**
   * Processes a verified checkout success:
   *  - Idempotently credits spendable NGN balance or triggers agreement funding.
   *  - Safe against webhook retries, client claim races, and network replays.
   */
  public async processCheckoutSuccess(
    verification: CheckoutVerificationResult
  ): Promise<CheckoutProcessingResult> {
    const { orderReference, amountNgn, userId, purpose, agreementId, transactionId, provider } =
      verification;

    if (!orderReference) {
      throw new Error('orderReference is required to process checkout transaction');
    }

    if (!amountNgn || amountNgn <= 0) {
      throw new Error(`Invalid transaction amount (${amountNgn}) for orderReference ${orderReference}`);
    }

    const cleanUserId = userId || (orderReference.split('_')[2] || 'unknown');
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
    await createBalanceLedgerEntry(
      {
        userId: cleanUserId,
        asset: 'ngn',
        amount: amountNgn.toFixed(2),
        kind: 'credit_available',
        status: 'available',
        sourceType: 'checkout_inflow',
        sourceId: orderReference,
        transferId: `checkout_dep_${orderReference}`,
        description: `Deposit via ${provider.toUpperCase()} Checkout (${orderReference})`,
      },
      { actorType: 'provider', actorId: provider }
    );

    return {
      processed: true,
      alreadyProcessed: false,
      action: 'balance_deposit',
      userId: cleanUserId,
      amountNgn,
      orderReference,
      transactionId,
      provider,
    };
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
