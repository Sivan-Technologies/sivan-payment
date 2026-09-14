import { WalletChain } from '../database/types.js';

export interface DeveloperApiKey {
  keyId: string;
  secretKey: string;
  name: string;
  environment: 'test' | 'live';
  rateLimitPerMin: number;
  createdAt: string;
}

export interface DeveloperTransferRequest {
  userId: string;
  destinationAddress: string;
  network: WalletChain;
  asset: 'usdc' | 'usdt' | 'cusd';
  amount: number;
  memo?: string;
}

export interface DeveloperTransferResponse {
  success: boolean;
  transferId: string;
  txHash: string;
  network: WalletChain;
  asset: string;
  amount: number;
  fee?: number;
  netAmount?: number;
  feeWallet?: string;
  feeTxHash?: string;
  feeSponsored: boolean;
  explorerUrl: string;
  timestamp: string;
}

export interface DeveloperAgreementRequest {
  title: string;
  buyerUserId: string;
  sellerUserId: string;
  sellerAddress?: string;
  network: WalletChain;
  currency: 'USDC' | 'CUSD';
  amount: number;
  inspectionWindowDays?: number;
  /** Optional explicit delivery deadline in days. If omitted, Sivan extracts the
   *  deadline from the title/description via natural language parsing (default 3 days). */
  deadlineDays?: number;
  /** Optional description used for natural language deadline extraction. */
  description?: string;
}

export interface DeveloperAgreementResponse {
  success: boolean;
  agreementId: string;
  status: string;
  amount: number;
  network: WalletChain;
  currency: string;
  paymentInstruction: {
    depositAddress: string;
    memo?: string;
  };
  createdAt: string;
  /** Number of calendar days extracted (or supplied) for delivery. */
  deadlineDays: number;
  /** ISO timestamp when delivery is due, computed after funding. Null until funded. */
  deliveryDueAt: string | null;
  /** Live countdown badge label for the chat card. */
  countdownLabel: string;
  /** Sivan Service Agreement Platform Fee breakdown */
  fee?: {
    feeAmount: number;
    feePercent: number;
    feePayer: string;
    buyerTotalPayable: number;
    sellerNetAmount: number;
  };
}

export interface DeveloperSettleRequest {
  agreementId: string;
  actor: string;
  releaseNotes?: string;
}

export interface DeveloperSettleResponse {
  success: boolean;
  agreementId: string;
  status: string;
  releasedAmount: number;
  feeDeducted: number;
  settlementTxHash: string;
  explorerUrl: string;
  timestamp: string;
}

export interface DeveloperBalanceResponse {
  userId: string;
  totalUsdc: number;
  breakdown: Record<string, number>;
  currency: 'USD';
}
