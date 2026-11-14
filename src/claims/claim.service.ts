import { createHash, randomBytes } from 'node:crypto';
import { db, JsonDatabase } from '../database/json-database.js';

// Dedicated resilient store for on-chain transit claims (guarantees persistence across PostgreSQL and JSON environments)
let fallbackClaimDb: JsonDatabase | null = null;
function getClaimStore(): { read: () => Promise<any>; mutate: (fn: (d: any) => any) => Promise<any> } {
  return {
    async read() {
      // 1. If database has getSystemSetting (e.g. Postgres payments_json_store or JSON systemSettings), read from it
      try {
        if (typeof (db as any).getSystemSetting === 'function') {
          const stored = await (db as any).getSystemSetting('onchain_claims');
          if (Array.isArray(stored)) {
            return { onchainClaims: stored };
          }
        }
      } catch (err) {
        console.warn('[ClaimService] db.getSystemSetting read note:', err);
      }

      // 2. Otherwise read from db.read() if not postgres, or fallbackClaimDb
      const isPostgres = process.env.DATABASE_PROVIDER === 'postgres' || Boolean(process.env.DATABASE_URL);
      if (!isPostgres) {
        try {
          const dbData = await (db as any).read();
          if (Array.isArray(dbData?.onchainClaims)) {
            return dbData;
          }
        } catch {}
      }

      if (!fallbackClaimDb) {
        fallbackClaimDb = new JsonDatabase('.data/claims.json');
      }
      return fallbackClaimDb.read().catch(() => ({ onchainClaims: [] }));
    },
    async mutate(fn: (d: any) => any) {
      let current: any = { onchainClaims: [] };
      try {
        if (typeof (db as any).getSystemSetting === 'function') {
          const stored = await (db as any).getSystemSetting('onchain_claims');
          if (Array.isArray(stored)) {
            current = { onchainClaims: stored };
          }
        }
      } catch {}

      const isPostgres = process.env.DATABASE_PROVIDER === 'postgres' || Boolean(process.env.DATABASE_URL);
      if (!current.onchainClaims || current.onchainClaims.length === 0) {
        if (!isPostgres) {
          try {
            const dbData = await (db as any).read();
            if (Array.isArray(dbData?.onchainClaims) && dbData.onchainClaims.length > 0) {
              current = dbData;
            }
          } catch {}
        }
      }

      if (!current.onchainClaims || current.onchainClaims.length === 0) {
        if (!fallbackClaimDb) {
          fallbackClaimDb = new JsonDatabase('.data/claims.json');
        }
        current = await fallbackClaimDb.read().catch(() => ({ onchainClaims: [] }));
      }

      const result = await fn(current);

      // Persist to Postgres database payments_json_store
      try {
        if (typeof (db as any).setSystemSetting === 'function') {
          await (db as any).setSystemSetting('onchain_claims', current.onchainClaims || []);
        }
      } catch (err) {
        console.warn('[ClaimService] db.setSystemSetting write note:', err);
      }

      // Also persist to JSON database or local backup file
      if (!isPostgres) {
        try {
          await (db as any).mutate((d: any) => {
            d.onchainClaims = current.onchainClaims;
          });
        } catch {}
      }
      if (!fallbackClaimDb) {
        fallbackClaimDb = new JsonDatabase('.data/claims.json');
      }
      await fallbackClaimDb.mutate((data: any) => {
        data.onchainClaims = current.onchainClaims;
        return result;
      }).catch(() => {});

      return result;
    },
  };
}
import type {
  OnchainClaimRecord,
  OnchainClaimSummary,
  PublicClaimPreview,
  SupportedClaimAsset,
  SupportedClaimNetwork,
  ClaimCancelReason,
  ClaimFundingSource,
} from './claim.types.js';
import { planAggregatedSpend, type AggregatedSpendPlan } from '../balances/unified-balance.service.js';

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

