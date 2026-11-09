import { createHash, randomBytes } from 'node:crypto';
import { db } from '../database/json-database.js';
import type {
  OnchainClaimRecord,
  OnchainClaimSummary,
  PublicClaimPreview,
  SupportedClaimAsset,
  SupportedClaimNetwork,
  ClaimCancelReason,
} from './claim.types.js';

function hashClaimCode(code: string): string {
  return createHash('sha256').update(code.trim()).digest('hex');
}

function generateClaimCode(): string {
  // 6-digit numeric PIN, e.g. 482910
  const num = Math.floor(100000 + Math.random() * 900000);
  return String(num);
}

function generateToken(): string {
  return `sclaim_${randomBytes(16).toString('hex')}`;
}

export class ClaimService {
  /**
   * Helper to map an internal record to an OnchainClaimSummary
   */
  static toSummary(record: OnchainClaimRecord): OnchainClaimSummary {
    const phone = record.recipientPhone.replace(/\D/g, '');
    const last4 = phone.slice(-4) || '****';
    const isExpired = new Date(record.expiresAt).getTime() <= Date.now();
    const status = isExpired && record.status === 'AWAITING_CLAIM' ? 'EXPIRED' : record.status;

    return {
      id: record.id,
      status,
      amount: record.amount,
      asset: record.asset,
      network: record.network,
      recipientPhoneLast4: last4,
      token: record.token,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      canCancel: status === 'AWAITING_CLAIM',
      cancelReason: record.cancelReason,
      codeLocked: status !== 'AWAITING_CLAIM',
    };
  }

