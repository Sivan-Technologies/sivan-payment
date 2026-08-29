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
