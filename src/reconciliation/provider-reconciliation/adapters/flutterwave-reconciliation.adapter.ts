import type {
  IProviderReconciliationAdapter,
  VerifiedDepositOutcome,
  VerifiedTransferOutcome,
} from '../reconciliation-adapter.interface.js';

export class FlutterwaveReconciliationAdapter implements IProviderReconciliationAdapter {
  readonly providerId = 'flutterwave';
  readonly displayName = 'Flutterwave Payments Rail';

  isConfigured(): boolean {
    return Boolean(process.env.FLW_SECRET_KEY || process.env.FLUTTERWAVE_SECRET_KEY);
  }

  private secretKey(): string {
    return process.env.FLW_SECRET_KEY || process.env.FLUTTERWAVE_SECRET_KEY || '';
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
        error: 'Flutterwave is not configured in environment',
      };
    }

    try {
      const url = `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.secretKey()}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        return {
          provider: this.providerId,
          reference,
          verified: false,
          amount: 0,
          currency: 'NGN',
          status: 'failed',
          error: `Flutterwave verification returned ${response.status}`,
        };
      }

      const json = await response.json() as {
        status?: string;
        data?: {
          status?: string;
          amount?: number;
          currency?: string;
          customer?: { email?: string; name?: string };
          created_at?: string;
        };
      };

      const tx = json.data;
      const isSuccess = tx?.status?.toLowerCase() === 'successful';

      return {
        provider: this.providerId,
        reference,
        verified: isSuccess,
        amount: Number(tx?.amount) || 0,
        currency: tx?.currency || 'NGN',
        status: isSuccess ? 'success' : 'failed',
        customerEmail: tx?.customer?.email,
        paidAt: tx?.created_at,
        rawMetadata: json,
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
        error: 'Flutterwave is not configured in environment',
      };
    }

    try {
      const url = `https://api.flutterwave.com/v3/transfers/${encodeURIComponent(reference)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.secretKey()}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        return {
          provider: this.providerId,
          reference,
          verified: false,
          amount: 0,
          currency: 'NGN',
          status: 'failed',
          error: `Flutterwave transfer lookup returned ${response.status}`,
        };
      }

      const json = await response.json() as {
        data?: {
          status?: string;
          amount?: number;
          currency?: string;
          account_number?: string;
          bank_name?: string;
          complete_message?: string;
        };
      };

      const tf = json.data;
      const statusStr = tf?.status?.toLowerCase() || 'processing';
      let status: VerifiedTransferOutcome['status'] = 'processing';
      if (statusStr === 'successful') status = 'completed';
      else if (statusStr === 'failed') status = 'failed';
      else if (statusStr === 'reversed') status = 'reversed';

      return {
        provider: this.providerId,
        reference,
        verified: true,
        amount: Number(tf?.amount) || 0,
        currency: tf?.currency || 'NGN',
        status,
        recipientAccount: tf?.account_number,
        recipientBank: tf?.bank_name,
        failureReason: tf?.complete_message,
        rawMetadata: json,
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
