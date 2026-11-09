export type SupportedClaimNetwork = 'solana' | 'celo' | 'base' | 'stellar' | 'near';
export type SupportedClaimAsset = 'usdc' | 'eurc' | 'ngn';

export type OnchainClaimStatus =
  | 'AWAITING_CLAIM'
  | 'CLAIMED'
  | 'CANCELLED'
  | 'EXPIRED';

export const CLAIM_CANCEL_REASONS = [
  'wrong_phone_number',
  'recipient_no_response',
  'wrong_amount_or_network',
  'changed_my_mind',
] as const;

export type ClaimCancelReason = (typeof CLAIM_CANCEL_REASONS)[number];

export interface OnchainClaimRecord {
  id: string; // e.g. clm_...
  senderUserId: string;
  senderPhone?: string;
  recipientPhone: string;
  amount: string; // decimal string e.g. "10.000000"
  asset: SupportedClaimAsset;
  network: SupportedClaimNetwork;
  sourceNetwork?: SupportedClaimNetwork;
  settlementNetwork?: SupportedClaimNetwork;
  status: OnchainClaimStatus;
  claimCodeHash: string; // SHA-256 hash of the 6-digit code
  token: string; // public URL token e.g. sclaim_...
  createdAt: string;
  expiresAt: string;
  claimedAt?: string;
  claimedByUserId?: string;
  claimedByPhone?: string;
  cancelledAt?: string;
  cancelReason?: ClaimCancelReason | string;
  idempotencyKey?: string;
}

export interface OnchainClaimSummary {
  id: string;
  status: OnchainClaimStatus;
  amount: string;
  asset: SupportedClaimAsset;
  network: SupportedClaimNetwork;
  sourceNetwork?: SupportedClaimNetwork;
  settlementNetwork?: SupportedClaimNetwork;
  recipientPhoneLast4: string;
  token?: string;
  expiresAt: string;
  createdAt: string;
  canCancel: boolean;
  cancelReason?: string;
  codeLocked: boolean;
}

export interface PublicClaimPreview {
  token: string;
  claimId?: string;
  amount: string;
  asset: SupportedClaimAsset;
  network: SupportedClaimNetwork;
  sourceNetwork?: SupportedClaimNetwork;
  settlementNetwork?: SupportedClaimNetwork;
  senderName?: string;
  senderPhoneLast4?: string;
  recipientPhoneLast4: string;
  status: OnchainClaimStatus | string;
  isExpired?: boolean;
  expiresAt: string;
}
