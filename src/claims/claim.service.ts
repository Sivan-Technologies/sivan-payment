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

async function dispatchClaimInviteWhatsApp(record: OnchainClaimRecord, senderName: string): Promise<void> {
  try {
    const isLive = process.env.NODE_ENV === 'production' || process.env.DATABASE_MODE === 'live';
    const gatewayUrl = (
      process.env.CORE_API_BASE_URL ||
      process.env.API_GATEWAY_URL ||
      (isLive ? 'https://api.sivantech.online' : 'https://api-staging.sivantech.online')
    ).replace(/\/$/, '');
    const secret = process.env.NOTIFY_SECRET || process.env.NOTIFICATION_SECRET || process.env.CORE_API_SECRET;
    if (!secret) return;

    const rawWaUrl = process.env.WHATSAPP_NOTIFICATION_URL || `${gatewayUrl}/api/whatsapp`;
    const waNotifyUrl = rawWaUrl.endsWith('/api/notify') ? rawWaUrl : `${rawWaUrl.replace(/\/$/, '')}/api/notify`;

    const cleanPhone = record.recipientPhone.replace(/\D/g, '');
    const formattedPhone = `whatsapp:+${cleanPhone}`;
    const appUrl = (process.env.CUSTOMER_APP_URL || 'https://app.sivantech.online').replace(/\/$/, '');
    const claimUrl = `${appUrl}/claim?token=${encodeURIComponent(record.token)}`;
    const officialWaNumber = (
      process.env.WHATSAPP_PREFILL_PHONE_NUMBER ||
      process.env.LIVE_WHATSAPP_PREFILL_PHONE_NUMBER ||
      process.env.OFFICIAL_WHATSAPP_PHONE ||
      process.env.WHATSAPP_BOT_PHONE ||
      ''
    ).replace(/\D/g, '');

    const textLines = [
      `🎁 Transfer in Transit`,
      ``,
      `${senderName} sent you ${Number(record.amount).toFixed(2)} ${record.asset.toUpperCase()} on ${record.network.toUpperCase()} Protocol.`,
      ``,
    ];

    if (officialWaNumber) {
      const waClaimLink = `https://wa.me/${officialWaNumber}?text=CLAIM%20${encodeURIComponent(record.token)}`;
      textLines.push(`• Tap to claim directly in WhatsApp:`, waClaimLink, ``);
      textLines.push(`• Or claim on the Web:`, claimUrl, ``);
    } else {
      textLines.push(`Claim your funds here:`, claimUrl, ``);
    }

    textLines.push(`Ask ${senderName} for your 6-digit Claim Code to complete redemption.`);
    const text = textLines.join('\n');

    await fetch(waNotifyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-notify-secret': secret,
        'x-target-service': 'whatsapp-bot',
      },
      body: JSON.stringify({
        to: formattedPhone,
        message: text,
        template: {
          name: 'claim_invite',
          language: 'en',
          params: [senderName, `${Number(record.amount).toFixed(2)} ${record.asset.toUpperCase()}`, claimUrl],
        },
      }),
    });
  } catch (err: any) {
    console.error('Failed to dispatch claim invite to WhatsApp:', err?.message || err);
  }
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
      sourceNetwork: record.sourceNetwork,
      settlementNetwork: record.settlementNetwork || record.network,
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
    sourceNetwork?: SupportedClaimNetwork;
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
    const settlementNetwork: SupportedClaimNetwork = (params.network?.toLowerCase() as SupportedClaimNetwork) || 'near';
    const sourceNetwork: SupportedClaimNetwork = (params.sourceNetwork?.toLowerCase() as SupportedClaimNetwork) || 'solana';

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
      network: settlementNetwork,
      sourceNetwork,
      settlementNetwork,
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

    // Non-blocking WhatsApp invite delivery
    const senderDisplayName = sender.fullName || (sender.username ? `@${sender.username}` : (sender.phone ? `Sivan User (${sender.phone.slice(-4)})` : 'Sivan User'));
    void dispatchClaimInviteWhatsApp(record, senderDisplayName);

    return {
      claim: ClaimService.toSummary(record),
      claimCode,
      replay: false,
    };
  }

  /**
   * Resend invite notification to recipient on WhatsApp.
   */
  static async resendInvite(userId: string, claimId: string): Promise<{ delivered: boolean }> {
    const rawData = await (db as any).read();
    const all: OnchainClaimRecord[] = rawData.onchainClaims || [];
    const claim = all.find((c) => c.id === claimId && c.senderUserId === userId);
    if (!claim) {
      throw new Error('Claim not found or unauthorized');
    }
    if (claim.status !== 'AWAITING_CLAIM') {
      throw new Error(`Cannot resend invite for claim in status ${claim.status}`);
    }

    const sender = await db.findUserById(userId);
    const senderDisplayName = sender?.fullName || (sender?.username ? `@${sender.username}` : 'Sivan User');
    void dispatchClaimInviteWhatsApp(claim, senderDisplayName);
    return { delivered: true };
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
  static async getPublicPreview(token: string): Promise<any> {
    const claim = await ClaimService.findByToken(token);
    if (!claim) {
      throw new Error('Claim not found');
    }

    const rPhone = claim.recipientPhone.replace(/\D/g, '');
    const sPhone = (claim.senderPhone || '').replace(/\D/g, '');
    const isExpired = new Date(claim.expiresAt).getTime() <= Date.now();
    const senderName = sPhone ? `Sivan User (ending ${sPhone.slice(-4)})` : 'Sivan User';

    return {
      token: claim.token,
      claimId: claim.id,
      amount: claim.amount,
      asset: claim.asset,
      network: claim.network,
      sourceNetwork: claim.sourceNetwork,
      settlementNetwork: claim.settlementNetwork || claim.network,
      senderName,
      senderPhoneLast4: sPhone ? sPhone.slice(-4) : undefined,
      recipientPhone: claim.recipientPhone,
      recipientPhoneLast4: rPhone.slice(-4) || '****',
      status: claim.status.toLowerCase(),
      isExpired,
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