  /**
   * Create a new transit claim.
   * Locks the sender's funds and returns the one-time 6-digit claim code.
   */
  static async createClaim(params: {
    userId: string;
    recipientPhone: string;
    amount: string;
    asset?: SupportedClaimAsset;
    network?: SupportedClaimNetwork;
    idempotencyKey?: string;
    pin?: string;
  }): Promise<{ claim: OnchainClaimSummary; claimCode: string; replay: boolean }> {
    const rawData = await (db as any).read();
    if (!rawData.onchainClaims) {
      rawData.onchainClaims = [];
    }

    // Check idempotency replay
    if (params.idempotencyKey) {
      const existing = rawData.onchainClaims.find(
        (c: OnchainClaimRecord) =>
          c.senderUserId === params.userId && c.idempotencyKey === params.idempotencyKey
      );
      if (existing) {
        return {
          claim: ClaimService.toSummary(existing),
          claimCode: '******',
          replay: true,
        };
      }
    }

    const sender = await db.findUserById(params.userId);
    if (!sender) {
      throw new Error(`Sender user ${params.userId} not found`);
    }

    const numAmount = parseFloat(params.amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      throw new Error('Amount must be a positive number');
    }

    const asset: SupportedClaimAsset = (params.asset?.toLowerCase() as SupportedClaimAsset) || 'usdc';
    const network: SupportedClaimNetwork = (params.network?.toLowerCase() as SupportedClaimNetwork) || 'near';

    const claimCode = generateClaimCode();
    const claimCodeHash = hashClaimCode(claimCode);
    const token = generateToken();
    const id = `clm_${randomBytes(12).toString('hex')}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

    const record: OnchainClaimRecord = {
      id,
      senderUserId: params.userId,
      senderPhone: sender.phone || sender.whatsappNumber,
      recipientPhone: params.recipientPhone.trim(),
      amount: numAmount.toFixed(6),
      asset,
      network,
      status: 'AWAITING_CLAIM',
      claimCodeHash,
      token,
      createdAt: now.toISOString(),
      expiresAt,
      idempotencyKey: params.idempotencyKey,
    };

    await (db as any).mutate((data: any) => {
      if (!data.onchainClaims) data.onchainClaims = [];
      data.onchainClaims.push(record);
      return record;
    });

    return {
      claim: ClaimService.toSummary(record),
      claimCode,
      replay: false,
    };
  }

  /**
   * List awaiting or active claims created by a user.
   */
  static async listClaims(userId: string): Promise<OnchainClaimSummary[]> {
    const rawData = await (db as any).read();
    const all: OnchainClaimRecord[] = rawData.onchainClaims || [];
    const userClaims = all
      .filter((c) => c.senderUserId === userId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return userClaims.map(ClaimService.toSummary);
  }

  /**
   * Cancel and Claim-Back: Sender reclaims locked funds.
   */
  static async cancelClaim(
    userId: string,
    claimId: string,
    reason?: ClaimCancelReason | string
  ): Promise<OnchainClaimSummary> {
    const rawData = await (db as any).read();
    const all: OnchainClaimRecord[] = rawData.onchainClaims || [];
    const claim = all.find((c) => c.id === claimId && c.senderUserId === userId);

    if (!claim) {
      throw new Error('Claim not found or unauthorized');
    }

    if (claim.status !== 'AWAITING_CLAIM') {
      throw new Error(`Cannot cancel claim in status ${claim.status}`);
    }

    claim.status = 'CANCELLED';
    claim.cancelledAt = new Date().toISOString();
    claim.cancelReason = reason || 'changed_my_mind';

    await (db as any).mutate((data: any) => {
      const idx = (data.onchainClaims || []).findIndex((c: OnchainClaimRecord) => c.id === claimId);
      if (idx >= 0) {
        data.onchainClaims[idx] = claim;
      }
      return claim;
    });

    return ClaimService.toSummary(claim);
  }

  /**
   * Find a claim by its deep-link token.
   */
  static async findByToken(token: string): Promise<OnchainClaimRecord | null> {
    const rawData = await (db as any).read();
    const all: OnchainClaimRecord[] = rawData.onchainClaims || [];
    return all.find((c) => c.token === token) || null;
  }

  /**
   * Public preview for recipients (sanitized).
   */
  static async getPublicPreview(token: string): Promise<PublicClaimPreview> {
    const claim = await ClaimService.findByToken(token);
    if (!claim) {
      throw new Error('Claim not found');
    }

    const rPhone = claim.recipientPhone.replace(/\D/g, '');
    const sPhone = (claim.senderPhone || '').replace(/\D/g, '');

    return {
      token: claim.token,
      amount: claim.amount,
      asset: claim.asset,
      network: claim.network,
      senderPhoneLast4: sPhone ? sPhone.slice(-4) : undefined,
      recipientPhoneLast4: rPhone.slice(-4) || '****',
      status: claim.status,
      expiresAt: claim.expiresAt,
    };
  }

  /**
   * Redeem a claim with 6-digit code.
   */
  static async redeemClaim(params: {
    token: string;
    code: string;
    recipientPhone?: string;
    recipientUserId?: string;
  }): Promise<OnchainClaimSummary> {
    const rawData = await (db as any).read();
    const all: OnchainClaimRecord[] = rawData.onchainClaims || [];
    const claim = all.find((c) => c.token === params.token);

    if (!claim) {
      throw new Error('Claim not found');
    }

    if (claim.status !== 'AWAITING_CLAIM') {
      throw new Error(`Claim is already ${claim.status.toLowerCase()}`);
    }

    if (new Date(claim.expiresAt).getTime() <= Date.now()) {
      claim.status = 'EXPIRED';
      throw new Error('Claim has expired');
    }

    // Verify 6-digit PIN hash
    const inputHash = hashClaimCode(params.code);
    if (inputHash !== claim.claimCodeHash) {
      throw new Error('Invalid 6-digit claim code');
    }

    claim.status = 'CLAIMED';
    claim.claimedAt = new Date().toISOString();
    claim.claimedByPhone = params.recipientPhone;
    claim.claimedByUserId = params.recipientUserId;

    await (db as any).mutate((data: any) => {
      const idx = (data.onchainClaims || []).findIndex((c: OnchainClaimRecord) => c.token === params.token);
      if (idx >= 0) {
        data.onchainClaims[idx] = claim;
      }
      return claim;
    });

    return ClaimService.toSummary(claim);
  }
}