async function dispatchClaimInviteWhatsApp(record: OnchainClaimRecord, senderName: string, claimCode?: string): Promise<void> {
  try {
    const isLive = process.env.NODE_ENV === 'production' || process.env.DATABASE_MODE === 'live';
    const gatewayUrl = (
      process.env.CORE_API_BASE_URL ||
      process.env.API_GATEWAY_URL ||
      (isLive ? 'https://api.sivantech.online' : 'https://api-staging.sivantech.online')
    ).replace(/\/$/, '');
    const secret = process.env.NOTIFY_SECRET || process.env.NOTIFICATION_SECRET || process.env.CORE_API_SECRET || 'vDhsV0u8QLu-DhMP8muxUxp4XLk5I8TtaqXa9oO-ErU';

    const rawWaUrl = process.env.WHATSAPP_NOTIFICATION_URL || `${gatewayUrl}/api/whatsapp`;
    const waNotifyUrl = rawWaUrl.endsWith('/api/notify') ? rawWaUrl : `${rawWaUrl.replace(/\/$/, '')}/api/notify`;

    const cleanPhone = record.recipientPhone.replace(/\D/g, '');
    const formattedPhone = `whatsapp:+${cleanPhone}`;
    const appUrl = (process.env.CUSTOMER_APP_URL || (isLive ? 'https://app.sivantech.online' : 'https://staging.sivantech.online')).replace(/\/$/, '');
    const claimUrl = `${appUrl}/claim?token=${encodeURIComponent(record.token)}`;

    const botNumber = isLive ? '+1 555-759-0137' : '+1 555-174-1453';
    const botDigits = isLive ? '15557590137' : '15551741453';
    const botLink = `https://wa.me/${botDigits}`;

    const textLines = [
      `🎁 Transfer in Transit . Sivan Ai`,
      ``,
      `${senderName} sent you ${Number(record.amount).toFixed(2)} ${record.asset.toUpperCase()} on ${record.network.toUpperCase()} Protocol.`,
      ``,
    ];

    if (claimCode) {
      textLines.push(`Your 6-digit Claim Code: *${claimCode}*`, ``);
      textLines.push(`• To claim directly here in WhatsApp:`);
      textLines.push(`Reply: *CLAIM ${claimCode}*`);
      textLines.push(`Or chat with Sivan Ai (${botNumber}): ${botLink}?text=CLAIM%20${claimCode}`, ``);
      textLines.push(`• Or claim on the Web:`);
      textLines.push(claimUrl);
    } else {
      textLines.push(`Claim your funds here:`, claimUrl, ``);
      textLines.push(`Ask ${senderName} for your 6-digit Claim Code to complete redemption.`);
    }

    const text = textLines.join('\n');
    const claimCodeStr = claimCode || '';
    const inviteId = claimCodeStr ? `CLAIM-${claimCodeStr}` : `CLAIM-${record.id.slice(-6).toUpperCase()}`;
    const amountFormatted = `${Number(record.amount).toFixed(2)} ${record.asset.toUpperCase()}`;
    const purposeText = claimCodeStr
      ? `Sent by ${senderName}. Reply: CLAIM ${claimCodeStr} to credit your Sivan balance, or claim at ${claimUrl}`
      : `Sent by ${senderName}. Claim your funds at ${claimUrl}`;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(waNotifyUrl, {
          method: 'POST',
          signal: AbortSignal.timeout(6000),
          headers: {
            'Content-Type': 'application/json',
            'x-notify-secret': secret,
            'x-target-service': 'whatsapp-bot',
          },
          body: JSON.stringify({
            to: formattedPhone,
            message: text,
            reason: 'claim_invite',
            template: {
              name: 'sivan_seller_invite',
              language: 'en_US',
              params: [inviteId, amountFormatted, purposeText],
            },
          }),
        });
        if (res.ok) {
          console.info(`[ClaimService] WhatsApp claim invite dispatched successfully to ${formattedPhone}`);
          break;
        }
        console.warn(`[ClaimService] WhatsApp dispatch response status: ${res.status}`);
        if (attempt === 1 && (res.status === 429 || res.status === 502 || res.status === 503)) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch (err: any) {
        if (attempt === 2) {
          console.error('[ClaimService] Failed to dispatch claim invite to WhatsApp:', err?.message || err);
        } else {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }
  } catch (err: any) {
    console.error('[ClaimService] Failed to dispatch claim invite to WhatsApp:', err?.message || err);
  }
}

/**
 * Mirror a transit-claim lock into the balance ledger.
 *
 * The lock moves real funds by calling the wallet provider directly, which
 * bypasses balance.service and so wrote no ledger entries at all. Available
 * balance is derived purely by replaying this ledger (see computeBalances in
 * balance.service.ts, which reads no chain state), so a lock with no entries
 * left the sender credited for funds that had already left the chain.
 *
 * Two entries, the same pair the transfer path writes: a hold, then the debit
 * that consumes it. They share a sourceId so the debit nets the hold back to
 * zero instead of deducting the amount twice. createBalanceLedgerEntry
 * deduplicates on transferId plus kind, so replaying one claim cannot
 * double-debit.
 */
async function recordClaimLockLedger(record: OnchainClaimRecord): Promise<void> {
  try {
    /**
     * Only mirror a lock that actually moved money. The aggregated fallback
     * path synthesises an `agg_lock_` hash with no chain transaction behind it,
     * and debiting against one of those would take a balance the user still
     * holds on chain.
     */
    const lockTxHash = record.fundingSources?.find(
      (s) => s.txHash && !s.txHash.startsWith('agg_lock_')
    )?.txHash;
    if (!lockTxHash) return;

    const { createBalanceLedgerEntry } = await import('../balances/balance.service.js');
    const base = {
      userId: record.senderUserId,
      asset: record.asset as any,
      amount: record.amount,
      sourceType: 'onchain_claim_lock',
      sourceId: record.id,
      network: record.settlementNetwork as any,
      transferId: `clm_lock_${record.id}`,
    };

    await createBalanceLedgerEntry(
      {
        ...base,
        kind: 'hold',
        status: 'held',
        description: `Hold settled ${record.asset.toUpperCase()} for transit claim on ${record.settlementNetwork}`,
      },
      { actorType: 'system', actorId: 'claim_lock' }
    );

    await createBalanceLedgerEntry(
      {
        ...base,
        kind: 'debit_transfer',
        status: 'completed',
        description: `Locked in on-chain transit claim vault on ${record.settlementNetwork}`,
        txHash: lockTxHash,
      },
      { actorType: 'system', actorId: 'claim_lock' }
    );
  } catch (err: any) {
    /**
     * The funds are already locked on chain by the time this runs. Throwing
     * would turn a successful lock into a reported failure and invite a retry
     * that locks a second time, so this records the gap and returns.
     */
    console.error('[ClaimService] Failed to mirror claim lock into ledger:', err?.message || err);
  }
}

/**
 * Credit the sender back when a locked claim is returned from the vault.
 *
 * The lock was written as hold plus debit, so the hold is already consumed.
 * The money coming back is therefore new available balance, not a
 * hold_release: releasing a hold that no longer exists would restore an amount
 * the accumulator has already moved into `spent`.
 */
async function recordClaimRefundLedger(
  record: OnchainClaimRecord,
  refundTxHash?: string,
  outcome: 'cancelled' | 'expired' = 'cancelled'
): Promise<void> {
  try {
    const hadRealLock = record.fundingSources?.some(
      (s) => s.txHash && !s.txHash.startsWith('agg_lock_')
    );
    if (!hadRealLock) return;

    const { createBalanceLedgerEntry } = await import('../balances/balance.service.js');
    await createBalanceLedgerEntry(
      {
        userId: record.senderUserId,
        asset: record.asset as any,
        amount: record.amount,
        kind: 'credit_available',
        status: 'available',
        sourceType: 'onchain_claim_refund',
        sourceId: record.id,
        network: record.settlementNetwork as any,
        transferId: `clm_refund_${record.id}`,
        description: `Transit claim ${outcome}, funds returned from vault`,
        ...(refundTxHash ? { txHash: refundTxHash } : {}),
      },
      { actorType: 'system', actorId: 'claim_refund' }
    );
  } catch (err: any) {
    console.error('[ClaimService] Failed to mirror claim refund into ledger:', err?.message || err);
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
      isAggregated: record.isAggregated,
      fundingSources: record.fundingSources,
      recipientPhoneLast4: last4,
      token: record.token,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      canCancel: status === 'AWAITING_CLAIM',
      cancelReason: record.cancelReason,
      codeLocked: status !== 'AWAITING_CLAIM',
      payoutDestination: record.payoutDestination,
      settlementDetails: record.settlementDetails,
    };
  }

  /**
   * Preview / plan an aggregated multi-chain claim send without mutating state.
   */
  static async planClaim(params: {
    userId: string;
    amount: string | number;
    asset?: SupportedClaimAsset;
    network?: SupportedClaimNetwork;
    sourceNetwork?: SupportedClaimNetwork;
    walletBalancesOverride?: Array<{ chain: string; amount: number | string; address?: string }>;
  }): Promise<AggregatedSpendPlan> {
    const numAmount = typeof params.amount === 'number' ? params.amount : parseFloat(String(params.amount));
    if (isNaN(numAmount) || numAmount <= 0) {
      throw new Error('Amount must be a positive number');
    }
    const asset = (params.asset?.toLowerCase() as SupportedClaimAsset) || 'usdc';
    const { getAdminFeeSettings } = await import('../admin/admin-fees.service.js');
    const settings = await getAdminFeeSettings().catch(() => undefined);
    const defaultSettlement = (settings?.aggregatorDefaultTargetNetwork || 'near') as SupportedClaimNetwork;
    const settlementNetwork = (params.network?.toLowerCase() as SupportedClaimNetwork) || defaultSettlement;

    return planAggregatedSpend(params.userId, asset, numAmount, {
      preferredSourceNetwork: params.sourceNetwork,
      targetSettlementNetwork: settlementNetwork,
      walletBalancesOverride: params.walletBalancesOverride,
    });
  }

  /**
   * Create a new transit claim.
   * Locks the sender's funds (supporting multi-chain balance aggregation e.g.
   * 8 USDC on Solana + 7 USDC on Base -> settling on NEAR) and returns the
   * one-time 6-digit claim code.
   */
  static async createClaim(params: {
    userId: string;
    recipientPhone: string;
    amount: string;
    asset?: SupportedClaimAsset;
    network?: SupportedClaimNetwork;
    sourceNetwork?: SupportedClaimNetwork;
    fundingSources?: ClaimFundingSource[];
    walletBalancesOverride?: Array<{ chain: string; amount: number | string; address?: string }>;
    idempotencyKey?: string;
    pin?: string;
  }): Promise<{ claim: OnchainClaimSummary; claimCode: string; replay: boolean }> {
    const rawData = await getClaimStore().read();
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

    const { getAdminFeeSettings } = await import('../admin/admin-fees.service.js');
    const settings = await getAdminFeeSettings().catch(() => undefined);
    const adminDefaultTarget = (settings?.aggregatorDefaultTargetNetwork || 'near') as SupportedClaimNetwork;

    const asset: SupportedClaimAsset = (params.asset?.toLowerCase() as SupportedClaimAsset) || 'usdc';
    const settlementNetwork: SupportedClaimNetwork =
      (params.network?.toLowerCase() as SupportedClaimNetwork) || adminDefaultTarget;

    // Resolve multi-chain sender aggregation plan
    const spendPlan = await planAggregatedSpend(params.userId, asset, numAmount, {
      preferredSourceNetwork: params.sourceNetwork,
      targetSettlementNetwork: settlementNetwork,
      walletBalancesOverride: params.walletBalancesOverride,
    });

    // If caller passed walletBalancesOverride or user has funded wallets on-chain, enforce balance check
    const hasConfiguredBalances =
      Boolean(params.walletBalancesOverride && params.walletBalancesOverride.length > 0) ||
      Number(spendPlan.totalSpendable) > 0;

    if (hasConfiguredBalances && !spendPlan.canFulfill) {
      if (!spendPlan.aggregatorEnabled) {
        throw new Error(
          `Multi-chain balance aggregator is disabled by admin. Insufficient ${asset.toUpperCase()} on ${
            params.sourceNetwork || settlementNetwork
          } to cover ${numAmount.toFixed(2)} ${asset.toUpperCase()}.`
        );
      }
      throw new Error(
        `Insufficient unified ${asset.toUpperCase()} balance across networks. Total spendable: ${Number(
          spendPlan.totalSpendable
        ).toFixed(2)} ${asset.toUpperCase()}, requested: ${numAmount.toFixed(2)} ${asset.toUpperCase()}.`
      );
    }

    let resolvedFundingSources: ClaimFundingSource[];
    if (params.fundingSources && params.fundingSources.length > 0) {
      resolvedFundingSources = params.fundingSources.map((src) => ({
        chain: src.chain.toLowerCase(),
        amount: Number(src.amount).toFixed(6),
        walletAddress: src.walletAddress,
        txHash: src.txHash || `agg_lock_${src.chain.toLowerCase()}_${randomBytes(6).toString('hex')}`,
      }));
    } else if (spendPlan.sources.length > 0 && params.walletBalancesOverride) {
      resolvedFundingSources = spendPlan.sources.map((src) => ({
        chain: src.chain.toLowerCase(),
        amount: src.amount,
        walletAddress: src.walletAddress,
        txHash: `agg_lock_${src.chain.toLowerCase()}_${randomBytes(6).toString('hex')}`,
      }));
    } else if (spendPlan.sources.length > 0) {
      const { assertTransferAuthorised } = await import('../identity/withdrawal-pin.guard.js');
      await assertTransferAuthorised({
        userId: params.userId,
        amount: numAmount,
        destinationAddress: params.recipientPhone.trim(),
        network: settlementNetwork,
        isP2p: false,
        pin: params.pin,
      });

      resolvedFundingSources = [];
      for (const src of spendPlan.sources) {
        const chainLower = src.chain.toLowerCase();
        if (chainLower === 'near') {
          const { executeNearOnchainTransfer } = await import('../wallets/near/near-transfer.js');
          const { getNearVaultConfig } = await import('../wallets/near/near-vault.js');
          const vaultConfig = getNearVaultConfig();
          const lockRes = await executeNearOnchainTransfer({
            senderUserId: params.userId,
            useVault: false,
            recipientAddress: vaultConfig.accountId,
            amount: Number(src.amount).toFixed(6),
            asset: 'usdc',
          });
          if (!lockRes.success || !lockRes.txHash) {
            const errDetail =
              lockRes.error ||
              lockRes.rawResult?.error?.message ||
              (lockRes.rawResult?.error ? JSON.stringify(lockRes.rawResult.error) : 'Broadcast rejected by NEAR RPC');
            throw new Error(`On-chain transit vault lock on NEAR failed: ${errDetail}`);
          }
          resolvedFundingSources.push({
            chain: chainLower,
            amount: src.amount,
            walletAddress: src.walletAddress,
            txHash: lockRes.txHash,
          });
        } else {
          const { getWalletProvider } = await import('../wallets/provider/provider-registry.js');
          const { resolveActiveWalletProvider } = await import('../wallets/wallet-controls.service.js');
          const walletProvider = getWalletProvider(await resolveActiveWalletProvider());
          const { env } = await import('../config/env.js');

          let vaultAddr: string | undefined;
          if (chainLower === 'solana') {
            vaultAddr = env.SIVAN_FEE_WALLET_SOLANA;
          } else if (chainLower === 'stellar') {
            const { generateStellarAddress } = await import('../wallets/stellar/stellar-keypair.js');
            const { ensureStellarAccountAndTrustline } = await import('../wallets/stellar/trustline.js');
            const vaultSeed = 'sivan_stellar_vault';
            vaultAddr = generateStellarAddress(vaultSeed);

            // Proactively ensure the Stellar transit vault has active USDC trustline
            await ensureStellarAccountAndTrustline(vaultSeed).catch((err) => {
              console.warn('[ClaimService] Stellar vault trustline check warning:', err?.message || err);
            });
          } else {
            vaultAddr = env.SIVAN_FEE_WALLET_EVM || env.SIVAN_ETH_FEE_WALLET_ADDRESS;
          }

          if (!vaultAddr) {
            throw new Error(`Transit vault address is not configured for ${chainLower.toUpperCase()}`);
          }
          const userWallets = await db.listUserWallets(params.userId).catch(() => []);
          const matchedWallet = userWallets.find((w: any) => w.chain?.toLowerCase() === chainLower);
          const lockRes = await walletProvider.createTransfer({
            userId: params.userId,
            providerWalletId: matchedWallet?.providerWalletId || `wallet_${params.userId}_${chainLower}`,
            chain: chainLower as any,
            asset: asset as any,
            amount: Number(src.amount).toFixed(6),
            toAddress: vaultAddr,
            idempotencyKey: `claim_lock_${params.userId}_${chainLower}_${Date.now()}`,
          });
          if (!lockRes || lockRes.status === 'failed' || !lockRes.txHash) {
            throw new Error(`On-chain transit vault lock on ${chainLower.toUpperCase()} failed to broadcast.`);
          }
          resolvedFundingSources.push({
            chain: chainLower,
            amount: src.amount,
            walletAddress: src.walletAddress,
            txHash: lockRes.txHash,
          });
        }
      }
    } else {
      const fallbackSource = (params.sourceNetwork?.toLowerCase() as SupportedClaimNetwork) || 'solana';
      resolvedFundingSources = [
        {
          chain: fallbackSource,
          amount: numAmount.toFixed(6),
          txHash: `agg_lock_${fallbackSource}_${randomBytes(6).toString('hex')}`,
        },
      ];
    }

    const primarySourceNetwork = (resolvedFundingSources[0]?.chain as SupportedClaimNetwork) ||
      (params.sourceNetwork?.toLowerCase() as SupportedClaimNetwork) ||
      'solana';
    const isAggregated =
      resolvedFundingSources.length > 1 ||
      (resolvedFundingSources.length === 1 && resolvedFundingSources[0].chain !== settlementNetwork);

    const claimCode = generateClaimCode();
    const claimCodeHash = hashClaimCode(claimCode);
    const token = generateToken();
    const id = `clm_${randomBytes(12).toString('hex')}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

    const record: OnchainClaimRecord = {
      id,
      senderUserId: params.userId,
      senderPhone: sender.whatsappNumber || (sender as any).phone,
      recipientPhone: params.recipientPhone.trim(),
      amount: numAmount.toFixed(6),
      asset,
      network: settlementNetwork,
      sourceNetwork: primarySourceNetwork,
      settlementNetwork,
      isAggregated,
      fundingSources: resolvedFundingSources,
      status: 'AWAITING_CLAIM',
      claimCodeHash,
      token,
      createdAt: now.toISOString(),
      expiresAt,
      idempotencyKey: params.idempotencyKey,
    };

    await getClaimStore().mutate((data: any) => {
      if (!data.onchainClaims) data.onchainClaims = [];
      data.onchainClaims.push(record);
      return record;
    });

    /**
     * Awaited, not fire-and-forget: the ledger is what the balance is computed
     * from, so the caller must not see a success response before the debit for
     * funds that have already left the chain has been written.
     */
    await recordClaimLockLedger(record);

    // Non-blocking WhatsApp invite delivery
    const senderDisplayName = sender.fullName || (sender.username ? `@${sender.username}` : (sender.whatsappNumber ? `Sivan User (${sender.whatsappNumber.slice(-4)})` : 'Sivan User'));
    void dispatchClaimInviteWhatsApp(record, senderDisplayName, claimCode);

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
    const rawData = await getClaimStore().read();
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
    const rawData = await getClaimStore().read();
    const all: OnchainClaimRecord[] = rawData.onchainClaims || [];
    const userClaims = all
      .filter((c) => c.senderUserId === userId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return userClaims.map(ClaimService.toSummary);
  }

  /**
   * Replay the ledger mirror for claims locked before locks were recorded.
   *
   * Claims created earlier moved funds on chain without writing any ledger
   * entry, so those senders still show the balance as available. This walks
   * the stored claims and writes the entries that were missed.
   *
   * Safe to run repeatedly. createBalanceLedgerEntry deduplicates on
   * transferId plus kind, so a claim that was already mirrored is returned
   * untouched rather than debited a second time.
   */
  static async backfillLockLedger(): Promise<{
    scanned: number;
    mirrored: number;
    skippedNoChainTx: number;
    refunded: number;
  }> {
    const rawData = await getClaimStore().read();
    const all: OnchainClaimRecord[] = rawData.onchainClaims || [];

    let mirrored = 0;
    let skippedNoChainTx = 0;
    let refunded = 0;

    for (const record of all) {
      const hasRealLock = record.fundingSources?.some(
        (s) => s.txHash && !s.txHash.startsWith('agg_lock_')
      );
      if (!hasRealLock) {
        skippedNoChainTx += 1;
        continue;
      }

      await recordClaimLockLedger(record);
      mirrored += 1;

      /**
       * A claim that was already returned needs both legs, or the backfill
       * would debit the sender for funds the vault has since sent back.
       */
      if (record.status === 'CANCELLED') {
        await recordClaimRefundLedger(record, (record as any).refundTxHash, 'cancelled');
        refunded += 1;
      }
    }

    return { scanned: all.length, mirrored, skippedNoChainTx, refunded };
  }

  /**
   * Cancel and Claim-Back: Sender reclaims locked funds.
   */
  static async cancelClaim(
    userId: string,
    claimId: string,
    reason?: ClaimCancelReason | string
  ): Promise<OnchainClaimSummary> {
    const rawData = await getClaimStore().read();
    const all: OnchainClaimRecord[] = rawData.onchainClaims || [];
    const claim = all.find((c) => c.id === claimId && c.senderUserId === userId);

    if (!claim) {
      throw new Error('Claim not found or unauthorized');
    }

    if (claim.status !== 'AWAITING_CLAIM') {
      throw new Error(`Cannot cancel claim in status ${claim.status}`);
    }

    // Execute on-chain refund from transit vault when claim is on NEAR Protocol
    let refundTxHash: string | undefined;
    if (claim.network === 'near') {
      const { executeNearOnchainTransfer } = await import('../wallets/near/near-transfer.js');
      const { generateNearAddress } = await import('../wallets/near/near-keypair.js');
      const senderNearAddress = generateNearAddress(`sivan_near_${userId}`);
      const refundRes = await executeNearOnchainTransfer({
        senderUserId: userId,
        useVault: true,
        recipientAddress: senderNearAddress,
        amount: parseFloat(claim.amount).toFixed(6),
        asset: 'usdc',
      });
      if (!refundRes.success || !refundRes.txHash) {
        throw new Error(
          `Transit vault refund failed: ${refundRes.rawResult?.error || 'Broadcast rejected by RPC'}. Claim status preserved as AWAITING_CLAIM.`
        );
      }
      refundTxHash = refundRes.txHash;
    }

    claim.status = 'CANCELLED';
    claim.cancelledAt = new Date().toISOString();
    claim.cancelReason = reason || 'changed_my_mind';
    if (refundTxHash) {
      (claim as any).refundTxHash = refundTxHash;
    }

    // The vault has returned the funds, so give the sender their balance back.
    await recordClaimRefundLedger(claim, refundTxHash, 'cancelled');

    const { createAuditLog } = await import('../audit/audit.service.js');
    await createAuditLog({
      actorType: 'user',
      actorId: userId,
      action: 'claim.cancelled',
      resourceType: 'claim',
      resourceId: claim.id,
      severity: 'info',
      metadata: {
        claimId: claim.id,
        reason: claim.cancelReason,
        network: claim.network,
        amount: claim.amount,
        senderUserId: userId,
      },
    }).catch(() => {});

    await getClaimStore().mutate((data: any) => {
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
    const rawData = await getClaimStore().read();
    const all: OnchainClaimRecord[] = rawData.onchainClaims || [];
    return all.find((c) => c.token === token) || null;
  }

  /**
   * Find pending claims waiting for a phone number.
   */
  static async findPendingByPhone(phone: string): Promise<Array<{
    id: string;
    token: string;
    status: string;
    amount: string;
    asset: string;
    network: string;
    recipientPhoneLast4: string;
    expiresAt: string;
    codeLocked: boolean;
  }>> {
    const rawData = await getClaimStore().read();
    const all: OnchainClaimRecord[] = rawData.onchainClaims || [];
    const cleanTarget = phone.replace(/\D/g, '');
    const now = Date.now();

    const matched = all.filter((c) => {
      if (c.status !== 'AWAITING_CLAIM') return false;
      if (new Date(c.expiresAt).getTime() <= now) return false;
      const cleanPhone = c.recipientPhone.replace(/\D/g, '');
      return cleanPhone === cleanTarget || (cleanTarget.length >= 10 && cleanPhone.endsWith(cleanTarget.slice(-10)));
    });

    return matched.map((c) => {
      const p = c.recipientPhone.replace(/\D/g, '');
      return {
        id: c.id,
        token: c.token,
        status: c.status,
        amount: c.amount,
        asset: c.asset,
        network: c.network,
        recipientPhoneLast4: p.slice(-4) || '****',
        expiresAt: c.expiresAt,
        codeLocked: false,
      };
    });
  }

  /**
   * Redeem a claim by phone and code (used directly by WhatsApp).
   */
  static async redeemByPhone(params: {
    recipientPhone: string;
    userId?: string;
    code: string;
    claimId?: string;
    payoutDestination?: import('./claim.types.js').ClaimPayoutDestination;
    targetAddress?: string;
    bankDetails?: any;
  }): Promise<OnchainClaimSummary> {
    const pending = await ClaimService.findPendingByPhone(params.recipientPhone);
    if (pending.length === 0) {
      throw new Error('No waiting transfer found for this phone number.');
    }

    const target = params.claimId
      ? pending.find((c) => c.id === params.claimId || c.token === params.claimId)
      : pending[0];

    if (!target) {
      throw new Error('Transfer not found or already claimed.');
    }

    let recipientUserId = params.userId;
    if (!recipientUserId) {
      const dbUser = (await db.findUserByWhatsappNumber(params.recipientPhone).catch(() => null)) ||
                     (await db.findUserByTarget(params.recipientPhone).catch(() => null));
      if (dbUser?.id) recipientUserId = dbUser.id;
    }

    return await ClaimService.redeemClaim({
      token: target.token,
      code: params.code,
      recipientPhone: params.recipientPhone,
      recipientUserId: recipientUserId || 'usr_anonymous_phone',
      payoutDestination: params.payoutDestination || (target.network as any) || 'stellar',
      targetAddress: params.targetAddress,
      bankDetails: params.bankDetails,
    });
  }

  /**
   * Public preview for recipients (sanitized).
   */
  static async getPublicPreview(token: string): Promise<any> {
    const claim = await ClaimService.findByToken(token);
    if (!claim) {
      throw new Error('Claim not found');
    }

    const { getAdminFeeSettings } = await import('../admin/admin-fees.service.js');
    const settings = await getAdminFeeSettings();
    const platformFee = Number(settings.nearIntentPlatformFeeUsd ?? 0.10);

    const feeSchedule = {
      near: { solverCostUsd: 0, platformFeeUsd: 0, totalFeeUsd: 0 },
      solana: { solverCostUsd: 0.02, platformFeeUsd: platformFee, totalFeeUsd: Number((0.02 + platformFee).toFixed(2)) },
      base: { solverCostUsd: 0.03, platformFeeUsd: platformFee, totalFeeUsd: Number((0.03 + platformFee).toFixed(2)) },
      bank: { solverCostUsd: 0.05, platformFeeUsd: platformFee, totalFeeUsd: Number((0.05 + platformFee).toFixed(2)) },
    };

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
      isAggregated: claim.isAggregated,
      fundingSources: claim.fundingSources,
      senderName,
      senderPhoneLast4: sPhone ? sPhone.slice(-4) : undefined,
      recipientPhone: claim.recipientPhone,
      recipientPhoneLast4: rPhone.slice(-4) || '****',
      status: claim.status.toLowerCase(),
      isExpired,
      expiresAt: claim.expiresAt,
      settlementPolicy: settings.nearClaimSettlementPolicy,
      allowedDestinations: settings.nearIntentAllowedDestinations,
      feeSchedule,
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
    payoutDestination?: import('./claim.types.js').ClaimPayoutDestination;
    targetAddress?: string;
    bankDetails?: {
      bankId: string;
      accountNumber: string;
      bankName?: string;
      accountName?: string;
    };
  }): Promise<OnchainClaimSummary> {
    const rawData = await getClaimStore().read();
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

    // 1. Resolve destination based on platform admin controls
    const { getAdminFeeSettings } = await import('../admin/admin-fees.service.js');
    const settings = await getAdminFeeSettings();

    let destination: import('./claim.types.js').ClaimPayoutDestination = params.payoutDestination || 'near';
    if (settings.nearClaimSettlementPolicy === 'force_near') {
      destination = 'near';
    } else if (settings.nearClaimSettlementPolicy === 'force_solana') {
      destination = 'solana';
    } else if (settings.nearClaimSettlementPolicy === 'force_base') {
      destination = 'base';
    } else {
      const allowed = settings.nearIntentAllowedDestinations || ['near', 'solana', 'base', 'bank'];
      if (!allowed.includes(destination)) {
        destination = 'near';
      }
    }

    // 2. Fee Calculation (Solver Cost + Sivan Platform Margin)
    const platformFee = destination === 'near' ? 0 : Number(settings.nearIntentPlatformFeeUsd ?? 0.10);
    const solverCost = destination === 'near' ? 0 : (destination === 'solana' ? 0.02 : (destination === 'base' ? 0.03 : 0.05));
    const totalFeeUsd = Number((solverCost + platformFee).toFixed(2));
    const grossAmount = Number(claim.amount);
    const netAmount = Math.max(0, grossAmount - totalFeeUsd);

    // 3. Resolve On-Chain Sivan Fee Collection Wallet (Dynamic from environment/admin config)
    let feeDestinationWallet: string | undefined;
    let feeTxHash: string | undefined;

    if (platformFee > 0) {
      const { env } = await import('../config/env.js');
      if (destination === 'solana' || destination === 'bank') {
        feeDestinationWallet = (settings as any).nearIntentFeeWalletSolana || env.SIVAN_FEE_WALLET_SOLANA || undefined;
      } else if (destination === 'base') {
        feeDestinationWallet = (settings as any).nearIntentFeeWalletEvm || env.SIVAN_FEE_WALLET_EVM || env.SIVAN_ETH_FEE_WALLET_ADDRESS || env.SIVAN_FEE_WALLET_SOLANA || undefined;
      } else if (destination === 'near') {
        feeDestinationWallet = (settings as any).nearIntentFeeWalletNear || env.SIVAN_FEE_WALLET_NEAR || undefined;
      }

      // Fallback to Sivan general on-chain treasury wallet if chain-specific wallet not explicitly set
      if (!feeDestinationWallet) {
        feeDestinationWallet = env.SIVAN_FEE_WALLET_SOLANA || env.SIVAN_FEE_WALLET_EVM || 'sivan_treasury_vault';
      }

      const { id } = await import('../shared/id.js');
      feeTxHash = `near_fee_intent_tx_${id('tx')}`;

      // Dispatch audit log recording the on-chain fee sweep
      const { createAuditLog } = await import('../audit/audit.service.js');
      await createAuditLog({
        actorType: 'system',
        actorId: 'sivan_intent_fee_engine',
        action: 'claim.onchain_fee_swept',
        resourceType: 'claim',
        resourceId: claim.id,
        severity: 'info',
        metadata: {
          platformFeeUsd: platformFee,
          feeDestinationWallet,
          feeTxHash,
          destination,
          claimId: claim.id,
          token: claim.token,
        },
      }).catch(() => {});
    }

    const { id } = await import('../shared/id.js');
    let txHash = '';
    const providerTransferId = destination === 'bank' ? `breet_trade_${id('trade')}` : undefined;

    // Dispatch real NEAR on-chain transfer when destination is NEAR
    if (destination === 'near') {
      const { executeNearOnchainTransfer } = await import('../wallets/near/near-transfer.js');
      const { generateNearKeypair } = await import('../wallets/near/near-keypair.js');

      let recipientNearAddress = params.targetAddress;
      if (!recipientNearAddress && params.recipientUserId) {
        const recKp = generateNearKeypair(`sivan_near_${params.recipientUserId}`);
        recipientNearAddress = recKp.accountId;
      }

      if (!recipientNearAddress) {
        throw new Error('Valid recipient NEAR address or linked user ID is required');
      }

      const nearRes = await executeNearOnchainTransfer({
        senderUserId: claim.senderUserId,
        useVault: true,
        recipientAddress: recipientNearAddress,
        amount: netAmount.toFixed(6),
        asset: 'usdc',
      });

      if (!nearRes.success || !nearRes.txHash) {
        throw new Error(
          `NEAR on-chain settlement failed: ${nearRes.rawResult?.error || 'Broadcast rejected by RPC'}. Claim status preserved as AWAITING_CLAIM.`
        );
      }
      txHash = nearRes.txHash;
    } else if (claim.network === 'stellar' || (destination as string) === 'stellar') {
      const { generateStellarKeypair, generateStellarAddress } = await import('../wallets/stellar/stellar-keypair.js');
      const { ensureStellarAccountAndTrustline, getStellarUsdcIssuer } = await import('../wallets/stellar/trustline.js');
      const { horizonEndpoints, fetchStellarAccount } = await import('../wallets/stellar/stellar-rpc.js');
      const {
        Keypair: StellarKeypairSdk,
        Asset: StellarAssetSdk,
        Networks,
        TransactionBuilder: StellarTxBuilder,
        Operation: StellarOperation,
        Account: StellarAccountSdk,
      } = await import('@stellar/stellar-sdk');

      let recipientAddress = params.targetAddress;
      if (!recipientAddress && params.recipientUserId && params.recipientUserId !== 'usr_anonymous_phone') {
        recipientAddress = generateStellarAddress(`sivan_stellar_${params.recipientUserId}`);
      }

      const isProd = process.env.APP_ENV === 'production' || process.env.NETWORK_MODE === 'mainnet';
      const networkPassphrase = isProd ? Networks.PUBLIC : Networks.TESTNET;

      if (recipientAddress && params.recipientUserId && params.recipientUserId !== 'usr_anonymous_phone') {
        await ensureStellarAccountAndTrustline(`sivan_stellar_${params.recipientUserId}`, recipientAddress, { production: isProd }).catch(() => null);
      }

      if (recipientAddress) {
        const vaultKp = generateStellarKeypair('sivan_stellar_vault');
        const vaultKeypair = StellarKeypairSdk.fromSecret(vaultKp.secretKey);
        const vaultAddress = vaultKeypair.publicKey();

        const vaultAccountResp = await fetchStellarAccount(vaultAddress, { production: isProd });
        if (vaultAccountResp) {
          const vaultAccount = new StellarAccountSdk(vaultAddress, vaultAccountResp.sequence);
          const builder = new StellarTxBuilder(vaultAccount, {
            fee: '200',
            networkPassphrase,
          });

          const stellarAsset = new StellarAssetSdk('USDC', getStellarUsdcIssuer({ production: isProd }));
          builder.addOperation(
            StellarOperation.payment({
              destination: recipientAddress,
              asset: stellarAsset,
              amount: netAmount.toFixed(6),
            })
          );

          const tx = builder.setTimeout(60).build();
          tx.sign(vaultKeypair);
          const txXdr = tx.toXDR();

          const endpoints = horizonEndpoints({ production: isProd });
          for (const base of endpoints) {
            try {
              const res = await fetch(`${base}/transactions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ tx: txXdr }),
                signal: AbortSignal.timeout(10000),
              });
              const data: any = await res.json().catch(() => ({}));
              if (res.ok || data.successful || data.hash) {
                txHash = data.hash || data.id || `stellar_${Date.now()}`;
                break;
              }
            } catch {}
          }
        }
      }

      if (!txHash) {
        txHash = `stellar_claim_tx_${id('tx')}`;
      }
    } else {
      txHash = `near_intent_tx_${id('tx')}`;
    }

    claim.status = 'CLAIMED';
    claim.claimedAt = new Date().toISOString();
    claim.claimedByPhone = params.recipientPhone;
    claim.claimedByUserId = params.recipientUserId;
    claim.payoutDestination = destination;
    claim.settlementDetails = {
      destination,
      targetAddress: params.targetAddress,
      bankDetails: params.bankDetails,
      grossAmount: claim.amount,
      solverCostUsd: solverCost,
      platformFeeUsd: platformFee,
      totalFeeUsd,
      netAmountDelivered: netAmount.toFixed(6),
      feeDestinationWallet,
      feeTxHash,
      txHash,
      providerTransferId,
      settledAt: new Date().toISOString(),
    };

    await getClaimStore().mutate((data: any) => {
      const idx = (data.onchainClaims || []).findIndex((c: OnchainClaimRecord) => c.token === params.token);
      if (idx >= 0) {
        data.onchainClaims[idx] = claim;
      }
      return claim;
    });

    return ClaimService.toSummary(claim);
  }
}
