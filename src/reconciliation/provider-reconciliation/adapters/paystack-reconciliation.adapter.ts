import { isPaystackConfigured, paystackBaseUrl, paystackHeaders } from '../../../config/paystackConfig.js';
import type {
  IProviderReconciliationAdapter,
  VerifiedDepositOutcome,
  VerifiedTransferOutcome,
} from '../reconciliation-adapter.interface.js';

export class PaystackReconciliationAdapter implements IProviderReconciliationAdapter {
  readonly providerId = 'paystack';
  readonly displayName = 'Paystack Payments & Transfers';

  isConfigured(): boolean {
    return isPaystackConfigured();
  }

  async verifyInboundDeposit(reference: string): Promise<VerifiedDepositOutcome> {
    if (!this.isConfigured()) {
      return {
        provider: this.providerId,
        reference,
        verified: false,
        amount: 0,
        currency: 'NGN',
        status: 'failed',
        error: 'Paystack is not configured in environment',
      };
    }

    try {
      const url = `${paystackBaseUrl()}/transaction/verify/${encodeURIComponent(reference)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: paystackHeaders(),
      });

      if (!response.ok) {
        const text = await response.text();
        return {
          provider: this.providerId,
          reference,
          verified: false,
          amount: 0,
          currency: 'NGN',
          status: 'failed',
          error: `Paystack verification returned ${response.status}: ${text.slice(0, 150)}`,
        };
      }

      const json = await response.json() as {
        status: boolean;
        message?: string;
        data?: {
          status: string;
          amount: number;
          currency: string;
          paid_at?: string;
          customer?: { email?: string; customer_code?: string };
          metadata?: unknown;
        };
      };

      if (!json.status || !json.data) {
        return {
          provider: this.providerId,
          reference,
          verified: false,
          amount: 0,
          currency: 'NGN',
          status: 'failed',
          error: json.message || 'Transaction not found on Paystack',
        };
      }

      const tx = json.data;
      const status = tx.status === 'success' ? 'success' : tx.status === 'pending' ? 'pending' : 'failed';
      const amountNgn = (Number(tx.amount) || 0) / 100;

      return {
        provider: this.providerId,
        reference,
        verified: status === 'success',
        amount: amountNgn,
        currency: tx.currency || 'NGN',
        status,
        customerEmail: tx.customer?.email,
        customerId: tx.customer?.customer_code,
        paidAt: tx.paid_at,
        rawMetadata: tx,
      };
    } catch (err) {
      return {
        provider: this.providerId,
        reference,
        verified: false,
        amount: 0,
        currency: 'NGN',
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async verifyOutboundTransfer(reference: string): Promise<VerifiedTransferOutcome> {
    if (!this.isConfigured()) {
      return {
        provider: this.providerId,
        reference,
        verified: false,
        amount: 0,
        currency: 'NGN',
        status: 'failed',
        error: 'Paystack is not configured in environment',
      };
    }

    try {
      const url = `${paystackBaseUrl()}/transfer/verify/${encodeURIComponent(reference)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: paystackHeaders(),
      });

      if (!response.ok) {
        const text = await response.text();
        return {
          provider: this.providerId,
          reference,
          verified: false,
          amount: 0,
          currency: 'NGN',
          status: 'failed',
          error: `Paystack transfer verification returned ${response.status}: ${text.slice(0, 150)}`,
        };
      }

      const json = await response.json() as {
        status: boolean;
        message?: string;
        data?: {
          status: string;
          amount: number;
          currency: string;
          transferred_at?: string;
          recipient?: {
            details?: { account_number?: string; bank_name?: string };
          };
          reason?: string;
        };
      };

      if (!json.status || !json.data) {
        return {
          provider: this.providerId,
          reference,
          verified: false,
          amount: 0,
          currency: 'NGN',
          status: 'failed',
          error: json.message || 'Transfer record not found on Paystack',
        };
      }

      const tf = json.data;
      let status: VerifiedTransferOutcome['status'] = 'processing';
      if (tf.status === 'success') status = 'completed';
      else if (tf.status === 'failed') status = 'failed';
      else if (tf.status === 'reversed') status = 'reversed';

      return {
        provider: this.providerId,
        reference,
        verified: true,
        amount: (Number(tf.amount) || 0) / 100,
        currency: tf.currency || 'NGN',
        status,
        recipientAccount: tf.recipient?.details?.account_number,
        recipientBank: tf.recipient?.details?.bank_name,
        failureReason: tf.reason,
        settledAt: tf.transferred_at,
        rawMetadata: tf,
      };
    } catch (err) {
      return {
        provider: this.providerId,
        reference,
        verified: false,
        amount: 0,
        currency: 'NGN',
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

