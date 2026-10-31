import type {
  IProviderReconciliationAdapter,
  VerifiedDepositOutcome,
  VerifiedTransferOutcome,
} from '../reconciliation-adapter.interface.js';
import { getNgnProvider } from '../../../ngn/provider/ngn-provider-registry.js';

export class BreetReconciliationAdapter implements IProviderReconciliationAdapter {
  readonly providerId = 'breet';
  readonly displayName = 'Breet Crypto-to-Fiat Settlement';

  isConfigured(): boolean {
    return Boolean(process.env.BREET_API_KEY && process.env.BREET_SECRET_KEY);
  }

  async verifyInboundDeposit(reference: string): Promise<VerifiedDepositOutcome> {
    // Inbound crypto is handled via wallet deposits, but if queried for crypto trade reference:
    return {
      provider: this.providerId,
      reference,
      verified: false,
      amount: 0,
      currency: 'USDT',
      status: 'pending',
      error: 'Breet is an off-ramp conversion partner; use verifyOutboundTransfer for cashouts',
    };
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
        error: 'Breet credentials are not configured',
      };
    }

    try {
      const provider = getNgnProvider('breet');
      const transfer = await provider.getTransfer(reference);

      if (!transfer || !transfer.status) {
        return {
          provider: this.providerId,
          reference,
          verified: false,
          amount: 0,
          currency: 'NGN',
          status: 'failed',
          error: 'Transfer record not found on Breet',
        };
      }

      const statusStr = String(transfer.status || '').toLowerCase();
      let status: VerifiedTransferOutcome['status'] = 'processing';
      if (statusStr === 'completed' || statusStr === 'success') status = 'completed';
      else if (statusStr === 'failed' || statusStr === 'cancelled') status = 'failed';
      else if (statusStr === 'reversed') status = 'reversed';

      return {
        provider: this.providerId,
        reference,
        verified: true,
        amount: Number(transfer.destinationAmount || transfer.sourceAmount || 0),
        currency: 'NGN',
        status,
        recipientAccount: (transfer.metadata as any)?.destinationAccount,
        recipientBank: (transfer.metadata as any)?.destinationBank,
        settledAt: transfer.completedAt || transfer.updatedAt,
        rawMetadata: transfer,
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
