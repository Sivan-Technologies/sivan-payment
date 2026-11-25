import dns from 'node:dns';

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // Ignore on older Node runtimes
}

import type {
  IProviderReconciliationAdapter,
  VerifiedDepositOutcome,
  VerifiedTransferOutcome,
} from '../reconciliation-adapter.interface.js';
import { NombaCheckoutProvider } from '../../../ngn/provider/nomba-checkout.provider.js';

const nombaCheckoutProvider = new NombaCheckoutProvider();

export class NombaReconciliationAdapter implements IProviderReconciliationAdapter {
  readonly providerId = 'nomba';
  readonly displayName = 'Nomba Payments Rail';

  isConfigured(): boolean {
    return Boolean(
      (process.env.NOMBA_ACCOUNT_ID || process.env.NOMBA_LIVE_ACCOUNT_ID) &&
      (process.env.NOMBA_CLIENT_ID || process.env.NOMBA_LIVE_CLIENT_ID) &&
      (process.env.NOMBA_CLIENT_SECRET || process.env.NOMBA_LIVE_CLIENT_SECRET)
    );
  }

  private baseUrl(): string {
    const raw = process.env.NOMBA_LIVE_BASE_URL || process.env.NOMBA_BASE_URL || 'https://api.nomba.com';
    return raw.replace(/\/v[12]\/?$/, '').replace(/\/+$/, '');
  }

  private async getAccessToken(): Promise<string> {
    const accountId = process.env.NOMBA_ACCOUNT_ID || process.env.NOMBA_LIVE_ACCOUNT_ID || '';
    const clientId = process.env.NOMBA_CLIENT_ID || process.env.NOMBA_LIVE_CLIENT_ID || '';
    const clientSecret = process.env.NOMBA_CLIENT_SECRET || process.env.NOMBA_LIVE_CLIENT_SECRET || '';

    const res = await fetch(`${this.baseUrl()}/v1/auth/token/issue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accountId,
        'User-Agent': 'Sivan-Payment-Engine/1.0 (Borderless Autonomous Payment Protocol; support@sivantech.online)',
      },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Nomba token issuance failed with status ${res.status}: ${text}`);
    }

    const payload = (await res.json()) as { data?: { access_token?: string }; access_token?: string };
    const token = payload?.data?.access_token || payload?.access_token;
    if (!token) {
      throw new Error('Nomba token response missing access_token');
    }
    return token;
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
      const result = await nombaCheckoutProvider.verifyCheckoutOrder(reference);
      const isSuccess = result.verified && result.status === 'SUCCESS';
      const netDepositAmount =
        result.depositAmountNgn && result.depositAmountNgn > 0
          ? result.depositAmountNgn
          : result.amountNgn;

      return {
        provider: this.providerId,
        reference,
        verified: isSuccess,
        amount: isSuccess ? Number(netDepositAmount) || 0 : 0,
        currency: 'NGN',
        status: isSuccess ? 'success' : (result.status === 'PENDING' ? 'pending' : 'failed'),
        customerId: result.userId,
        customerEmail: result.customerEmail,
        rawMetadata: result.raw,
        ...(isSuccess ? {} : { error: `Nomba verification status: ${result.status}` }),
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
      const token = await this.getAccessToken();
      const accountId = process.env.NOMBA_ACCOUNT_ID || process.env.NOMBA_LIVE_ACCOUNT_ID || '';
      const response = await fetch(`${this.baseUrl()}/v1/transfers/bank/${encodeURIComponent(reference)}`, {
        method: 'GET',
        headers: {
          accountId,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Sivan-Payment-Engine/1.0 (Borderless Autonomous Payment Protocol; support@sivantech.online)',
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

