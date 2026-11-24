/**
 * SIVAN CHECKOUT PROVIDER INTERFACE
 *
 * Pluggable abstraction contract for all hosted checkout, card payment,
 * dynamic bank transfer, and direct inflow rails.
 *
 * Sivan payment Ai is not hardcoded to any single aggregator.
 * Providers (Nomba, 9PSB, Paystack, Flutterwave) implement this contract.
 */

export type CheckoutProviderName = 'nomba' | '9psb' | 'paystack' | string;

export interface CreateCheckoutInput {
  userId: string;
  amountNgn: number;
  customerEmail?: string;
  purpose: 'deposit' | 'fund_agreement';
  agreementId?: string;
  callbackUrl?: string;
  allowedPaymentMethods?: string[];
  orderReference?: string;
}

export interface CheckoutOrderResult {
  provider: CheckoutProviderName;
  checkoutLink: string;
  orderReference: string;
  amountNgn: number;
  depositAmountNgn?: number;
  sivanFeeNgn?: number;
  providerFeeNgn?: number;
  totalFeeNgn?: number;
  totalPayableNgn?: number;
  currency: 'NGN';
  allowedPaymentMethods: string[];
  purpose: 'deposit' | 'fund_agreement';
  agreementId?: string;
}

export interface CheckoutVerificationResult {
  provider: CheckoutProviderName;
  verified: boolean;
  status: 'SUCCESS' | 'PENDING' | 'FAILED';
  amountNgn: number;
  depositAmountNgn?: number;
  orderReference: string;
  transactionId?: string;
  customerEmail?: string;
  paymentMethod?: string;
  purpose?: string;
  userId?: string;
  agreementId?: string;
  raw?: any;
}

export interface ICheckoutProvider {
  readonly name: CheckoutProviderName;

  /**
   * Whether this provider has required credentials configured in the environment.
   */
  isConfigured(): boolean;

  /**
   * Initializes a checkout order / session and returns a hosted payment link.
   */
  createCheckoutOrder(input: CreateCheckoutInput): Promise<CheckoutOrderResult>;

  /**
   * Authoritatively re-queries the transaction status from the provider upstream.
   */
  verifyCheckoutOrder(orderReference: string): Promise<CheckoutVerificationResult>;
}
