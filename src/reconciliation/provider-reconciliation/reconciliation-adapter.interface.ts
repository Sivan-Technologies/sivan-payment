export interface VerifiedDepositOutcome {
  provider: string;
  reference: string;
  verified: boolean;
  amount: number;
  currency: string;
  status: 'success' | 'pending' | 'failed';
  customerId?: string;
  customerAccount?: string;
  customerEmail?: string;
  paidAt?: string;
  rawMetadata?: unknown;
  error?: string;
}

export interface VerifiedTransferOutcome {
  provider: string;
  reference: string;
  verified: boolean;
  amount: number;
  currency: string;
  status: 'completed' | 'processing' | 'failed' | 'reversed';
  recipientAccount?: string;
  recipientBank?: string;
  failureReason?: string;
  settledAt?: string;
  rawMetadata?: unknown;
  error?: string;
}

export interface IProviderReconciliationAdapter {
  readonly providerId: string;
  readonly displayName: string;

  verifyInboundDeposit(reference: string): Promise<VerifiedDepositOutcome>;
  verifyOutboundTransfer(reference: string): Promise<VerifiedTransferOutcome>;
  fetchRecentSettlements?(sinceIso: string): Promise<Array<VerifiedDepositOutcome | VerifiedTransferOutcome>>;
  isConfigured(): boolean;
}
