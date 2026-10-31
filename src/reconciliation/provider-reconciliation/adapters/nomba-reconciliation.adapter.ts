import type {
  IProviderReconciliationAdapter,
  VerifiedDepositOutcome,
  VerifiedTransferOutcome,
} from '../reconciliation-adapter.interface.js';

export class NombaReconciliationAdapter implements IProviderReconciliationAdapter {
  readonly providerId = 'nomba';
  readonly displayName = 'Nomba Payments Rail';

  isConfigured(): boolean {
    return Boolean(
      process.env.NOMBA_ACCOUNT_ID &&
      process.env.NOMBA_CLIENT_ID &&
      process.env.NOMBA_CLIENT_SECRET
    );
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
        error: 'Nomba is not configured in environment',
      };
    }

    try {
      const baseUrl = process.env.NOMBA_BASE_URL || 'https://api.nomba.com/v1';
      const response = await fetch(`${baseUrl}/checkout/transaction/${encodeURIComponent(reference)}`, {
        method: 'GET',
        headers: {
          'accountId': process.env.NOMBA_ACCOUNT_ID || '',
          'Authorization': `Bearer ${process.env.NOMBA_CLIENT_SECRET || ''}`,
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
          error: `Nomba verification returned status ${response.status}`,
        };
      }

      const json = await response.json() as {
        status?: string;
        data?: { status?: string; amount?: number; currency?: string };
      };

      const tx = json.data;
      const isSuccess = tx?.status?.toLowerCase() === 'success';

      return {
        provider: this.providerId,
        reference,
        verified: isSuccess,
        amount: Number(tx?.amount) || 0,
        currency: tx?.currency || 'NGN',
        status: isSuccess ? 'success' : 'failed',
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
        error: 'Nomba is not configured in environment',
      };
    }

    try {
      const baseUrl = process.env.NOMBA_BASE_URL || 'https://api.nomba.com/v1';
      const response = await fetch(`${baseUrl}/transfers/bank/${encodeURIComponent(reference)}`, {
        method: 'GET',
        headers: {
          'accountId': process.env.NOMBA_ACCOUNT_ID || '',
          'Authorization': `Bearer ${process.env.NOMBA_CLIENT_SECRET || ''}`,
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
          error: `Nomba transfer lookup returned status ${response.status}`,
        };
      }

      const json = await response.json() as {
        data?: { status?: string; amount?: number; currency?: string };
      };

      const statusStr = json.data?.status?.toLowerCase() || 'processing';
      let status: VerifiedTransferOutcome['status'] = 'processing';
      if (statusStr === 'success' || statusStr === 'completed') status = 'completed';
      else if (statusStr === 'failed') status = 'failed';
      else if (statusStr === 'reversed') status = 'reversed';

      return {
        provider: this.providerId,
        reference,
        verified: true,
        amount: Number(json.data?.amount) || 0,
        currency: json.data?.currency || 'NGN',
        status,
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

